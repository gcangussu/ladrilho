/**
 * Matches: our master against their player, judged on our engine.
 *
 * A match is a grid — every simulation count of ours against every budget of
 * theirs — and each cell plays the same deals: game seed `seed + k` twice, once
 * from each seat, so a cell's games are paired and the cells share their
 * deals. Games run in worker threads, one game at a time each; a worker holds
 * their WASM for its life and starts one `alphazero serve` per game.
 *
 * Every game is a line of the `.jsonl` written as the match goes, so a long
 * match that is stopped keeps what it played.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { apply, newGame, outcome, toJSON } from 'engine';
import { alphazeroChooser } from '../eval/chooser.js';
import type { Build } from './assets.js';
import { loadTheirs, specLabel, TheirPlayer, type TheirOptions, type TheirSpec } from './theirs.js';

export interface Job {
  cell: number;
  index: number;
  seed: number;
  /** The seat our master plays: 0 moves first. */
  ourSeat: 0 | 1;
  us: number;
  them: TheirSpec;
}

export interface GameResult extends Omit<Job, 'them'> {
  them: string;
  /** 1 we won, 0.5 drawn, 0 they won; ties broken on rows, as the rules say. */
  result: number;
  ours: number;
  theirs: number;
  plies: number;
  ourMoves: number;
  theirMoves: number;
  /** Our moves timed from here: the search, the process round trip, and its start-up. */
  ourMs: number;
  /** Our searches' own milliseconds, as `serve` reports them. */
  ourSearchMs: number;
  theirMs: number;
  /** Simulations our master reported, summed. */
  ourSims: number;
  /** Their minimax nodes (the main thread's, when threaded) or MCTS root visits, summed; forced and solved moves add 0. */
  theirWork: number;
  /** Their moves the endgame solver proved. */
  theirSolved: number;
  seconds: number;
}

export interface WorkerInit {
  role: 'tile-worker';
  cacheDir: string;
  build: Build;
  binary: string;
  checkpoint: string;
  /** One config file per simulation count, by count. */
  configs: Record<number, string>;
  /** The size of their thread pool: the most any budget asks for. */
  threads: number;
  options: TheirOptions;
}

/** One game, start to finish. */
function playGame(init: WorkerInit, theirs: Awaited<ReturnType<typeof loadTheirs>>, job: Job): GameResult {
  const started = Date.now();
  const r = { ourMoves: 0, theirMoves: 0, ourMs: 0, ourSearchMs: 0, theirMs: 0, ourSims: 0, theirWork: 0, theirSolved: 0 };
  const ours = alphazeroChooser(
    { binary: init.binary, checkpoint: init.checkpoint, config: init.configs[job.us], search: 'play' },
    (a) => (r.ourSearchMs += a.milliseconds),
  );
  const them = new TheirPlayer(theirs, job.them, job.seed);
  const s = newGame(job.seed);
  let plies = 0;
  try {
    while (!s.isTerminal) {
      let action: number;
      if (s.currentPlayer === job.ourSeat) {
        const t0 = performance.now();
        const c = ours(toJSON(s));
        r.ourMs += performance.now() - t0;
        r.ourSims += c.nodes;
        r.ourMoves++;
        action = c.action;
      } else {
        const m = them.choose(s);
        r.theirMs += m.ms;
        r.theirWork += m.work;
        r.theirMoves++;
        if (m.solved) r.theirSolved++;
        action = m.action;
      }
      apply(s, action);
      plies++;
    }
  } finally {
    ours.close();
    them.free();
  }
  const o = outcome(s);
  const p0 = o === 1 ? 1 : o === -1 ? 0 : 0.5;
  return {
    ...job,
    them: specLabel(job.them),
    result: job.ourSeat === 0 ? p0 : 1 - p0,
    ours: s.scores[job.ourSeat],
    theirs: s.scores[1 - job.ourSeat],
    plies,
    ...r,
    ourMs: Math.round(r.ourMs),
    theirMs: Math.round(r.theirMs),
    seconds: (Date.now() - started) / 1000,
  };
}

/** The worker's side: load their player once, then play what it is sent. */
export async function workerMain(): Promise<void> {
  const init = workerData as WorkerInit;
  const theirs = await loadTheirs(init.cacheDir, init.build, init.threads, init.options);
  parentPort!.on('message', (job: Job | null) => {
    if (job === null) {
      parentPort!.close();
      return;
    }
    try {
      parentPort!.postMessage({ ok: true, game: playGame(init, theirs, job) });
    } catch (e) {
      parentPort!.postMessage({ ok: false, job, error: String((e as Error).stack ?? e) });
    }
  });
  parentPort!.postMessage({ ready: true });
}

export interface MatchOptions extends Omit<WorkerInit, 'role'> {
  games: number;
  seed: number;
  us: number[];
  them: TheirSpec[];
  workers: number;
  out: string;
  /** Written beside the games: what was measured, for the record. */
  header: Record<string, unknown>;
}

export interface CellSummary {
  us: number;
  them: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** (wins + draws / 2) / games, our side. */
  score: number;
  /** Wilson 95% interval on `score`. */
  low: number;
  high: number;
  /** Elo difference implied by `score`, ours minus theirs; ±Infinity at 0 or 1. */
  elo: number;
  margin: number;
  /** Our score from each seat: first to move, second. */
  bySeat: [number, number];
  ourMsPerMove: number;
  theirMsPerMove: number;
  theirWorkPerMove: number;
  /** Share of their (searched) moves the endgame solver proved. */
  theirSolvedShare: number;
}

export function summarise(us: number, them: string, games: GameResult[]): CellSummary {
  const n = games.length;
  const wins = games.filter((g) => g.result === 1).length;
  const draws = games.filter((g) => g.result === 0.5).length;
  const score = n === 0 ? NaN : (wins + draws / 2) / n;
  const z = 1.96;
  const centre = (score + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z / (1 + (z * z) / n)) * Math.sqrt((score * (1 - score)) / n + (z * z) / (4 * n * n));
  const seat = (k: 0 | 1) => {
    const g = games.filter((x) => x.ourSeat === k);
    return g.length === 0 ? NaN : g.reduce((a, x) => a + x.result, 0) / g.length;
  };
  const sum = (f: (g: GameResult) => number) => games.reduce((a, g) => a + f(g), 0);
  return {
    us,
    them,
    games: n,
    wins,
    draws,
    losses: n - wins - draws,
    score,
    low: centre - half,
    high: centre + half,
    elo: -400 * Math.log10(1 / score - 1),
    margin: sum((g) => g.ours - g.theirs) / n,
    bySeat: [seat(0), seat(1)],
    ourMsPerMove: sum((g) => g.ourMs) / sum((g) => g.ourMoves),
    theirMsPerMove: sum((g) => g.theirMs) / sum((g) => g.theirMoves),
    theirWorkPerMove: sum((g) => g.theirWork) / sum((g) => g.theirMoves - g.theirSolved),
    theirSolvedShare: sum((g) => g.theirSolved) / sum((g) => g.theirMoves),
  };
}

export function jobsFor(o: Pick<MatchOptions, 'games' | 'seed' | 'us' | 'them'>): Job[] {
  const jobs: Job[] = [];
  let cell = 0;
  for (const us of o.us) {
    for (const them of o.them) {
      for (let i = 0; i < o.games; i++) {
        jobs.push({ cell, index: i, seed: (o.seed + (i >> 1)) | 0, ourSeat: (i & 1) as 0 | 1, us, them });
      }
      cell++;
    }
  }
  // Interleave the cells, so a stopped match has played some of every one.
  return jobs.sort((a, b) => a.index - b.index || a.cell - b.cell);
}

export async function runMatch(o: MatchOptions, log: (s: string) => void): Promise<CellSummary[]> {
  const jobs = jobsFor(o);
  const cells = o.us.flatMap((us) => o.them.map((them) => ({ us, them: specLabel(them) })));
  const results: GameResult[][] = cells.map(() => []);
  mkdirSync(dirname(o.out), { recursive: true });
  const gamesPath = `${o.out}.jsonl`;
  writeFileSync(gamesPath, `${JSON.stringify({ header: o.header })}\n`);
  const init: WorkerInit = {
    role: 'tile-worker',
    cacheDir: o.cacheDir,
    build: o.build,
    binary: o.binary,
    checkpoint: o.checkpoint,
    configs: o.configs,
    threads: o.threads,
    options: o.options,
  };
  const self = fileURLToPath(import.meta.url);
  let next = 0;
  let done = 0;
  const started = Date.now();
  const failures: string[] = [];
  const progress = () => {
    const parts = cells.map((c, i) => {
      const s = summarise(c.us, c.them, results[i]);
      return `${c.us}v${c.them} ${(100 * s.score).toFixed(0)}%/${s.games}`;
    });
    const eta = done === 0 ? '' : ` eta ${Math.round(((Date.now() - started) / done) * (jobs.length - done) / 1000)}s`;
    log(`${done}/${jobs.length}${eta}  ${parts.join('  ')}`);
  };
  await Promise.all(
    Array.from({ length: Math.min(o.workers, jobs.length) }, () =>
      new Promise<void>((resolve, reject) => {
        const w = new Worker(self, { workerData: init });
        const feed = () => {
          if (next < jobs.length && failures.length === 0) w.postMessage(jobs[next++]);
          else w.postMessage(null);
        };
        w.on('message', (m: { ready?: true; ok?: boolean; game?: GameResult; job?: Job; error?: string }) => {
          if (m.ready) return feed();
          if (m.ok && m.game) {
            results[m.game.cell].push(m.game);
            appendFileSync(gamesPath, `${JSON.stringify(m.game)}\n`);
            done++;
            progress();
          } else {
            failures.push(`game ${m.job?.index} of cell ${m.job?.cell} (seed ${m.job?.seed}): ${m.error}`);
          }
          feed();
        });
        w.on('error', reject);
        w.on('exit', () => resolve());
      }),
    ),
  );
  if (failures.length > 0) throw new Error(`the match stopped:\n${failures.join('\n')}`);
  const summaries = cells.map((c, i) => summarise(c.us, c.them, results[i]));
  writeFileSync(`${o.out}.json`, `${JSON.stringify({ header: o.header, cells: summaries, seconds: (Date.now() - started) / 1000 }, null, 2)}\n`);
  return summaries;
}

export function table(cells: CellSummary[]): string {
  const rows = [
    ['ours', 'theirs', 'games', 'W-D-L', 'score', '95% CI', 'elo', 'margin', 'first/second', 'ms/mv ours', 'ms/mv theirs', 'work/mv theirs', 'solved'],
    ...cells.map((c) => [
      String(c.us),
      c.them,
      String(c.games),
      `${c.wins}-${c.draws}-${c.losses}`,
      `${(100 * c.score).toFixed(1)}%`,
      `${(100 * c.low).toFixed(1)}–${(100 * c.high).toFixed(1)}%`,
      Number.isFinite(c.elo) ? `${c.elo >= 0 ? '+' : ''}${c.elo.toFixed(0)}` : c.elo > 0 ? '+inf' : '-inf',
      `${c.margin >= 0 ? '+' : ''}${c.margin.toFixed(1)}`,
      `${(100 * c.bySeat[0]).toFixed(0)}%/${(100 * c.bySeat[1]).toFixed(0)}%`,
      c.ourMsPerMove.toFixed(0),
      c.theirMsPerMove.toFixed(0),
      c.theirWorkPerMove.toFixed(0),
      `${(100 * c.theirSolvedShare).toFixed(1)}%`,
    ]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((x, i) => x.padStart(widths[i])).join('  ')).join('\n');
}

export const configPath = (dir: string, sims: number) => join(dir, `config-${sims}.json`);
