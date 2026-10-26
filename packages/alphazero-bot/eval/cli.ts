/**
 * The lanes' entry point, bundled to `node_modules/.alphazero/cli.mjs` by
 * `tools/bundle.mjs` and run by the package's scripts ([Z11-4]).
 */

import { cpus } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DISPLAYS_FIXTURE, LAYOUT, displayFixture, displayLayout } from './augment.js';
import { writeAtomic, writeJson } from './files.js';
import { recordCorpus } from './latency.js';
import { trainer } from './crate.js';
import {
  anchorsAdd,
  anchorsInit,
  anchorsRate,
  gateCommand,
  initRun,
  latencyLane,
  milestoneCommand,
  parseFrom,
  parseSet,
  poolInit,
  shipCommand,
  shipPin,
  STOP_PATIENCE,
  throughputLane,
  trainLoop,
  type Changeable,
} from './loop.js';
import { anchorsExist, readAnchors } from './anchors.js';
import { CORPUS } from './paths.js';
import { seriesWorker } from './series.js';
import { POOL, readSeed } from './pool.js';
import { patienceTable, poolTable, shipTable, table } from './stop-rule-simulation.js';

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
        const yardstick = option(rest, 'yardstick');
        if (yardstick !== undefined && yardstick !== 'ladder' && yardstick !== 'pool' && yardstick !== 'anchors') {
          throw new Error('--yardstick takes ladder, pool or anchors');
        }
        // [Z11-90]: the patience to decide by, on any yardstick, as typed: `0x10` is no patience.
        const patience = option(rest, 'patience');
        if (patience !== undefined && !/^[1-9]\d*$/.test(patience)) {
          throw new Error(`--patience takes a whole number from 1, not ${patience}`);
        }
        return initRun(
          option(rest, 'run') ?? '',
          from === undefined ? undefined : parseFrom(from),
          augment,
          set,
          gate,
          yardstick,
          patience === undefined ? undefined : Number(patience),
        );
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
    case 'panel': {
      // [Z11-83]: the value against the measured win probability, by round.
      if (rest[0] === undefined || rest[0].startsWith('--')) throw new Error('usage: panel <checkpoint> [--against <checkpoint>] [--json <out>]');
      const against = option(rest, 'against');
      const json = option(rest, 'json');
      return trainer([
        'panel',
        resolve(rest[0]),
        ...(against === undefined ? [] : ['--against', resolve(against)]),
        ...(json === undefined ? [] : ['--json', resolve(json)]),
      ]);
    }
    case 'gate':
      return gateCommand(resolve(rest[0] ?? ''), workers(rest));
    case 'pool': {
      if (rest[0] !== 'init') throw new Error('usage: pool init --members <run>:<g>,… --games <n> [--simulations 200]');
      const members = (option(rest, 'members') ?? '').split(',').filter((m) => m !== '').map(parseFrom);
      const games = Number(option(rest, 'games'));
      const simulations = Number(option(rest, 'simulations') ?? 200);
      if (!Number.isInteger(games) || games < 2) throw new Error('--games is a whole number of at least 2');
      if (!Number.isInteger(simulations) || simulations < 1) throw new Error('--simulations is a whole number');
      return poolInit(members, games, simulations, workers(rest));
    }
    case 'anchors': {
      // [Z11-84]: made once, added to by hand, and a logged milestone rated against them.
      const sub = rest[0];
      if (sub === 'init') {
        const members = (option(rest, 'members') ?? '').split(',').filter((m) => m !== '').map(parseFrom);
        const pinText = option(rest, 'pin') ?? '';
        const pm = /^([^:=]+):(\d+)=(-?\d+(?:\.\d+)?)$/.exec(pinText);
        if (pm === null) throw new Error('--pin takes <run>:<generation>=<rating>');
        const games = Number(option(rest, 'games'));
        const simulations = Number(option(rest, 'simulations') ?? 200);
        const perMember = Number(option(rest, 'games-per-member') ?? 800);
        for (const [k, v] of [['--games', games], ['--simulations', simulations], ['--games-per-member', perMember]] as const) {
          if (!Number.isInteger(v) || v < 2) throw new Error(`${k} is a whole number of at least 2`);
        }
        return anchorsInit(members, { run: pm[1], generation: Number(pm[2]), rating: Number(pm[3]) }, games, simulations, perMember, workers(rest));
      }
      if (sub === 'add') {
        const games = Number(option(rest, 'games'));
        if (!Number.isInteger(games) || games < 2) throw new Error('--games is a whole number of at least 2');
        return anchorsAdd(parseFrom(rest[1] ?? ''), games, workers(rest));
      }
      if (sub === 'rate') return anchorsRate(resolve(rest[1] ?? ''), workers(rest));
      throw new Error('usage: anchors init --members <run>:<g>,… --pin <run>:<g>=<rating> --games <n> | anchors add <run>:<g> --games <n> | anchors rate <checkpoint>');
    }
    case 'ship': {
      // [0012 T12-34], [T12-35].
      if (rest[0] === 'pin') {
        const reason = option(rest, 'reason');
        if (reason === undefined) throw new Error('usage: ship pin <run>:<generation> --reason "…"');
        return shipPin(parseFrom(rest[1] ?? ''), reason);
      }
      return shipCommand(resolve(rest[0] ?? ''), workers(rest));
    }
    case 'stop-simulation':
      process.stdout.write(`${table(Number(option(rest, 'runs') ?? 20000))}\n\n`);
      // The committed pool's own count, so the spec's table is what this prints ([Z11-56]).
      const poolGames = option(rest, 'pool-games') ?? (existsSync(POOL) ? String(readSeed().gamesPerMember) : '300');
      process.stdout.write(`${poolTable(Number(option(rest, 'runs') ?? 20000), Number(poolGames))}\n\n`);
      // [Z11-90]: the anchors' own count and the patience new runs take.
      const anchorGames = anchorsExist() ? readAnchors().gamesPerMember : 800;
      process.stdout.write(`${patienceTable(Number(option(rest, 'runs') ?? 20000), anchorGames, Number(option(rest, 'patience') ?? STOP_PATIENCE))}\n\n`);
      // [0012 T12-34]: the ship match, 4 000 matches a row.
      process.stdout.write(`${shipTable(Number(option(rest, 'ship-runs') ?? 4000))}\n`);
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
        'usage: train init --run <name> [--from <run>:<generation>] [--augment none|displays] [--set <setting>=<n>]… [--gate end|off] [--yardstick ladder|pool|anchors] [--patience <n>] | train --run <name> [--override "<reason>"] | latency --run <name> | ' +
          'throughput --run <name> | milestone <checkpoint> | panel <checkpoint> [--against <checkpoint>] | gate <checkpoint> | stop-simulation | latency-corpus | ' +
          'augment-fixtures | pool init --members <run>:<g>,… --games <n> | anchors init|add|rate … | ship <checkpoint> | ship pin <run>:<g> --reason "…"',
      );
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
