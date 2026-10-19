/**
 * One game, refereed by our engine, mirrored move for move in the host's
 * lockstep game, and compared at every ply ([G13-12] to [G13-20], [G13-32]).
 *
 * Our engine deals, decides what is legal, applies every move and scores the
 * game. The host's lockstep game is dealt the tiles our engine dealt and
 * stepped by the moves played; their search plays on it. Before each move
 * the host imports our position and compares it with the lockstep game, and
 * after each move the totals and the round's and game's ends are compared.
 */

import { apply, isLegal, newGame, outcome, toJSON, type AzulState } from 'engine';
import { dealTiles, importArgs, type ImportArgs } from './convert.js';
import type { Host } from './processes.js';

const FULL_BAG = [20, 20, 20, 20, 20];

/** A failed comparison: the game ends here, and is reported ([G13-19]). */
export class Disagreement extends Error {
  constructor(
    readonly comparison: string,
    readonly ply: number,
    readonly details: Record<string, unknown>,
  ) {
    super(`ply ${ply}: ${comparison}`);
  }
}

/** One move: who chose it, what, and what they reported. */
export interface Move {
  side: 'ours' | 'theirs' | 'other';
  action: number;
  simulations?: number;
  ms?: number;
  proofMs?: number;
  value?: number;
  chunks?: number;
  overrun?: number;
  chunkActions?: number[];
  tally?: Record<string, number>;
  reused?: number;
}

/** Chooses for a seat; `theirs` is the host's search, called by `playGame` itself. */
export type Mover = (position: ReturnType<typeof toJSON>, ply: number) => Promise<Move>;

export interface GameSpec {
  host: Host;
  /** The host's cell for this game ([G13-31]); its settings were sent by `configure`. */
  cell: number;
  matchSeed: number;
  seed: number;
  /** Our seat, 0 or 1; the other seat is theirs, or `other` plays it. */
  ourSeat: number;
  /** Plays our seat. */
  ours: Mover;
  /** Plays their seat: `null` for their search through the host. */
  theirs: Mover | null;
  timeoutMs: number;
  /** Moves already decided, replayed in place of asking anyone ([G13-43]). */
  replay?: readonly number[];
}

export interface GameRecord {
  seed: number;
  ourSeat: number;
  scores: number[];
  /** 0 or 1 for the winning seat, -1 for a draw; ties are broken by complete rows. */
  winner: number;
  plies: number;
  moves: Move[];
}

export interface DisagreementRecord {
  seed: number;
  ourSeat: number;
  ply: number;
  comparison: string;
  moves: number[];
  position: ReturnType<typeof toJSON>;
  imported: ImportArgs;
  details: Record<string, unknown>;
}

/** Counts `verify` reports ([G13-44]). */
export interface Census {
  plies: number;
  roundEnds: number;
  refillsInsideAFactory: number;
  floorOverflows: number;
}

export function emptyCensus(): Census {
  return { plies: 0, roundEnds: 0, refillsInsideAFactory: 0, floorOverflows: 0 };
}

const winnerOf = (s: AzulState): number => {
  const o = outcome(s);
  return o === 1 ? 0 : o === -1 ? 1 : -1;
};

type Answer = { disagreement?: string; details?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Plays one game. Returns its record, or throws a `Disagreement` carrying
 * what [G13-19]'s report needs.
 */
export async function playGame(spec: GameSpec, census: Census = emptyCensus()): Promise<GameRecord> {
  const { host, timeoutMs } = spec;
  const s = newGame(spec.seed);
  const played: number[] = [];
  const moves: Move[] = [];
  let ply = 0;
  let last: { position: ReturnType<typeof toJSON>; imported: ImportArgs } | null = null;
  const fail = (comparison: string, details: Record<string, unknown> = {}): never => {
    throw Object.assign(new Disagreement(comparison, ply, details), { moves: played.slice(), last });
  };
  const ask = async (req: Record<string, unknown>, what: string): Promise<Answer> => {
    const a = await host.ask<Answer>(req, timeoutMs, what);
    if (a.disagreement !== undefined) fail(a.disagreement, a.details ?? {});
    return a;
  };
  const where = (what: string): string => `seed ${spec.seed}, our seat ${spec.ourSeat}, ply ${ply}: ${what}`;

  await ask({ type: 'game', cell: spec.cell, matchSeed: spec.matchSeed, seed: spec.seed, seat: spec.ourSeat }, where('game'));
  await ask({ type: 'deal', tiles: dealTiles(FULL_BAG, s.factories) }, where('first deal'));

  while (!s.isTerminal) {
    const position = toJSON(s);
    const imported = importArgs(position);
    last = { position, imported };
    await ask({ type: 'ply', ply, imported, legal: position.legalActions, scores: position.scores }, where('ply'));

    let move: Move;
    const replayed = spec.replay?.[ply];
    if (replayed !== undefined) {
      move = { side: s.currentPlayer === spec.ourSeat ? 'ours' : 'theirs', action: replayed };
    } else if (s.currentPlayer === spec.ourSeat) {
      move = await spec.ours(position, ply);
    } else if (spec.theirs !== null) {
      move = await spec.theirs(position, ply);
    } else {
      const a = await ask({ type: 'move' }, where('their move'));
      move = { side: 'theirs', ...(a as unknown as Omit<Move, 'side'>) };
      if (!isLegal(s, move.action)) fail('their move is illegal in our engine', { action: move.action });
    }

    const roundBefore = s.roundIndex;
    const bagBefore = position.bag;
    apply(s, move.action);
    played.push(move.action);
    moves.push(move);
    census.plies++;
    const after = toJSON(s);
    // Within a round the lid grows only when a floor overflows: our engine sends
    // a full floor's excess there at once.
    const lid = (x: number[]): number => x.reduce((a, b) => a + b, 0);
    if (s.roundIndex === roundBefore && !s.isTerminal && lid(after.lid) > lid(position.lid)) census.floorOverflows++;

    const stepped = await ask({ type: 'step', action: move.action }, where('step'));
    const roundEnded = s.isTerminal || s.roundIndex !== roundBefore;
    if (JSON.stringify(stepped.scores) !== JSON.stringify(s.scores)) {
      fail("their totals differ from our engine's after the move", { ours: s.scores, theirs: stepped.scores, action: move.action });
    }
    if (Boolean(stepped.roundFinished) !== roundEnded) {
      fail("their round's end differs from our engine's", { ours: roundEnded, theirs: stepped.roundFinished, action: move.action });
    }
    if (Boolean(stepped.terminated) !== s.isTerminal) {
      fail("their game's end differs from our engine's", { ours: s.isTerminal, theirs: stepped.terminated, action: move.action });
    }
    ply++;
    if (roundEnded) census.roundEnds++;
    if (s.isTerminal) {
      if (stepped.winner !== winnerOf(s)) fail("their winner differs from our engine's", { ours: winnerOf(s), theirs: stepped.winner });
      break;
    }
    if (roundEnded) {
      const bagSize = bagBefore.reduce((a, b) => a + b, 0);
      if (bagSize > 0 && bagSize < 20 && bagSize % 4 !== 0) census.refillsInsideAFactory++;
      await ask({ type: 'deal', tiles: dealTiles(bagBefore, s.factories) }, where('deal'));
    }
  }
  return { seed: spec.seed, ourSeat: spec.ourSeat, scores: s.scores.slice(), winner: winnerOf(s), plies: ply, moves };
}

/** The report of [G13-19], from a `Disagreement` `playGame` threw. */
export function disagreementRecord(spec: Pick<GameSpec, 'seed' | 'ourSeat'>, e: Disagreement): DisagreementRecord {
  const extra = e as Disagreement & { moves: number[]; last: { position: ReturnType<typeof toJSON>; imported: ImportArgs } | null };
  return {
    seed: spec.seed,
    ourSeat: spec.ourSeat,
    ply: e.ply,
    comparison: e.comparison,
    moves: extra.moves,
    position: extra.last?.position as ReturnType<typeof toJSON>,
    imported: extra.last?.imported as ImportArgs,
    details: e.details,
  };
}
