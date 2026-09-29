/**
 * One game on the TypeScript engine: invented from a stream [C10-6], or
 * replayed from a game input [C10-24], [C10-37]. Either way the result is the
 * game input and the TypeScript engine's ply records for it [C10-8].
 */

import type { AzulState, CanonicalState, Color, RoundScoring } from 'engine';
import type { Engine } from './engine.js';
import { POLICIES, POLICY_NAMES } from './policies.js';
import {
  DESCRIBED,
  REJECTED,
  SEAM_MISUSED,
  pushRecord,
  pushRejectedStart,
  splitRecords,
  toWords,
} from './record.js';
import { Stream } from './rng.js';

/** Everything that determines a game (spec 0010, *Definitions*). */
export interface GameInput {
  /** `null` for a new game; otherwise the canonical state both engines load. */
  start: CanonicalState | null;
  /** The bag after each shuffle, in storage order ([0002 V2-6]). */
  shuffles: number[][];
  /** `actions[k - 1]` leads to record `k`. */
  actions: number[];
  /** One per record. */
  probes: number[];
}

/** A failure of the tool, never of an engine [C10-21]. */
export class ToolError extends Error {}

export type Start =
  | { kind: 'new' }
  | { kind: 'short'; max: number }
  | { kind: 'vector'; name: string; state: CanonicalState };

export interface GameOptions {
  steer: string;
  start: Start;
  cap: number;
}

/** What one game reached, for [C10-19]. */
export interface GameStats {
  plies: number;
  endedByRow: boolean;
  endedByExhaustion: boolean;
  capped: boolean;
  maxRound: number;
  recycles: number;
  shortDeals: number;
  /** Floors charged at seven slots or more, per player per round. */
  floorsSeven: number;
  /** Floors charged past seven: the marker's eighth slot [0001 E1-27]. */
  floorsPastSeven: number;
}

export interface Played {
  input: GameInput;
  /** One word array per record, record `0` first. */
  records: Uint32Array[];
  policy: string;
  stats: GameStats;
}

const FULL_ROUND = 20;

function census(tiles: readonly number[]): string {
  const n = [0, 0, 0, 0, 0];
  for (const t of tiles) n[t] = (n[t] ?? 0) + 1;
  return n.join(',');
}

/**
 * Plays a game to its end, its cap, or the first record that stops it, and
 * returns the records. `choose` picks the next action, or `null` to stop; the
 * seam is the engine's shuffle, reporting misuse by returning `false`.
 */
function play(
  engine: Engine,
  start: CanonicalState | null,
  seam: (bag: Color[], index: number) => boolean,
  choose: (s: AzulState, legal: readonly number[]) => number | null,
  probeFor: (legal: readonly number[]) => number,
  onPly: (s: AzulState, scoring: RoundScoring | null) => void,
): number[] {
  const out: number[] = [];
  let misused = false;
  const shuffle = (bag: Color[], index: number): void => {
    if (!seam(bag, index)) misused = true;
  };
  let s: AzulState;
  try {
    s = start === null ? engine.newGame(0, shuffle) : engine.fromCanonical(start, 0, shuffle);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    pushRejectedStart(out);
    return out;
  }
  pushRecord(out, engine, s, misused ? SEAM_MISUSED : DESCRIBED, probeFor(engine.legalActions(s)), null);
  if (misused) return out;
  onPly(s, null);
  for (;;) {
    const legal = engine.legalActions(s);
    const action = choose(s, legal);
    if (action === null) return out;
    let scoring: RoundScoring | null = null;
    let status = DESCRIBED;
    try {
      scoring = engine.applyExplained(s, action);
      if (misused) status = SEAM_MISUSED;
    } catch (e) {
      if (e instanceof ToolError) throw e;
      status = REJECTED;
    }
    pushRecord(out, engine, s, status, probeFor(engine.legalActions(s)), scoring);
    if (status !== DESCRIBED) return out;
    onPly(s, scoring);
  }
}

/** A probe: uniform over `0..=255` minus the position's legal actions [C10-10]. */
function drawProbe(rng: Stream, legal: readonly number[]): number {
  const taken = new Set(legal);
  for (;;) {
    const p = rng.below(256);
    if (!taken.has(p)) return p;
  }
}

/**
 * The driver's shuffle seam [C10-7]: a new index is shuffled fresh from the
 * game's stream and recorded; an old one is written back; one past the end is
 * the engine skipping an index, which the tool cannot supply and does not
 * paper over.
 */
export function inventingSeam(rng: Stream, shuffles: number[][]): (bag: Color[], index: number) => boolean {
  return (bag, index) => {
    if (index === shuffles.length) {
      rng.shuffle(bag);
      shuffles.push(bag.slice());
    } else if (index < shuffles.length) {
      bag.splice(0, bag.length, ...(shuffles[index] as Color[]));
    } else {
      throw new ToolError(`the shuffle seam was called with index ${index} after ${shuffles.length} shuffles`);
    }
    return true;
  };
}

/** Game `game` of the run seeded `seed` [C10-6]. */
export function invent(engine: Engine, seed: number, game: number, options: GameOptions): Played {
  const rng = new Stream(seed, game);
  const policyName = options.steer === 'mix' ? rng.pick(POLICY_NAMES) : options.steer;
  const policy = POLICIES[policyName];
  if (policy === undefined) throw new ToolError(`no policy named ${policyName}`);

  const shuffles: number[][] = [];
  const seam = inventingSeam(rng, shuffles);

  let start: CanonicalState | null = null;
  if (options.start.kind === 'short') {
    const k = 1 + rng.below(options.start.max);
    const c = engine.toCanonical(engine.newGame(0, (bag, index) => void seam(bag, index)));
    c.bag = c.bag.slice(0, c.bag.length - k);
    start = c;
  } else if (options.start.kind === 'vector') {
    start = structuredClone(options.start.state);
  }

  const actions: number[] = [];
  const probes: number[] = [];
  const stats: GameStats = {
    plies: 0,
    endedByRow: false,
    endedByExhaustion: false,
    capped: false,
    maxRound: 0,
    recycles: 0,
    shortDeals: 0,
    floorsSeven: 0,
    floorsPastSeven: 0,
  };
  let lastRound = -1;
  let lastShuffles = -1;
  const words = play(
    engine,
    start,
    seam,
    (s, legal) => {
      if (legal.length === 0) return null;
      if (actions.length >= options.cap) {
        stats.capped = true;
        return null;
      }
      const a = policy(engine, s, legal, rng);
      actions.push(a);
      return a;
    },
    (legal) => {
      const p = drawProbe(rng, legal);
      probes.push(p);
      return p;
    },
    (s, scoring) => {
      stats.plies = actions.length;
      stats.maxRound = Math.max(stats.maxRound, s.roundIndex);
      if (lastShuffles >= 0) stats.recycles += s.shufflesUsed - lastShuffles;
      lastShuffles = s.shufflesUsed;
      if (lastRound >= 0 && s.roundIndex !== lastRound && !s.isTerminal && s.tilesLeft < FULL_ROUND) {
        stats.shortDeals++;
      }
      lastRound = s.roundIndex;
      // Counted as charged, from the round's record: a round's last take
      // resolves the round in the same ply, so the position after it has
      // already cleared the floor that take filled.
      for (const p of scoring?.players ?? []) {
        if (p.floor.occupied >= 7) stats.floorsSeven++;
        if (p.floor.occupied > 7) stats.floorsPastSeven++;
      }
      if (s.isTerminal) {
        if (s.exhausted) stats.endedByExhaustion = true;
        else stats.endedByRow = true;
      }
    },
  );
  const records = splitRecords(toWords(words), probes.length);
  return { input: { start, shuffles, actions, probes }, records, policy: policyName, stats };
}

/**
 * Replays a game input on the TypeScript engine, as the checker replays it on
 * the crate: a shuffle the input does not hold, or one that is not a
 * permutation of the bag, is status `3` and ends the game [C10-13].
 */
export function replay(engine: Engine, input: GameInput): Uint32Array[] {
  const seam = (bag: Color[], index: number): boolean => {
    const order = input.shuffles[index];
    if (order === undefined || order.length !== bag.length || census(order) !== census(bag)) return false;
    bag.splice(0, bag.length, ...(order as Color[]));
    return true;
  };
  let next = 0;
  let probe = 0;
  const words = play(
    engine,
    input.start === null ? null : structuredClone(input.start),
    seam,
    () => (next < input.actions.length ? input.actions[next++] : null),
    () => input.probes[probe++] ?? 0,
    () => {},
  );
  return splitRecords(toWords(words), probe);
}
