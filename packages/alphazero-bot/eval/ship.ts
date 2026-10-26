/**
 * The ship match ([0012 T12-34], [T12-35]): how a milestone replaces `master`.
 *
 * A milestone whose anchored rating exceeds `master`'s is only a candidate: the
 * highest of many ratings of about ±7 is biased upward, and `sixteenth`/20
 * shipped at 876 on the anchors and then scored −12 Elo against `twelfth`/120
 * in 500 direct games. A candidate replaces `master` only by beating it
 * directly, in a sequential probability ratio test on pairs of games, each
 * seed played from both seats.
 */

import { join } from 'node:path';
import { allocateBase, seedsFrom, usedSeeds, type AnchorSide, type AnchorsFile } from './anchors.js';
import type { LogEntry, ShipEntry } from './decision.js';
import { readJson, sha256File, writeJson } from './files.js';
import { checkCounts } from './milestone.js';
import { PACKAGE, milestoneCheckpoint } from './paths.js';
import { memberName } from './pool.js';
import { playSeries, simulationCounts, type GameRecord } from './series.js';

/** [T12-34]'s test: H0 at most `elo0`, H1 at least `elo1`, errors `alpha` and `beta`. */
export interface ShipTest {
  elo0: number;
  elo1: number;
  alpha: number;
  beta: number;
  /** Games at which the test gives up and rejects. */
  maxGames: number;
  /** Pairs played between looks at the ratio. */
  batchPairs: number;
}

export const SHIP_TEST: ShipTest = { elo0: 0, elo1: 15, alpha: 0.05, beta: 0.05, maxGames: 8000, batchPairs: 200 };

/**
 * A pair's score, the mean of its two games, in quarters: 0, ¼, ½, ¾, 1. A
 * draw makes the odd quarters; Azul rarely draws, but the test must not
 * assume it never does.
 */
export type Pentanomial = [number, number, number, number, number];

const elo = (e: number): number => 1 / (1 + 10 ** (-e / 400));

/**
 * The log-likelihood ratio of H1 over H0 for `counts`, the normal
 * approximation fishtest uses on pair scores: `n · (s1 − s0) · (2m − s0 − s1)
 * / (2v)`, `m` and `v` the pairs' mean and variance. A variance of 0, every
 * pair alike, is floored so the ratio stays finite.
 */
export function llr(counts: Pentanomial, test: ShipTest = SHIP_TEST): number {
  const n = counts.reduce((a, b) => a + b, 0);
  if (n === 0) return 0;
  const mean = counts.reduce((a, c, i) => a + c * (i / 4), 0) / n;
  const square = counts.reduce((a, c, i) => a + c * (i / 4) ** 2, 0) / n;
  const variance = Math.max(square - mean * mean, 1e-9);
  const [s0, s1] = [elo(test.elo0), elo(test.elo1)];
  return (n * (s1 - s0) * (2 * mean - s0 - s1)) / (2 * variance);
}

/** Wald's bounds: reject H1 at or below the first, accept it at or above the second. */
export function bounds(test: ShipTest = SHIP_TEST): [number, number] {
  return [Math.log(test.beta / (1 - test.alpha)), Math.log((1 - test.beta) / test.alpha)];
}

/**
 * [T12-34]'s verdict on the cumulative counts after each look, in order: the
 * first look whose ratio crosses a bound decides; without one, `reject` once
 * the games reach `maxGames`, and `continue` before.
 */
export function verdict(looks: readonly Pentanomial[], test: ShipTest = SHIP_TEST): 'accept' | 'reject' | 'continue' {
  const [lo, hi] = bounds(test);
  for (const counts of looks) {
    const r = llr(counts, test);
    if (r >= hi) return 'accept';
    if (r <= lo) return 'reject';
  }
  const last = looks[looks.length - 1];
  const games = last === undefined ? 0 : 2 * last.reduce((a, b) => a + b, 0);
  return games >= test.maxGames ? 'reject' : 'continue';
}

/** The pair scores of a batch's games, game `2k` and `2k + 1` sharing a seed, added to `counts`. */
export function addPairs(counts: Pentanomial, games: readonly GameRecord[]): Pentanomial {
  const out = [...counts] as Pentanomial;
  for (let k = 0; k + 1 < games.length; k += 2) {
    const [a, b] = [games[k], games[k + 1]];
    if (a.seed !== b.seed || a.index % 2 !== 0) throw new Error(`games ${a.index} and ${b.index} are not one seed from both seats`);
    out[Math.round((a.points + b.points) * 2)]++;
  }
  return out;
}

/** Every seed twice, so the subject plays it from the first seat and then the second ([0005 M5-3]). */
export function pairedSeeds(base: number, pairs: number): number[] {
  return seedsFrom(base, pairs).flatMap((s) => [s, s]);
}

/** `master` as the log names it: the latest `ship` entry that accepted or pinned one, or none yet. */
export function currentMaster(log: readonly LogEntry[]): { run: string; generation: number } | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.kind === 'ship' && e.decision !== 'reject') return { run: e.run, generation: e.generation };
  }
  return null;
}

/** A milestone's rating on the anchors: an anchor's in the file, else its latest logged one. */
export function anchoredRating(
  m: { run: string; generation: number },
  file: AnchorsFile,
  log: readonly LogEntry[],
): number | undefined {
  const anchor = file.members.find((a) => memberName(a) === memberName(m));
  if (anchor !== undefined) return anchor.rating;
  let rating: number | undefined;
  for (const e of log) {
    const r = (e as { anchored?: { rating?: unknown } }).anchored?.rating;
    if ((e.kind === 'milestone' || e.kind === 'rating') && e.run === m.run && e.generation === m.generation && typeof r === 'number') {
      rating = r;
    }
  }
  return rating;
}

/** What a played ship match records, beside the entry's own fields. */
export interface ShipMatch {
  seedBase: number;
  looks: Pentanomial[];
  decision: 'accept' | 'reject';
  simulations: Record<string, number>;
  seconds: number;
}

/**
 * [T12-34]: `candidate` against `master`, both by the milestone search at the
 * anchors' count, `batchPairs` pairs between looks, on seeds no record used.
 */
export async function playShip(
  side: AnchorSide,
  candidate: string,
  master: { run: string; generation: number },
  key: string,
  file: AnchorsFile,
  log: readonly LogEntry[],
  workers: number,
  test: ShipTest = SHIP_TEST,
): Promise<ShipMatch> {
  const started = Date.now();
  const maxPairs = test.maxGames / 2;
  const base = allocateBase(key, maxPairs, usedSeeds(file, log));
  const seeds = pairedSeeds(base, maxPairs);
  const looks: Pentanomial[] = [];
  let counts: Pentanomial = [0, 0, 0, 0, 0];
  const all: GameRecord[] = [];
  const opponent = milestoneCheckpoint(master.run, master.generation);
  for (let at = 0; verdict(looks, test) === 'continue'; at += 2 * test.batchPairs) {
    const batch = seeds.slice(at, at + 2 * test.batchPairs);
    const games = await playSeries(
      {
        subject: { kind: 'alphazero', player: { binary: side.binary, checkpoint: candidate, config: side.config, search: 'milestone' } },
        opponent: { kind: 'alphazero', player: { binary: side.binary, checkpoint: opponent, config: side.config, search: 'milestone' } },
        seeds: batch,
      },
      workers,
    );
    all.push(...games);
    counts = addPairs(counts, games);
    looks.push(counts);
    const pairs = counts.reduce((a, b) => a + b, 0);
    process.stderr.write(`ship vs ${memberName(master)}: ${pairs} pairs, LLR ${llr(counts, test).toFixed(2)} in ${bounds(test).map((b) => b.toFixed(2)).join('..')}\n`);
  }
  const simulations = simulationCounts(all);
  checkCounts(simulations, file.simulations, 'ship');
  const decision = verdict(looks, test) as 'accept' | 'reject';
  return { seedBase: base, looks, decision, simulations, seconds: Math.round((Date.now() - started) / 1000) };
}

/** A pair-score count's games and score, the candidate's share. */
export function scoreOf(counts: Pentanomial): { games: number; score: number } {
  const pairs = counts.reduce((a, b) => a + b, 0);
  return { games: 2 * pairs, score: pairs === 0 ? 0 : counts.reduce((a, c, i) => a + c * (i / 4), 0) / pairs };
}

/** The entry a played match makes ([T12-35]). */
export function shipEntry(
  candidate: { run: string; generation: number },
  master: { run: string; generation: number },
  match: ShipMatch,
  simulations: number,
  date: string,
  test: ShipTest = SHIP_TEST,
): ShipEntry {
  const last = match.looks[match.looks.length - 1] ?? [0, 0, 0, 0, 0];
  const { games, score } = scoreOf(last);
  const r = llr(last, test);
  return {
    kind: 'ship',
    run: candidate.run,
    date,
    generation: candidate.generation,
    decision: match.decision,
    master,
    simulations,
    seedBase: match.seedBase,
    test,
    looks: match.looks,
    seconds: match.seconds,
    reason:
      `${memberName(candidate)} against master ${memberName(master)}: ${games} games, ${(100 * score).toFixed(1)}%, ` +
      `LLR ${r.toFixed(2)} in ${bounds(test).map((b) => b.toFixed(2)).join('..')} for ${test.elo0} against +${test.elo1} Elo: ` +
      (match.decision === 'accept' ? 'ships as master.' : 'master stays.'),
  };
}

/** The web payload's record of `master`'s files, for the shipped milestone ([T12-9]). */
export const SHIPPED = join(PACKAGE, 'web', 'shipped.json');

/**
 * `web/shipped.json` naming `m`, its files' hashes with it, the rest of the
 * file as it was. Computed before anything is written, so a missing file
 * fails before the log names a `master` the payload cannot.
 */
export function shippedFor(m: { run: string; generation: number }, path: string = SHIPPED): Record<string, unknown> {
  const shipped = readJson<Record<string, unknown>>(path);
  const checkpoint = milestoneCheckpoint(m.run, m.generation);
  return {
    ...shipped,
    run: m.run,
    generation: m.generation,
    checkpointSha256: sha256File(checkpoint),
    paritySha256: sha256File(checkpoint.replace(/\.bin$/, '.parity')),
  };
}

export function writeShipped(next: Record<string, unknown>, path: string = SHIPPED): void {
  writeJson(path, next);
}

/**
 * [T12-34]: the run's anchored milestones still owed a ship match: rated above
 * the `master` of their time (before the first `ship` entry there is none, and
 * rating alone decided), still above today's `master`, and with no `ship`
 * entry naming them since, a pin included. A
 * match that was interrupted is owed still, so the loop plays it when it
 * comes back. A `master` with no rating on the anchors cannot be compared
 * with, and says so rather than shipping nothing for ever.
 */
export function pendingShips(log: readonly LogEntry[], run: string, file: AnchorsFile): { run: string; generation: number }[] {
  const out: { run: string; generation: number }[] = [];
  // Before the first `ship` entry there is no `master` of the time, so nothing is owed.
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (e.kind !== 'milestone' || e.run !== run) continue;
    const rating = (e as { anchored?: { rating?: unknown } }).anchored?.rating;
    if (typeof rating !== 'number') continue;
    const earlier = log.slice(0, i);
    const master = currentMaster(earlier);
    if (master === null) continue;
    const bar = anchoredRating(master, file, earlier);
    if (bar === undefined) {
      throw new Error(`master ${memberName(master)} has no rating on the anchors: rate it with \`anchors rate\` so candidates can be compared`);
    }
    if (!(rating > bar)) continue;
    const settled = log.slice(i + 1).some((x) => x.kind === 'ship' && x.run === e.run && x.generation === e.generation);
    if (settled) continue;
    // Above today's master too. A candidate that is master is settled by the
    // entry that made it so, above; this bar alone would not do, since
    // master's rating is its latest, and a later `rating` entry can put it
    // below the milestone's own.
    const now = currentMaster(log);
    const today = now === null ? undefined : anchoredRating(now, file, log);
    if (today !== undefined && !(rating > today)) continue;
    out.push({ run: e.run, generation: e.generation });
  }
  return out;
}

/**
 * [T12-35]'s replay of a played `ship` entry against the log before it,
 * throwing a named failure; the seeds it played, for the caller's check that
 * no earlier record used them. Its test is [SHIP_TEST] and its count the
 * anchors'; it names the `master` of its time; each look is one more batch
 * than the last, and cumulative; it stopped at the first look that crossed a
 * bound, and played no look past the cap; and its decision is that verdict.
 */
export function checkShip(e: ShipEntry, earlier: readonly LogEntry[], simulations: number): { base: number; n: number } {
  const master = currentMaster(earlier);
  if (master === null || e.master === null || memberName(master) !== memberName(e.master)) {
    throw new Error('did not play the master of its time');
  }
  if (memberName(e) === memberName(e.master)) throw new Error('played master against itself');
  if (JSON.stringify(e.test) !== JSON.stringify(SHIP_TEST)) throw new Error('its test is not [T12-34]\'s');
  if (e.simulations !== simulations) throw new Error(`played at ${e.simulations} simulations, not the anchors' ${simulations}`);
  const looks = e.looks ?? [];
  if (looks.length === 0 || e.seedBase === undefined) throw new Error('a played match with no looks or no seeds');
  const test = SHIP_TEST;
  if (looks.length * 2 * test.batchPairs > test.maxGames) throw new Error('played past the cap');
  looks.forEach((c, k) => {
    if (c.reduce((a, b) => a + b, 0) !== (k + 1) * test.batchPairs) throw new Error(`look ${k} is not ${k + 1} batches`);
    if (k > 0 && c.some((x, j) => x < looks[k - 1][j])) throw new Error(`look ${k} is not cumulative`);
    if (k < looks.length - 1 && verdict(looks.slice(0, k + 1), test) !== 'continue') throw new Error(`played on after look ${k} decided`);
  });
  const decided = verdict(looks, test);
  if (decided !== e.decision) throw new Error(`the decision disagrees with verdict(): ${decided}`);
  return { base: e.seedBase, n: looks[looks.length - 1].reduce((a, b) => a + b, 0) };
}
