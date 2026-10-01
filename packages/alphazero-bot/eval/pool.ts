/**
 * The champions' pool ([Z11-73]): the yardstick that replaced the ladder once
 * the player outgrew it.
 *
 * Three champions, each a committed milestone checkpoint with an Elo rating.
 * A milestone plays its checkpoint against every champion at the pool's
 * simulation count, rates it by its performance against their ratings, and
 * may take the weakest champion's place ([Z11-74]).
 *
 * `milestones/pool.json` holds the pool as it was seeded and is never
 * rewritten by a milestone. The pool as it stands is the seed with every
 * logged replacement applied in log order, so the log stays the one record:
 * a milestone interrupted before its entry is written changes nothing.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, MilestoneEntry } from './decision.js';
import { performance, settle, verdict, type Played, type Rating } from './elo.js';
import { readJson } from './files.js';
import { checkCounts } from './milestone.js';
import { MILESTONES, PACKAGE } from './paths.js';
import { aggregate, playSeries, simulationCounts, type GameRecord, type SeriesResult } from './series.js';

export const POOL = join(MILESTONES, 'pool.json');

/** The wide list's formula ([0005 M5-16]), run on: a pool series needs more than its 200 seeds. */
export const POOL_SEEDS: readonly number[] = Object.freeze(Array.from({ length: 2000 }, (_, i) => 19910101 + i * 104729));

export interface Member {
  run: string;
  generation: number;
  /** Package-relative: `milestones/<run>/<generation>/checkpoint.bin`. */
  checkpoint: string;
  rating: number;
  se: number;
}

/** One pairing of the seeding's round robin, `score` being `a`'s. */
export interface SeedPairing {
  a: string;
  b: string;
  games: number;
  score: number;
}

export interface PoolSeed {
  simulations: number;
  gamesPerMember: number;
  /** The member held at 0 Elo: the scale's zero, kept after it leaves the pool. */
  anchor: { run: string; generation: number };
  members: Member[];
  date: string;
  pairings: SeedPairing[];
  seconds: number;
}

/** What a pool milestone records in its log entry ([Z11-34], [Z11-74]). */
export interface PoolRecord {
  simulations: number;
  gamesPerMember: number;
  extraPerMember: number;
  /** The champions it played, with their ratings then. */
  members: { run: string; generation: number; rating: number }[];
  /** The rating after every game, and its standard error. */
  rating: number;
  se: number;
  /** The rating after the first `gamesPerMember` a champion, the verdict's. */
  first: { rating: number; se: number };
  weakest: { run: string; generation: number; rating: number };
  verdict: 'replace' | 'keep' | 'more';
  settled: 'replace' | 'keep';
  replaced: { run: string; generation: number } | null;
}

export function memberName(m: { run: string; generation: number }): string {
  return `${m.run}/${m.generation}`;
}

export function readSeed(): PoolSeed {
  if (!existsSync(POOL)) throw new Error('no pool: run `pnpm -F alphazero-bot pool init` first');
  return readJson<PoolSeed>(POOL);
}

/** The pool as it stands: the seed, with every logged replacement applied in order. */
export function currentPool(seed: PoolSeed, log: readonly LogEntry[]): Member[] {
  let members = [...seed.members];
  for (const e of log) {
    if (e.kind !== 'milestone') continue;
    const pool = (e as MilestoneEntry).pool as PoolRecord | undefined;
    if (pool === undefined || pool.replaced === null) continue;
    const out = pool.replaced;
    if (!members.some((m) => m.run === out.run && m.generation === out.generation)) {
      throw new Error(`log: ${e.run}/${e.generation} replaced ${memberName(out)}, which was not in the pool`);
    }
    members = members.filter((m) => !(m.run === out.run && m.generation === out.generation));
    members.push({
      run: e.run,
      generation: e.generation,
      checkpoint: `milestones/${e.run}/${e.generation}/checkpoint.bin`,
      rating: pool.rating,
      se: pool.se,
    });
  }
  return members;
}

export function weakestOf(members: readonly Member[]): Member {
  return members.reduce((w, m) => (m.rating < w.rating ? m : w));
}

/** The settings both sides of a pool game read: the run's, at the pool's count. */
export interface PoolSide {
  binary: string;
  /** A config whose `milestoneSimulations` is the pool's ([Z11-73]). */
  config: string;
}

export interface PoolSeriesResult {
  member: Member;
  result: SeriesResult;
  games: GameRecord[];
}

/** The challenger against each member, on `seeds`, alternating seats. */
async function playMembers(
  side: PoolSide,
  challenger: string,
  members: readonly Member[],
  seeds: readonly number[],
  workers: number,
  label: string,
): Promise<PoolSeriesResult[]> {
  const out: PoolSeriesResult[] = [];
  for (const m of members) {
    const started = Date.now();
    let points = 0;
    const games = await playSeries(
      {
        subject: { kind: 'alphazero', player: { binary: side.binary, checkpoint: challenger, config: side.config, search: 'milestone' } },
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
    out.push({ member: m, result: aggregate(games), games });
  }
  return out;
}

function records(series: readonly PoolSeriesResult[]): Played[] {
  return series.map((s) => ({
    opponent: s.member.rating,
    games: s.games.length,
    score: s.games.reduce((t, g) => t + g.points, 0),
  }));
}

export interface PoolMilestone {
  record: PoolRecord;
  /** Each member's series, all its games counted: the entry's `results`. */
  results: Record<string, SeriesResult>;
  simulations: Record<string, number>;
  seconds: number;
}

/**
 * [Z11-74]: the challenger against every champion, `gamesPerMember` each; its
 * performance rating against their ratings; and the verdict against the
 * weakest — with a third as many games again against each when it falls
 * within two standard errors, the higher rating then deciding.
 */
export async function playPoolMilestone(
  side: PoolSide,
  challenger: string,
  seed: PoolSeed,
  members: readonly Member[],
  workers: number,
): Promise<PoolMilestone> {
  const started = Date.now();
  const n = seed.gamesPerMember;
  const series = await playMembers(side, challenger, members, POOL_SEEDS.slice(0, n), workers, 'pool');
  const weakest = weakestOf(members);
  const firstRating: Rating = performance(records(series));
  let rating = firstRating;
  const first = verdict(rating, weakest.rating);
  let extra = 0;
  let settled: 'replace' | 'keep' = first === 'replace' ? 'replace' : 'keep';
  if (first === 'more') {
    extra = Math.ceil(n / 3);
    const more = await playMembers(side, challenger, members, POOL_SEEDS.slice(n, n + extra), workers, 'pool, more');
    for (let i = 0; i < series.length; i++) {
      series[i].games.push(...more[i].games);
      series[i].result = aggregate(series[i].games);
    }
    rating = performance(records(series));
    settled = settle(rating, weakest.rating);
  }
  const all = series.flatMap((s) => s.games);
  const simulations = simulationCounts(all);
  checkCounts(simulations, seed.simulations, 'pool');
  const results: Record<string, SeriesResult> = {};
  for (const s of series) results[memberName(s.member)] = s.result;
  return {
    record: {
      simulations: seed.simulations,
      gamesPerMember: n,
      extraPerMember: extra,
      members: members.map((m) => ({ run: m.run, generation: m.generation, rating: m.rating })),
      rating: rating.rating,
      se: rating.se,
      first: { rating: firstRating.rating, se: firstRating.se },
      weakest: { run: weakest.run, generation: weakest.generation, rating: weakest.rating },
      verdict: first,
      settled,
      replaced: settled === 'replace' ? { run: weakest.run, generation: weakest.generation } : null,
    },
    results,
    simulations,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

/**
 * [Z11-73]'s seeding: a round robin among the first members, `games` a
 * pairing, the anchor held at 0 Elo and the rest fitted to the games.
 */
export async function playSeedRoundRobin(
  side: PoolSide,
  members: readonly { run: string; generation: number; checkpoint: string }[],
  games: number,
  simulations: number,
  workers: number,
): Promise<{ pairings: SeedPairing[]; seconds: number }> {
  const started = Date.now();
  const pairings: SeedPairing[] = [];
  for (let a = 0; a < members.length; a++) {
    for (let b = a + 1; b < members.length; b++) {
      const opponent = { ...members[b], rating: 0, se: 0 };
      const [s] = await playMembers(side, join(PACKAGE, members[a].checkpoint), [opponent], POOL_SEEDS.slice(0, games), workers, `seed ${memberName(members[a])}`);
      checkCounts(simulationCounts(s.games), simulations, 'pool seeding');
      pairings.push({ a: memberName(members[a]), b: memberName(members[b]), games, score: s.games.reduce((t, g) => t + g.points, 0) });
    }
  }
  return { pairings, seconds: Math.round((Date.now() - started) / 1000) };
}
