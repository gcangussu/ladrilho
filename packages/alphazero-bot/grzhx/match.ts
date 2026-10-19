/**
 * `grzhx play` ([G13-31] to [G13-42]): every pair of an `--us` budget and a
 * `--them` budget, the same paired seeds in every cell, `--workers` games at
 * once, a line per game as it finishes, and the summary from those lines.
 *
 * A worker holds one host for its life, configured with every cell, and
 * spawns one `serve` per game. Games run as concurrent async tasks in this
 * process: the searching happens in the child processes.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { disagreementRecord, Disagreement, playGame, type Move, type Mover } from './game.js';
import { Host, Serve, type HostPaths } from './processes.js';
import { budgetLabel, ourConfig, type BudgetSpec, type OurResolved } from './settings.js';
import { summarise, table, type CellInfo, type GameLine, type Summary } from './summary.js';

export interface Cell extends CellInfo {
  usBudget: BudgetSpec;
  themBudget: BudgetSpec;
  /** The config file `serve` reads for this cell. */
  config: string;
}

export interface Job {
  cell: number;
  seed: number;
  ourSeat: number;
}

/**
 * [G13-31], [G13-32]: every cell plays seeds `seed + k`, each once from each
 * seat, `games` per cell rounded up to even. The order is fixed; which worker
 * plays a job changes nothing about its game.
 */
export function jobsFor(cells: number, games: number, seed: number): Job[] {
  const pairs = Math.ceil(games / 2);
  const out: Job[] = [];
  for (let cell = 0; cell < cells; cell++) {
    for (let k = 0; k < pairs; k++) for (const ourSeat of [0, 1]) out.push({ cell, seed: seed + k, ourSeat });
  }
  return out;
}

/** [G13-38]: ten minutes a move, or the move's clock plus a minute if that is longer. */
export function moveTimeout(budget: BudgetSpec): number {
  const clock = budget?.kind === 'ms' ? budget.n + 60_000 : 0;
  return Math.max(10 * 60_000, clock);
}

export function cellsFor(us: readonly BudgetSpec[], them: readonly BudgetSpec[], outDir: string): Cell[] {
  const cells: Cell[] = [];
  for (const u of us) {
    for (const t of them) {
      const cell = cells.length;
      cells.push({ cell, us: budgetLabel(u), them: budgetLabel(t), usBudget: u, themBudget: t, config: join(outDir, `cell-${cell}.config.json`) });
    }
  }
  return cells;
}

/** The host's `configure` cells: their budget and the settings given ([G13-25]). */
export function hostCells(cells: readonly Cell[], theirSettings: Record<string, number>): Record<string, unknown>[] {
  return cells.map((c) => ({
    id: c.cell,
    budget: c.themBudget === null ? { kind: 'sims', n: null } : c.themBudget,
    settings: theirSettings,
  }));
}

export interface MatchOptions {
  cells: Cell[];
  ours: OurResolved;
  theirSettings: Record<string, number>;
  hostPaths: HostPaths;
  binary: string;
  games: number;
  seed: number;
  workers: number;
  out: string;
  header: Record<string, unknown>;
  log: (s: string) => void;
  /** For tests: what starts a host and a `serve`. */
  start?: { host: (p: HostPaths) => Host; serve: (cell: Cell) => Serve };
}

export interface MatchResult {
  summary: Summary;
  stopped: boolean;
  error: Error | null;
}

/** Our player as a mover: `serve`'s answer, held to our engine's rules. */
function ourMover(serve: Serve, timeoutMs: number, where: (ply: number) => string): Mover {
  return async (position, ply) => {
    const a = await serve.choose(position, timeoutMs, where(ply));
    if (!position.legalActions.includes(a.action)) throw new Error(`${where(ply)}: our player chose ${a.action}, which our engine refuses`);
    const move: Move = { side: 'ours', action: a.action, simulations: a.simulations, ms: a.searchMs, proofMs: a.proofMs, value: a.value };
    return move;
  };
}

export async function runMatch(o: MatchOptions): Promise<MatchResult> {
  const jsonl = `${o.out}.jsonl`;
  const reports = `${o.out}.disagreements`;
  mkdirSync(dirname(jsonl), { recursive: true });
  for (const c of o.cells) mkdirSync(dirname(c.config), { recursive: true });
  for (const c of o.cells) writeFileSync(c.config, `${JSON.stringify(ourConfig(o.ours, c.usBudget), null, 2)}\n`);
  writeFileSync(jsonl, `${JSON.stringify({ kind: 'header', ...o.header })}\n`);

  const jobs = jobsFor(o.cells.length, o.games, o.seed);
  let next = 0;
  let stopped = false;
  let error: Error | null = null;
  const live = new Set<{ close(): void }>();
  const stop = (e: Error): void => {
    if (stopped) return;
    stopped = true;
    error = e;
    o.log(`stopping: ${e.message}`);
    for (const p of live) p.close();
  };
  const startHost = o.start?.host ?? ((p: HostPaths) => new Host(p));
  const startServe = o.start?.serve ?? ((c: Cell) => new Serve(o.binary, o.ours.checkpointPath, c.config, c.usBudget?.kind === 'ms' ? c.usBudget.n : null));
  let done = 0;

  const worker = async (): Promise<void> => {
    const host = startHost(o.hostPaths);
    live.add(host);
    try {
      const configured = await host.ask<{ refused?: unknown; message?: string }>({ type: 'configure', cells: hostCells(o.cells, o.theirSettings) }, 10 * 60_000, 'configure');
      if (configured.refused !== undefined) throw new Error(`their library refused cell ${String(configured.refused)}'s settings: ${configured.message}`);
      while (!stopped && next < jobs.length) {
        const job = jobs[next++];
        const cell = o.cells[job.cell];
        const serve = startServe(cell);
        live.add(serve);
        const where = (ply: number): string => `cell ${job.cell} (${cell.us} v ${cell.them}), seed ${job.seed}, our seat ${job.ourSeat}, ply ${ply}`;
        const timeout = Math.max(moveTimeout(cell.usBudget), moveTimeout(cell.themBudget));
        let line: GameLine;
        try {
          const record = await playGame({
            host, cell: job.cell, matchSeed: o.seed, seed: job.seed, ourSeat: job.ourSeat,
            ours: ourMover(serve, moveTimeout(cell.usBudget), where), theirs: null, timeoutMs: timeout,
          });
          line = { kind: 'game', cell: job.cell, seed: job.seed, ourSeat: job.ourSeat, record };
        } catch (e) {
          if (!(e instanceof Disagreement)) throw e;
          const report = join(reports, `${job.cell}-${job.seed}-${job.ourSeat}.json`);
          mkdirSync(reports, { recursive: true });
          writeFileSync(report, `${JSON.stringify({ ...disagreementRecord(job, e), cell: job.cell, matchSeed: o.seed, pin: o.header.pin }, null, 2)}\n`);
          line = { kind: 'game', cell: job.cell, seed: job.seed, ourSeat: job.ourSeat, disagreement: { ply: e.ply, comparison: e.comparison, report } };
          o.log(`${where(e.ply)}: disagreement, ${e.comparison}; the deal pair is left out`);
        } finally {
          serve.close();
          live.delete(serve);
        }
        if (stopped) return;
        appendFileSync(jsonl, `${JSON.stringify(line)}\n`);
        done++;
        if (done % 10 === 0 || done === jobs.length) o.log(`${done}/${jobs.length} games`);
      }
    } catch (e) {
      stop(e instanceof Error ? e : new Error(String(e)));
    } finally {
      host.close();
      live.delete(host);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.workers, jobs.length)) }, worker));
  const summary = summarise(readFileSync(jsonl, 'utf8'), o.cells, stopped);
  writeFileSync(`${o.out}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(table(summary));
  return { summary, stopped, error };
}
