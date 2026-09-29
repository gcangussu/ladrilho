/**
 * A run [C10-20]: games `0` to `N − 1` in order, each invented and played on
 * the TypeScript engine, replayed on the crate by the checker, and compared
 * record by record. It stops at the first game that disagrees.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalState } from 'engine';
import { Checker } from './checker.js';
import type { Engine } from './engine.js';
import { type GameInput, type GameOptions, type GameStats, ToolError, invent, replay } from './game.js';
import { type Difference, compareRecords, describe, equalWords } from './record.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = HERE.includes('node_modules') ? join(HERE, '..', '..') : join(HERE, '..');
export const VECTOR_DIR = join(PACKAGE, '..', 'engine', 'test', 'vectors');

/** Where two engines' records for one game first differ, if anywhere. */
export interface Disagreement {
  at: number;
  fields: Difference[];
  said: { typescript: Record<string, number | number[]> | null; rust: Record<string, number | number[]> | null };
  before?: Record<string, number | number[]>;
}

/** Compares two record lists [C10-11]. `null` when they agree throughout. */
export function firstDisagreement(ts: Uint32Array[], rust: Uint32Array[]): Disagreement | null {
  const n = Math.max(ts.length, rust.length);
  for (let i = 0; i < n; i++) {
    const a = ts[i];
    const b = rust[i];
    if (a !== undefined && b !== undefined && equalWords(a, b)) continue;
    const fields: Difference[] =
      a === undefined || b === undefined
        ? [{ path: '(record)', typescript: a === undefined ? null : 1, rust: b === undefined ? null : 1 }]
        : compareRecords(a, b);
    const out: Disagreement = {
      at: i,
      fields,
      said: {
        typescript: a === undefined ? null : describe(a),
        rust: b === undefined ? null : describe(b),
      },
    };
    if (i > 0) out.before = describe(ts[i - 1]);
    return out;
  }
  return null;
}

export interface Totals {
  games: number;
  plies: number;
  endedByRow: number;
  endedByExhaustion: number;
  capped: number;
  maxRound: number;
  recycles: number;
  shortDeals: number;
  floorsSeven: number;
  floorsPastSeven: number;
}

function emptyTotals(): Totals {
  return {
    games: 0,
    plies: 0,
    endedByRow: 0,
    endedByExhaustion: 0,
    capped: 0,
    maxRound: 0,
    recycles: 0,
    shortDeals: 0,
    floorsSeven: 0,
    floorsPastSeven: 0,
  };
}

function add(t: Totals, s: GameStats): void {
  t.games++;
  t.plies += s.plies;
  t.endedByRow += Number(s.endedByRow);
  t.endedByExhaustion += Number(s.endedByExhaustion);
  t.capped += Number(s.capped);
  t.maxRound = Math.max(t.maxRound, s.maxRound);
  t.recycles += s.recycles;
  t.shortDeals += s.shortDeals;
  t.floorsSeven += s.floorsSeven;
  t.floorsPastSeven += s.floorsPastSeven;
}

export interface RunOptions extends GameOptions {
  games: number;
  seed: number;
  /** The `--start` text, kept for the report. */
  startText: string;
}

/** The report of [C10-23]. */
export interface Report extends GameInput {
  schema: 1;
  commit: string;
  run: { seed: number; game: number; steer: string; start: string; cap: number };
  at: number;
  fields: Difference[];
  said: Disagreement['said'];
  before?: Record<string, number | number[]>;
}

export interface RunResult {
  totals: Totals;
  /** Plies per second over the whole run. Never written to a report [C10-22]. */
  pliesPerSecond: number;
  report: Report | null;
}

/** The repository's HEAD, with `-dirty` when the tree was not clean [C10-23]. */
export function commitName(): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PACKAGE, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: PACKAGE, encoding: 'utf8' }).trim();
    return dirty === '' ? head : `${head}-dirty`;
  } catch {
    return 'unknown';
  }
}

/** Reads the `initial` of a committed position vector, in place [C10-16]. */
export function vectorStart(name: string): CanonicalState {
  const file = name.endsWith('.json') ? name : `${name}.json`;
  const v = JSON.parse(readFileSync(join(VECTOR_DIR, file), 'utf8')) as { kind: string; initial: CanonicalState };
  if (v.kind !== 'position') throw new ToolError(`${file} is not a position vector`);
  return v.initial;
}

/** Runs games `0 .. games − 1` in order and stops at the first disagreement. */
export async function run(engine: Engine, checkerPath: string, options: RunOptions): Promise<RunResult> {
  const totals = emptyTotals();
  const checker = new Checker(checkerPath);
  const started = performance.now();
  let report: Report | null = null;
  try {
    for (let g = 0; g < options.games; g++) {
      const played = invent(engine, options.seed, g, options);
      const rust = await checker.replay(g, played.input);
      const d = firstDisagreement(played.records, rust);
      if (d === null) {
        add(totals, played.stats);
        continue;
      }
      // Cut the input to what reaches the disagreeing record [C10-23].
      const input: GameInput = {
        start: played.input.start,
        shuffles: played.input.shuffles,
        actions: played.input.actions.slice(0, d.at),
        probes: played.input.probes.slice(0, d.at + 1),
      };
      input.shuffles = trimShuffles(input.shuffles, d);
      report = {
        schema: 1,
        commit: commitName(),
        run: { seed: options.seed, game: g, steer: played.policy, start: options.startText, cap: options.cap },
        ...input,
        ...d,
      };
      break;
    }
  } finally {
    await checker.close();
  }
  const seconds = (performance.now() - started) / 1000;
  return { totals, pliesPerSecond: seconds > 0 ? totals.plies / seconds : 0, report };
}

/**
 * The shuffles the cut game consumes — no order past the disagreeing record
 * [C10-23]. Each side's `shufflesUsed` there says how many it took; the report
 * keeps as many as the hungrier side did, so both replay exactly as they ran.
 */
function trimShuffles(shuffles: number[][], d: Disagreement): number[][] {
  const used = [d.said.typescript, d.said.rust]
    .map((r) => r?.shufflesUsed)
    .filter((n): n is number => typeof n === 'number');
  return used.length === 0 ? shuffles : shuffles.slice(0, Math.max(...used));
}

/** Re-runs a report from its game input, never its seed [C10-24]. */
export async function replayReport(
  engine: Engine,
  checkerPath: string,
  report: GameInput & { run: { game: number } },
): Promise<Disagreement | null> {
  const checker = new Checker(checkerPath);
  try {
    const rust = await checker.replay(report.run.game, report);
    return firstDisagreement(replay(engine, report), rust);
  } finally {
    await checker.close();
  }
}

export function writeReport(dir: string, report: Report): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `crosscheck-${report.run.seed}-${report.run.game}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export const DEFAULT_OUT = join(PACKAGE, 'found');
