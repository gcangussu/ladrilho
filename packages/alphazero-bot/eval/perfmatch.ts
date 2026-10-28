/**
 * The performance match ([Z11-101]): two builds of the shipped player, the
 * binary named and this tree's release build, each seed played twice with
 * the seats swapped. Builds that answer alike play one game twice, so every
 * position is timed by both under the same load, and identity is checked as
 * it goes. Printed, not written.
 */

import { apply, newGame, toJSON } from 'engine';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alphazeroChooser, type Answer, type PlayerSpec } from './chooser.js';
import { buildRelease } from './crate.js';
import { readJson } from './files.js';
import { readLog } from './log.js';
import { playConfig } from './pastdeal.js';
import { milestoneCheckpoint } from './paths.js';
import { SHIPPED, currentMaster } from './ship.js';
import { figures, type PassFigures } from './web-budget.js';

export type Build = 'old' | 'new';

export interface PerfPly {
  mover: Build;
  action: number;
  simulations: number;
  /** The root value's bits ([Z11-23]): equal values are equal bits. */
  value: number;
  ms: number;
}

export interface PerfGame {
  seed: number;
  /** The seat the new build plays. */
  newSeat: number;
  plies: PerfPly[];
  scores: number[];
}

/** One game: the new build in `newSeat`, each build a `serve` of its own. */
export function playPerfGame(players: Record<Build, PlayerSpec>, seed: number, newSeat: number): PerfGame {
  let last: Answer | null = null;
  const keep = (a: Answer): void => {
    last = a;
  };
  const chooser = { old: alphazeroChooser(players.old, keep), new: alphazeroChooser(players.new, keep) };
  const s = newGame(seed);
  const plies: PerfPly[] = [];
  try {
    for (;;) {
      const position = toJSON(s);
      if (position.isTerminal) return { seed, newSeat, plies, scores: position.players.map((p) => p.score) };
      const mover: Build = position.currentPlayer === newSeat ? 'new' : 'old';
      const { action } = chooser[mover](position);
      const a = last as Answer | null;
      if (a === null) throw new Error('a move without an answer');
      const bits = new DataView(new ArrayBuffer(4));
      bits.setFloat32(0, a.value, true);
      plies.push({ mover, action, simulations: a.simulations, value: bits.getUint32(0, true), ms: a.milliseconds });
      apply(s, action);
    }
  } finally {
    chooser.old.close();
    chooser.new.close();
  }
}

export interface PerfSummary {
  games: number;
  /** The seeds whose two games differ: their moves, simulations, values or scores. */
  differing: number[];
  newPoints: number;
  firstSeatWins: number;
  positions: number;
  old: PassFigures & { mean: number };
  new: PassFigures & { mean: number };
  /** The new build's total time over the old one's, and its 95% bootstrap interval over seeds. */
  ratio: number;
  interval: [number, number];
  /** The median of new/old over positions the old build took at least 50 ms on. */
  medianRatio: number;
  measured: number;
  newFaster: number;
}

const same = (a: PerfGame, b: PerfGame): boolean =>
  a.plies.length === b.plies.length &&
  a.plies.every((p, i) => p.action === b.plies[i].action && p.simulations === b.plies[i].simulations && p.value === b.plies[i].value) &&
  a.scores.every((x, i) => x === b.scores[i]);

/** A fixed generator for the bootstrap, so a summary prints the same twice. */
function uniform(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export function summarise(games: readonly PerfGame[]): PerfSummary {
  const seeds = new Map<number, PerfGame[]>();
  for (const g of games) seeds.set(g.seed, [...(seeds.get(g.seed) ?? []), g]);
  const pairs = [...seeds.values()].filter((p) => p.length === 2).map((p) => p.sort((a, b) => a.newSeat - b.newSeat));
  const differing = pairs.filter(([a, b]) => !same(a, b)).map(([a]) => a.seed);
  const times: Record<Build, number[]> = { old: [], new: [] };
  const perSeed: [number, number][] = [];
  const ratios: number[] = [];
  for (const [a, b] of pairs) {
    if (differing.includes(a.seed)) continue;
    let o = 0;
    let n = 0;
    a.plies.forEach((p, i) => {
      const [mine, theirs] = p.mover === 'new' ? [p, b.plies[i]] : [b.plies[i], p];
      times.new.push(mine.ms);
      times.old.push(theirs.ms);
      n += mine.ms;
      o += theirs.ms;
      if (theirs.ms >= 50) ratios.push(mine.ms / theirs.ms);
    });
    perSeed.push([o, n]);
  }
  const total = (xs: readonly [number, number][]): number => xs.reduce((s, [, n]) => s + n, 0) / xs.reduce((s, [o]) => s + o, 0);
  const next = uniform(1);
  const boots = Array.from({ length: 4000 }, () => total(perSeed.map(() => perSeed[Math.floor(next() * perSeed.length)]))).sort((a, b) => a - b);
  const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const sorted = [...ratios].sort((a, b) => a - b);
  return {
    games: games.length,
    differing,
    newPoints: games.reduce((s, g) => {
      const [me, them] = [g.scores[g.newSeat], g.scores[1 - g.newSeat]];
      return s + (me > them ? 1 : me === them ? 0.5 : 0);
    }, 0),
    firstSeatWins: games.filter((g) => g.scores[0] > g.scores[1]).length,
    positions: times.new.length,
    old: { ...figures(times.old), mean: mean(times.old) },
    new: { ...figures(times.new), mean: mean(times.new) },
    ratio: total(perSeed),
    interval: [boots[Math.floor(0.025 * boots.length)], boots[Math.floor(0.975 * boots.length) - 1]],
    medianRatio: sorted.length === 0 ? NaN : (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2,
    measured: sorted.length,
    newFaster: ratios.filter((r) => r < 1).length,
  };
}

/** The shipped player natively, built as `bin` ([Z11-101]). */
export function shippedPlayer(bin: string, simulations: number): PlayerSpec {
  const log = readLog();
  const master = currentMaster(log);
  if (master === null) throw new Error('the log names no master');
  const shipped = readJson<{ pastDeal: { sha256: string } | null }>(SHIPPED);
  const checkpoint = milestoneCheckpoint(master.run, master.generation);
  return {
    binary: bin,
    checkpoint,
    config: playConfig(master, log, simulations),
    search: 'play',
    ...(shipped.pastDeal === null ? {} : { pastDeal: join(checkpoint, '..', 'pastdeal.json') }),
  };
}

/** The bundle's own path: workers are this module, run as `perf-match-worker`. */
function bundlePath(): string | null {
  const self = fileURLToPath(import.meta.url);
  return self.endsWith('.mjs') ? self : null;
}

/**
 * Plays `seeds` seeds twice each on `workers` processes (in this one when 1,
 * or when not running from the bundle). A seed's two games go to neighbouring
 * workers, so they are played side by side.
 */
export async function playPerfMatch(players: Record<Build, PlayerSpec>, seeds: readonly number[], workers: number): Promise<PerfGame[]> {
  const jobs = seeds.flatMap((seed) => [0, 1].map((newSeat) => ({ seed, newSeat })));
  const cli = bundlePath();
  if (workers <= 1 || cli === null) return jobs.map((j) => playPerfGame(players, j.seed, j.newSeat));
  const games: PerfGame[] = [];
  const t = Date.now();
  await Promise.all(
    Array.from(
      { length: Math.min(workers, jobs.length) },
      (_, w) =>
        new Promise<void>((resolve, reject) => {
          const mine = jobs.filter((_, i) => i % workers === w);
          const child = spawn(process.execPath, [cli, 'perf-match-worker'], { stdio: ['pipe', 'pipe', 'inherit'] });
          let buffer = '';
          child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              games.push(JSON.parse(buffer.slice(0, nl)) as PerfGame);
              buffer = buffer.slice(nl + 1);
              if (games.length % 20 === 0 || games.length === jobs.length) {
                process.stderr.write(`perf-match ${games.length}/${jobs.length} games, ${((Date.now() - t) / 1000).toFixed(0)} s\n`);
              }
            }
          });
          child.on('error', reject);
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`a perf-match worker exited ${code}`))));
          child.stdin.end(JSON.stringify({ players, jobs: mine }));
        }),
    ),
  );
  if (games.length !== jobs.length) throw new Error('the perf match lost games');
  return games;
}

/** The worker's side: reads its share from stdin, one JSON line per game. */
export async function perfMatchWorker(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { players, jobs } = JSON.parse(input) as { players: Record<Build, PlayerSpec>; jobs: { seed: number; newSeat: number }[] };
  for (const j of jobs) process.stdout.write(`${JSON.stringify(playPerfGame(players, j.seed, j.newSeat))}\n`);
}

const row = (name: string, f: PassFigures & { mean: number }): string =>
  `  ${name}  mean ${f.mean.toFixed(0)}, p50 ${f.p50}, p95 ${f.p95}, p99 ${f.p99}, max ${f.max} ms`;

export function report(s: PerfSummary): string {
  return [
    `${s.games} games, ${s.positions} positions each searched by both builds`,
    s.differing.length === 0 ? '  every pair was one game, move for move' : `  PAIRS THAT DIFFER: seeds ${s.differing.join(', ')}`,
    `  the new build's points ${s.newPoints} of ${s.games}; the first seat won ${s.firstSeatWins}`,
    row('old', s.old),
    row('new', s.new),
    `  new/old total time ${s.ratio.toFixed(3)} (95% interval over seeds ${s.interval[0].toFixed(3)}–${s.interval[1].toFixed(3)})`,
    `  median per-position new/old ${s.medianRatio.toFixed(3)} over ${s.measured} positions of at least 50 ms; the new build faster at ${s.newFaster}`,
  ].join('\n');
}

/** `perf-match <old-binary>` ([Z11-101]). */
export async function perfMatch(oldBinary: string, seeds: number, simulations: number, workers: number): Promise<void> {
  if (!existsSync(oldBinary)) throw new Error(`${oldBinary}: no such binary`);
  const players = { old: shippedPlayer(oldBinary, simulations), new: shippedPlayer(buildRelease(), simulations) };
  const games = await playPerfMatch(players, Array.from({ length: seeds }, (_, i) => 5000 + i), workers);
  const s = summarise(games);
  process.stdout.write(`${report(s)}\n`);
  if (s.differing.length > 0) process.exitCode = 1;
}
