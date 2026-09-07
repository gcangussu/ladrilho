/**
 * The match harness [M5-1] through [M5-8], and the Wilson bound [M5-14].
 *
 * Games are driven through the engine and nothing else: `newGame` deals,
 * `legalActions` and `apply` move, `outcome` decides [M5-1]. The harness never
 * poses a position or edits a state — the same prohibition [0002 V2-3] places
 * on the conformance harness, and for the same reason: a fixture built by
 * poking fields tests the poking.
 */

import {
  apply,
  legalActions,
  newGame,
  outcome,
  toJSON,
  type AzulState,
  type Player,
} from 'engine';
import type { Chooser, Play } from './chooser.js';

/** A game that has run this long has run away [M5-5]. ~6× the mean length. */
const DEFAULT_MAX_PLIES = 400;

export interface MatchSpec {
  a: Chooser;
  b: Chooser;
  /** One per game. Recorded, never generated at run time [M5-4]. */
  seeds: readonly number[];
  maxPlies?: number;
}

export interface Work {
  nodes: number;
  ms: number;
}

export interface Result {
  games: number;
  /** From `a`'s side. */
  wins: number;
  losses: number;
  draws: number;
  winrate: number;
  /** One-sided 95% lower bound on the winrate [M5-14]. */
  lowerBound: number;
  meanScore: [number, number];
  /** Games `a` played as seat 0, and as seat 1 [M5-3]. */
  seats: [number, number];
  /** Winrate restricted to each seat, so an imbalance is visible [M5-3]. */
  bySeat: [number, number];
  plies: number;
  work: [Work, Work];
  /** Searches stopped by the fail-safe. Always 0 — [M5-8] fails first. */
  curtailed: number;
  /** Every seed `a` lost, so a number can be drilled into [M5-6]. */
  lostSeeds: number[];
}

/**
 * One game. `aSeat` says which seat `a` occupies, which is what [M5-3]
 * alternates.
 */
interface GameResult {
  /** `a`'s share: 1 win, 0.5 draw, 0 loss. */
  points: number;
  scores: [number, number];
  plies: number;
  work: [Work, Work];
}

function playGame(spec: MatchSpec, seed: number, aSeat: Player): GameResult {
  const s: AzulState = newGame(seed);
  const maxPlies = spec.maxPlies ?? DEFAULT_MAX_PLIES;
  const work: [Work, Work] = [
    { nodes: 0, ms: 0 },
    { nodes: 0, ms: 0 },
  ];
  let plies = 0;

  while (!s.isTerminal) {
    if (plies >= maxPlies) {
      // Fail rather than hang, and say which game [M5-5].
      throw new Error(`seed ${seed}: game exceeded ${maxPlies} plies`);
    }
    const isA = s.currentPlayer === aSeat;
    const chooser = isA ? spec.a : spec.b;
    const side = isA ? 0 : 1;

    // The chooser is handed the view and nothing else [M5-2]. `toJSON` reports
    // the bag as counts [0001 E1-52], so the state the harness holds cannot
    // reach it — this line is the barrier, not a promise about one.
    const position = toJSON(s);
    const legal = legalActions(s);
    const started = performance.now();
    const play: Play = chooser(position);
    work[side].ms += performance.now() - started;
    work[side].nodes += play.nodes;

    if (!legal.includes(play.action)) {
      throw new Error(
        `seed ${seed} ply ${plies}: chooser returned ${play.action}, which is not legal here`,
      );
    }
    if (play.curtailed) {
      // [M5-8]. A curtailed search is the one case [0004 B4-30] does not cover,
      // so a match containing one is not reproducible and its number is noise.
      throw new Error(
        `seed ${seed} ply ${plies}: a search was curtailed — the match is not reproducible`,
      );
    }

    apply(s, play.action);
    plies++;
  }

  const decided = outcome(s);
  const aWon = decided !== 0 && decided !== null && (decided === 1 ? 0 : 1) === aSeat;
  return {
    points: decided === 0 ? 0.5 : aWon ? 1 : 0,
    scores: [s.scores[aSeat], s.scores[1 - aSeat]],
    plies,
    work,
  };
}

/**
 * A one-sided 95% lower confidence bound on a winrate, by the Wilson interval
 * [M5-14].
 *
 * Reported beside the point estimate rather than used as the threshold. Because
 * the match is exactly reproducible [M5-7] there is no run-to-run noise for a
 * bound to protect against; what it answers is whether the conclusion
 * generalises past the recorded seeds, which is [M5-16]'s question.
 *
 * `successes` may be fractional — a draw is half a win [M5-24] — which the
 * Wilson form handles without special-casing.
 */
export function wilsonLowerBound(successes: number, games: number): number {
  if (games === 0) return 0;
  const z = 1.6448536269514722; // one-sided 95%
  const p = successes / games;
  const z2 = z * z;
  const centre = p + z2 / (2 * games);
  const spread = z * Math.sqrt((p * (1 - p)) / games + z2 / (4 * games * games));
  const bound = (centre - spread) / (1 + z2 / games);
  // The algebra can leave a hair outside [0, 1] at the extremes.
  return Math.min(1, Math.max(0, bound));
}

/**
 * Play a match and report it [M5-6].
 *
 * Seats alternate by game index [M5-3], so with an even seed count each
 * chooser plays each seat equally and with an odd one they differ by exactly
 * one. Azul is not seat-symmetric — player 0 opens — so a match from one seat
 * would measure the seat as much as the player.
 */
export function match(spec: MatchSpec): Result {
  if (spec.seeds.length === 0) throw new Error('a match needs at least one seed [M5-4]');

  let wins = 0;
  let losses = 0;
  let draws = 0;
  let plies = 0;
  const totals: [number, number] = [0, 0];
  const seats: [number, number] = [0, 0];
  const seatPoints: [number, number] = [0, 0];
  const work: [Work, Work] = [
    { nodes: 0, ms: 0 },
    { nodes: 0, ms: 0 },
  ];
  const lostSeeds: number[] = [];

  for (const [index, seed] of spec.seeds.entries()) {
    const aSeat: Player = (index % 2) as Player;
    const game = playGame(spec, seed, aSeat);

    if (game.points === 1) wins++;
    else if (game.points === 0) {
      losses++;
      lostSeeds.push(seed);
    } else draws++;

    seats[aSeat]++;
    seatPoints[aSeat] += game.points;
    totals[0] += game.scores[0];
    totals[1] += game.scores[1];
    plies += game.plies;
    for (const side of [0, 1] as const) {
      work[side].nodes += game.work[side].nodes;
      work[side].ms += game.work[side].ms;
    }
  }

  const games = spec.seeds.length;
  const successes = wins + draws / 2;
  return {
    games,
    wins,
    losses,
    draws,
    winrate: successes / games,
    lowerBound: wilsonLowerBound(successes, games),
    meanScore: [totals[0] / games, totals[1] / games],
    seats,
    bySeat: [
      seats[0] === 0 ? 0 : seatPoints[0] / seats[0],
      seats[1] === 0 ? 0 : seatPoints[1] / seats[1],
    ],
    plies,
    work,
    // [M5-8] throws rather than counting, so a reported result always has zero.
    // The field stays so a `Result` is self-describing rather than implying
    // that nobody checked.
    curtailed: 0,
    lostSeeds,
  };
}

/** A `Result` as one line, for a lane's output. */
export function summarise(label: string, result: Result): string {
  const pct = (n: number): string => `${(100 * n).toFixed(1)}%`;
  return (
    `${label}: ${pct(result.winrate)} over ${result.games} ` +
    `(lower bound ${pct(result.lowerBound)}), ` +
    `scores ${result.meanScore[0].toFixed(1)}–${result.meanScore[1].toFixed(1)}, ` +
    `seat 0 ${pct(result.bySeat[0])} / seat 1 ${pct(result.bySeat[1])}`
  );
}
