/**
 * The anchors ([Z11-84], [Z11-85]): the yardstick that replaced the pool.
 *
 * A few committed milestone checkpoints with ratings fixed once, by a round
 * robin of their own, and never changed by a milestone. A milestone plays
 * every anchor on seeds no other record used and is rated by its performance
 * against their ratings. Nothing is admitted or replaced, so no selection
 * reaches the scale, and every milestone meets the same fixed points: the
 * pool compared each only with its run's latest champions, and its scale
 * drifted upward by more than any run gained ([Z11-74]).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry } from './decision.js';
import { fitPool, performance, type Played } from './elo.js';
import { readJson, sha256 } from './files.js';
import { checkCounts } from './milestone.js';
import { MILESTONES, PACKAGE } from './paths.js';
import { POOL_SEEDS, memberName } from './pool.js';
import { aggregate, playSeries, simulationCounts, type GameRecord, type SeriesResult } from './series.js';

export const ANCHORS = join(MILESTONES, 'anchors.json');

/** The step between a seed list's seeds, the wide list's ([0005 M5-16]). */
export const SEED_STEP = 104729;
/** Where allocated seed bases start: past every list in use, and every seed below 2³¹. */
export const SEED_FLOOR = 300_000_000;
/** A milestone rated further than this above the strongest anchor is flagged ([Z11-85]). */
export const BEYOND = 150;

export interface Anchor {
  run: string;
  generation: number;
  /** Package-relative: `milestones/<run>/<generation>/checkpoint.bin`. */
  checkpoint: string;
  rating: number;
  se: number;
  /** `init`, or the date `anchors add` rated it. */
  added: string;
}

/** Games between two players, `score` being `a`'s, on the seeds from `seedBase`. */
export interface AnchorPairing {
  a: string;
  b: string;
  games: number;
  score: number;
  seedBase: number;
}

export interface AnchorsFile {
  simulations: number;
  /** A milestone's games against each anchor. */
  gamesPerMember: number;
  pin: { run: string; generation: number; rating: number };
  members: Anchor[];
  pairings: AnchorPairing[];
  date: string;
  seconds: number;
}

/** What an anchored milestone, or an `anchors rate`, records ([Z11-85]). */
export interface AnchoredRecord {
  simulations: number;
  gamesPerMember: number;
  seedBase: number;
  /** The anchors it played, with their ratings in the file. */
  anchors: { run: string; generation: number; rating: number }[];
  rating: number;
  se: number;
  /** More than [BEYOND] above the strongest anchor. */
  beyond: boolean;
}

export function readAnchors(path: string = ANCHORS): AnchorsFile {
  if (!existsSync(path)) throw new Error('no anchors: run `pnpm -F alphazero-bot anchors init` first');
  return readJson<AnchorsFile>(path);
}

export function anchorsExist(path: string = ANCHORS): boolean {
  return existsSync(path);
}

export function seedsFrom(base: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => base + i * SEED_STEP);
}

/** A run of `n` seeds from `base`. */
export interface SeedRun {
  base: number;
  n: number;
}

/** Whether two seed runs share a seed: `a + i·step = b + j·step` for some `i < a.n`, `j < b.n`. */
export function overlaps(a: SeedRun, b: SeedRun): boolean {
  const d = a.base - b.base;
  if (d % SEED_STEP !== 0) return false;
  const q = d / SEED_STEP;
  return q > -a.n && q < b.n;
}

/** Every seed run already spoken for: the pool's list, the anchors' pairings, the log's anchored records and ship matches. */
export function usedSeeds(file: AnchorsFile | null, log: readonly LogEntry[]): SeedRun[] {
  const out: SeedRun[] = [{ base: POOL_SEEDS[0], n: POOL_SEEDS.length }];
  for (const p of file?.pairings ?? []) out.push({ base: p.seedBase, n: p.games });
  for (const e of log) {
    const r = (e as { anchored?: AnchoredRecord }).anchored;
    if (r !== undefined) out.push({ base: r.seedBase, n: r.gamesPerMember });
    // [0012 T12-35]: a ship match's seeds, each played from both seats.
    if (e.kind === 'ship' && e.seedBase !== undefined && e.looks !== undefined) {
      const last = e.looks[e.looks.length - 1];
      out.push({ base: e.seedBase, n: last === undefined ? 0 : last.reduce((a, b) => a + b, 0) });
    }
  }
  return out;
}

/** `3·10⁸` plus the first four bytes of sha256(`key`), little-endian, mod 2³⁰. */
export function hashBase(key: string): number {
  const h = Buffer.from(sha256(key), 'hex').readUInt32LE(0);
  return SEED_FLOOR + (h % 2 ** 30);
}

/** [Z11-85]: the first base from `key`'s hash, counting up, whose `n` seeds no used run shares. */
export function allocateBase(key: string, n: number, used: readonly SeedRun[]): number {
  for (let base = hashBase(key); ; base++) {
    if (!used.some((u) => overlaps({ base, n }, u))) return base;
  }
}

function playedAgainst(file: AnchorsFile, results: Record<string, { games: number; wins: number; draws: number }>): Played[] {
  return Object.entries(results).map(([name, r]) => {
    const anchor = file.members.find((m) => memberName(m) === name);
    if (anchor === undefined) throw new Error(`${name} is not an anchor`);
    return { opponent: anchor.rating, games: r.games, score: r.wins + r.draws / 2 };
  });
}

/** A record from its series, rated against the file's ratings ([Z11-85]). */
export function rateAgainst(
  file: AnchorsFile,
  results: Record<string, { games: number; wins: number; draws: number }>,
  seedBase: number,
): AnchoredRecord {
  const rating = performance(playedAgainst(file, results));
  const strongest = Math.max(...file.members.map((m) => m.rating));
  const names = new Set(Object.keys(results));
  return {
    simulations: file.simulations,
    gamesPerMember: file.gamesPerMember,
    seedBase,
    anchors: file.members
      .filter((m) => names.has(memberName(m)))
      .map((m) => ({ run: m.run, generation: m.generation, rating: m.rating })),
    rating: rating.rating,
    se: rating.se,
    beyond: rating.rating > strongest + BEYOND,
  };
}

/**
 * [Z11-85]'s replay of one record: its anchors' ratings are the file's, its
 * rating and `beyond` follow from its series, and none of its seeds was used
 * by a record before it or by the file.
 */
export function checkRecord(
  file: AnchorsFile,
  record: AnchoredRecord,
  results: Record<string, { games: number; wins: number; draws: number }>,
  earlier: readonly SeedRun[],
): void {
  for (const a of record.anchors) {
    const m = file.members.find((x) => memberName(x) === memberName(a));
    if (m === undefined || m.rating !== a.rating) throw new Error(`${memberName(a)}'s rating is not the file's`);
  }
  const again = rateAgainst(file, results, record.seedBase);
  if (Math.round(again.rating * 1e9) !== Math.round(record.rating * 1e9)) {
    throw new Error(`the rating ${record.rating} does not follow from the series (${again.rating})`);
  }
  if (again.beyond !== record.beyond) throw new Error('`beyond` disagrees with the rating');
  if (earlier.some((u) => overlaps({ base: record.seedBase, n: record.gamesPerMember }, u))) {
    throw new Error(`the seeds from ${record.seedBase} were used before`);
  }
}

/** The settings both sides of an anchored game read. */
export interface AnchorSide {
  binary: string;
  /** A config whose `milestoneSimulations` is the anchors' count. */
  config: string;
}

export interface AnchorSeries {
  anchor: Anchor;
  result: SeriesResult;
  games: GameRecord[];
}

/** `subject` against each of `opponents`, `n` games each on the seeds from `base`. */
export async function playAgainst(
  side: AnchorSide,
  subject: string,
  opponents: readonly Anchor[],
  bases: readonly number[],
  n: number,
  workers: number,
  label: string,
): Promise<AnchorSeries[]> {
  const out: AnchorSeries[] = [];
  for (const [k, m] of opponents.entries()) {
    const started = Date.now();
    let points = 0;
    const seeds = seedsFrom(bases[k], n);
    const games = await playSeries(
      {
        subject: { kind: 'alphazero', player: { binary: side.binary, checkpoint: subject, config: side.config, search: 'milestone' } },
        opponent: {
          kind: 'alphazero',
          player: { binary: side.binary, checkpoint: join(PACKAGE, m.checkpoint), config: side.config, search: 'milestone' },
        },
        seeds,
      },
      workers,
      (g, done) => {
        points += g.points;
        if (done % 50 === 0 || done === seeds.length) {
          process.stderr.write(
            `${label} vs ${memberName(m)} ${done}/${seeds.length}: running ${((100 * points) / done).toFixed(1)}%` +
              ` (${((Date.now() - started) / 1000 / done).toFixed(2)}s/game)\n`,
          );
        }
      },
    );
    out.push({ anchor: m, result: aggregate(games), games });
  }
  return out;
}

export interface AnchoredMilestone {
  record: AnchoredRecord;
  results: Record<string, SeriesResult>;
  simulations: Record<string, number>;
  seconds: number;
}

/** [Z11-85]: `checkpoint` against every anchor on its allocated seeds, rated against their ratings. */
export async function playAnchored(
  side: AnchorSide,
  checkpoint: string,
  key: string,
  file: AnchorsFile,
  log: readonly LogEntry[],
  workers: number,
): Promise<AnchoredMilestone> {
  const started = Date.now();
  const n = file.gamesPerMember;
  const base = allocateBase(key, n, usedSeeds(file, log));
  const series = await playAgainst(side, checkpoint, file.members, file.members.map(() => base), n, workers, 'anchors');
  const all = series.flatMap((s) => s.games);
  const simulations = simulationCounts(all);
  checkCounts(simulations, file.simulations, 'anchors');
  const results: Record<string, SeriesResult> = {};
  for (const s of series) results[memberName(s.anchor)] = s.result;
  return { record: rateAgainst(file, results, base), results, simulations, seconds: Math.round((Date.now() - started) / 1000) };
}

/**
 * [Z11-84]'s fit: every member's rating from the round robin, the pinned one
 * held at its rating, the others' standard errors relative to it.
 */
export function fitAnchors(
  members: readonly { run: string; generation: number }[],
  pairings: readonly AnchorPairing[],
  pin: { run: string; generation: number; rating: number },
): { rating: number; se: number }[] {
  const index = new Map(members.map((m, i) => [memberName(m), i]));
  const at = index.get(memberName(pin));
  if (at === undefined) throw new Error(`the pin ${memberName(pin)} is not a member`);
  const fitted = fitPool(
    members.length,
    pairings.map((p) => ({ a: index.get(p.a) ?? -1, b: index.get(p.b) ?? -1, games: p.games, score: p.score })),
    at,
  );
  return fitted.map((r) => ({ rating: r.rating + pin.rating, se: r.se }));
}
