/**
 * Series of single-seed matches, as [0008 A8-30] plays its gate: one `match`
 * from the arena per seed, unchanged, the subject on `a` for even-indexed
 * seeds and on `b` for odd ones, which alternates its seat ([0005 M5-3]).
 *
 * Games MAY run in parallel processes ([Z11-31]): each game is a pure
 * function of its seed and its two players, so a series' result does not
 * depend on how its games were shared out. They are aggregated in seed order.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RANDOM_CHOOSER_SEED, greedy, match, tier, uniformRandom, wilsonLowerBound, type Chooser } from 'bot/arena';
import { alphazeroChooser, type Answer, type PlayerSpec } from './chooser.js';

/** `sharp` and `steady` at their shipped budgets, the fail-safe out of reach ([0005 M5-8]). */
export const OUT_OF_REACH_MS = 60 * 60 * 1000;

export type Entrant =
  | { kind: 'alphazero'; player: PlayerSpec }
  | { kind: 'uniformRandom' }
  | { kind: 'greedy' }
  | { kind: 'tier'; tier: 'steady' | 'sharp' };

export interface SeriesSpec {
  subject: Entrant;
  opponent: Entrant;
  seeds: readonly number[];
}

export interface GameRecord {
  index: number;
  seed: number;
  /** The subject's share: 1 a win, 0.5 a draw, 0 a loss. */
  points: number;
  scores: [number, number];
  plies: number;
  work: [{ nodes: number; ms: number }, { nodes: number; ms: number }];
  /** The simulation count the subject's `play` reported, per move, as a histogram. */
  simulations: Record<string, number>;
}

/** [0005 M5-6]'s `Result` fields, from the subject's side. */
export interface SeriesResult {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winrate: number;
  lowerBound: number;
  meanScore: [number, number];
  seats: [number, number];
  bySeat: [number, number];
  plies: number;
  work: [{ nodes: number; ms: number }, { nodes: number; ms: number }];
  curtailed: number;
  lostSeeds: number[];
}

function chooser(e: Entrant, onMove?: (a: Answer) => void): Chooser {
  switch (e.kind) {
    case 'alphazero':
      return alphazeroChooser(e.player, onMove);
    case 'uniformRandom':
      return uniformRandom(RANDOM_CHOOSER_SEED);
    case 'greedy':
      return greedy();
    case 'tier':
      return tier({ tier: e.tier, milliseconds: OUT_OF_REACH_MS });
  }
}

/** One game: a fresh single-seed match, both choosers built for it alone. */
export function playOne(spec: SeriesSpec, index: number): GameRecord {
  const seed = spec.seeds[index];
  const simulations: Record<string, number> = {};
  const count = (a: Answer): void => {
    simulations[a.simulations] = (simulations[a.simulations] ?? 0) + 1;
  };
  const subjectFirst = index % 2 === 0;
  const subject = chooser(spec.subject, count);
  const opponent = chooser(spec.opponent);
  const r = match({ a: subjectFirst ? subject : opponent, b: subjectFirst ? opponent : subject, seeds: [seed] });
  const [mine, theirs] = subjectFirst ? [0, 1] : [1, 0];
  return {
    index,
    seed,
    points: subjectFirst ? r.winrate : 1 - r.winrate,
    // `meanScore` and `work` are `[a's, b's]`, not seat 0's and seat 1's.
    scores: [r.meanScore[mine], r.meanScore[theirs]],
    plies: r.plies,
    work: [r.work[mine], r.work[theirs]],
    simulations,
  };
}

export function aggregate(games: GameRecord[]): SeriesResult {
  const sorted = [...games].sort((x, y) => x.index - y.index);
  let successes = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let plies = 0;
  const seats: [number, number] = [0, 0];
  const seatPoints: [number, number] = [0, 0];
  const totals: [number, number] = [0, 0];
  const work: SeriesResult['work'] = [
    { nodes: 0, ms: 0 },
    { nodes: 0, ms: 0 },
  ];
  const lostSeeds: number[] = [];
  for (const g of sorted) {
    successes += g.points;
    if (g.points === 1) wins++;
    else if (g.points === 0) {
      losses++;
      lostSeeds.push(g.seed);
    } else draws++;
    const seat = g.index % 2;
    seats[seat]++;
    seatPoints[seat] += g.points;
    totals[0] += g.scores[0];
    totals[1] += g.scores[1];
    plies += g.plies;
    for (const side of [0, 1] as const) {
      work[side].nodes += g.work[side].nodes;
      work[side].ms += g.work[side].ms;
    }
  }
  const n = sorted.length;
  return {
    games: n,
    wins,
    losses,
    draws,
    winrate: n === 0 ? 0 : successes / n,
    lowerBound: wilsonLowerBound(successes, n),
    meanScore: [n === 0 ? 0 : totals[0] / n, n === 0 ? 0 : totals[1] / n],
    seats,
    bySeat: [seats[0] === 0 ? 0 : seatPoints[0] / seats[0], seats[1] === 0 ? 0 : seatPoints[1] / seats[1]],
    plies,
    work,
    curtailed: 0,
    lostSeeds,
  };
}

/** Every move's simulation count across a series, as one histogram. */
export function simulationCounts(games: GameRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of games) for (const [k, v] of Object.entries(g.simulations)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** The bundle's own path: workers are this module, run as `series-worker`. */
function bundlePath(): string | null {
  const self = fileURLToPath(import.meta.url);
  return self.endsWith('.mjs') ? self : null;
}

/**
 * Plays a series on `workers` processes (in this one when 1, or when not
 * running from the bundle), reporting each game to `progress` as it ends.
 */
export async function playSeries(
  spec: SeriesSpec,
  workers: number,
  progress?: (g: GameRecord, done: number) => void,
): Promise<GameRecord[]> {
  const games: GameRecord[] = [];
  const cli = bundlePath();
  if (workers <= 1 || cli === null) {
    for (let i = 0; i < spec.seeds.length; i++) {
      const g = playOne(spec, i);
      games.push(g);
      progress?.(g, games.length);
    }
    return games;
  }
  const shares = Array.from({ length: Math.min(workers, spec.seeds.length) }, (_, w) => w);
  await Promise.all(
    shares.map(
      (w) =>
        new Promise<void>((resolve, reject) => {
          const indices = spec.seeds.map((_, i) => i).filter((i) => i % shares.length === w);
          const child = spawn(process.execPath, [cli, 'series-worker'], { stdio: ['pipe', 'pipe', 'inherit'] });
          let buffer = '';
          child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const g = JSON.parse(buffer.slice(0, nl)) as GameRecord;
              buffer = buffer.slice(nl + 1);
              games.push(g);
              progress?.(g, games.length);
            }
          });
          child.on('error', reject);
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`a series worker exited ${code}`))));
          child.stdin.end(JSON.stringify({ spec, indices }));
        }),
    ),
  );
  if (games.length !== spec.seeds.length) throw new Error('a series lost games');
  return games.sort((x, y) => x.index - y.index);
}

/** The worker's side: reads its share from stdin, one JSON line per game. */
export async function seriesWorker(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { spec, indices } = JSON.parse(input) as { spec: SeriesSpec; indices: number[] };
  for (const i of indices) process.stdout.write(`${JSON.stringify(playOne(spec, i))}\n`);
}
