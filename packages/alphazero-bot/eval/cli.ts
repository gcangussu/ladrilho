/**
 * The lanes' entry point, bundled to `node_modules/.alphazero/cli.mjs` by
 * `tools/bundle.mjs` and run by the package's scripts ([Z11-4]).
 */

import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { DISPLAYS_FIXTURE, LAYOUT, displayFixture, displayLayout } from './augment.js';
import { writeAtomic, writeJson } from './files.js';
import { recordCorpus } from './latency.js';
import {
  gateCommand,
  initRun,
  latencyLane,
  milestoneCommand,
  parseFrom,
  parseSet,
  throughputLane,
  trainLoop,
  type Changeable,
} from './loop.js';
import { CORPUS } from './paths.js';
import { seriesWorker } from './series.js';
import { table } from './stop-rule-simulation.js';

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
}

function workers(args: string[]): number {
  const w = option(args, 'workers');
  const n = w === undefined ? Math.max(1, Math.floor(cpus().length / 2)) : Number(w);
  if (!Number.isInteger(n) || n < 1) throw new Error('--workers is a whole number');
  return n;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const [command, ...rest] = args;
  const run = (): string => {
    const r = option(rest, 'run');
    if (r === undefined) throw new Error(`${command} needs --run <name>`);
    return r;
  };
  switch (command) {
    case 'train':
      if (rest[0] === 'init') {
        const from = option(rest, 'from');
        const augment = option(rest, 'augment');
        if (augment !== undefined && augment !== 'none' && augment !== 'displays') {
          throw new Error('--augment takes none or displays');
        }
        const set: Partial<Record<Changeable, number>> = {};
        rest.forEach((a, i) => {
          if (a !== '--set') return;
          const v = rest[i + 1];
          if (v === undefined || v.startsWith('--')) throw new Error('--set needs <setting>=<number>');
          const [k, n] = parseSet(v);
          set[k] = n;
        });
        const gate = option(rest, 'gate');
        if (gate !== undefined && gate !== 'end' && gate !== 'off') throw new Error('--gate takes end or off');
        return initRun(option(rest, 'run') ?? '', from === undefined ? undefined : parseFrom(from), augment, set, gate);
      }
      {
        const until = option(rest, 'until');
        const override = option(rest, 'override');
        return trainLoop(run(), {
          workers: workers(rest),
          ...(override === undefined ? {} : { override }),
          ...(until === undefined ? {} : { until: Number(until) }),
        });
      }
    case 'latency':
      return latencyLane(run());
    case 'throughput':
      return throughputLane(run());
    case 'milestone':
      return milestoneCommand(resolve(rest[0] ?? ''), workers(rest));
    case 'gate':
      return gateCommand(resolve(rest[0] ?? ''), workers(rest));
    case 'stop-simulation':
      process.stdout.write(`${table(Number(option(rest, 'runs') ?? 20000))}\n`);
      return;
    case 'latency-corpus': {
      const c = recordCorpus();
      writeAtomic(CORPUS, c.bytes);
      process.stdout.write(`latency/corpus.bin: ${c.positions} positions from ${c.games} games\n`);
      return;
    }
    case 'augment-fixtures': {
      writeJson(LAYOUT, displayLayout());
      writeJson(DISPLAYS_FIXTURE, displayFixture());
      process.stdout.write('train/layout.json and train/tests/fixtures/displays.json written from the engine\n');
      return;
    }
    case 'series-worker':
      return seriesWorker();
    default:
      throw new Error(
        'usage: train init --run <name> [--from <run>:<generation>] [--augment none|displays] [--set <setting>=<n>]… [--gate end|off] | train --run <name> [--override "<reason>"] | latency --run <name> | ' +
          'throughput --run <name> | milestone <checkpoint> | gate <checkpoint> | stop-simulation | latency-corpus | ' +
          'augment-fixtures',
      );
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
