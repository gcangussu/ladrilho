/**
 * The commands of spec 0010: `check` runs invented games through both
 * engines [C10-20]; `replay` re-runs a report [C10-24]. Exit `0` for no
 * disagreement, `1` for one, `2` for a failure of the tool itself [C10-21].
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Engine } from './engine.js';
import { type Start, ToolError } from './game.js';
import { POLICY_NAMES } from './policies.js';
import { DEFAULT_OUT, type Report, type Totals, replayReport, run, vectorStart, writeReport } from './run.js';

const USAGE = `usage:
  check [--games N] [--seed S] [--steer mix|${POLICY_NAMES.join('|')}]
        [--start new|short:K|vector:NAME] [--cap PLIES] [--out DIR]
  replay REPORT.json`;

/**
 * A path as the caller meant it. `pnpm -F crosscheck …` runs the script in the
 * package directory and records where it was invoked in `INIT_CWD`.
 */
function fromCaller(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

function parseStart(text: string): Start {
  if (text === 'new') return { kind: 'new' };
  const short = /^short:(\d+)$/.exec(text);
  if (short) {
    const max = Number(short[1]);
    if (max < 1 || max > 80) throw new ToolError('short:K takes K from 1 to 80');
    return { kind: 'short', max };
  }
  const vector = /^vector:(.+)$/.exec(text);
  if (vector) return { kind: 'vector', name: vector[1], state: vectorStart(vector[1]) };
  throw new ToolError(`--start ${text}: expected new, short:K or vector:NAME`);
}

function integer(flag: string, text: string | undefined): number {
  const n = Number(text);
  if (text === undefined || !Number.isSafeInteger(n) || n < 0) throw new ToolError(`${flag} takes a whole number`);
  return n;
}

function summary(t: Totals, pliesPerSecond: number): string {
  return [
    `  ended by a row ${t.endedByRow}, by exhaustion ${t.endedByExhaustion}, capped ${t.capped}`,
    `  highest round ${t.maxRound}; lid recycles ${t.recycles}; short deals ${t.shortDeals}`,
    `  floors at seven or more ${t.floorsSeven}; past seven ${t.floorsPastSeven}`,
    `  ${Math.round(pliesPerSecond)} plies per second`,
  ].join('\n');
}

async function check(deps: Deps, args: string[]): Promise<number> {
  const opts = { games: 1000, seed: 1, steer: 'mix', start: 'new', cap: 400, out: DEFAULT_OUT };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    switch (flag) {
      case '--games': opts.games = integer(flag, value); break;
      case '--seed': opts.seed = integer(flag, value); break;
      case '--cap': opts.cap = integer(flag, value); break;
      case '--steer': opts.steer = value ?? ''; break;
      case '--start': opts.start = value ?? ''; break;
      case '--out': opts.out = fromCaller(value ?? ''); break;
      default: throw new ToolError(`unknown option ${flag}\n${USAGE}`);
    }
  }
  if (opts.steer !== 'mix' && !POLICY_NAMES.includes(opts.steer)) {
    throw new ToolError(`--steer ${opts.steer}: expected mix or one of ${POLICY_NAMES.join(', ')}`);
  }
  const result = await run(deps.engine, deps.checker, {
    games: opts.games,
    seed: opts.seed,
    steer: opts.steer,
    start: parseStart(opts.start),
    startText: opts.start,
    cap: opts.cap,
  });
  const { totals, report } = result;
  if (report === null) {
    console.log(`no disagreement in ${totals.games} games (${totals.plies} plies)`);
    console.log(summary(totals, result.pliesPerSecond));
    return 0;
  }
  const path = writeReport(opts.out, report);
  console.log(`disagreement in game ${report.run.game} at record ${report.at}, after ${totals.games} agreeing games`);
  for (const f of report.fields) {
    console.log(`  ${f.path}: typescript ${JSON.stringify(f.typescript)}, rust ${JSON.stringify(f.rust)}`);
  }
  console.log(`report: ${path}`);
  return 1;
}

async function replayCommand(deps: Deps, args: string[]): Promise<number> {
  if (args.length !== 1) throw new ToolError(USAGE);
  const report = JSON.parse(readFileSync(fromCaller(args[0]), 'utf8')) as Report;
  const d = await replayReport(deps.engine, deps.checker, report);
  if (d === null) {
    console.log('no disagreement: the report no longer reproduces');
    return 0;
  }
  console.log(`disagreement at record ${d.at}`);
  for (const f of d.fields) {
    console.log(`  ${f.path}: typescript ${JSON.stringify(f.typescript)}, rust ${JSON.stringify(f.rust)}`);
  }
  return 1;
}

/** The engine to drive and the checker binary to replay on. */
export interface Deps {
  engine: Engine;
  checker: string;
}

/** Runs one command and returns its exit status [C10-21]. */
export async function main(argv: string[], deps: Deps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'check') return await check(deps, rest);
    if (command === 'replay') return await replayCommand(deps, rest);
    throw new ToolError(USAGE);
  } catch (e) {
    console.error(e instanceof ToolError ? e.message : e);
    return 2;
  }
}

