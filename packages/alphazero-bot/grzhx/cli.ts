/**
 * `pnpm -F alphazero-bot grzhx <command>`: our master against generation 2300
 * of grzhx/azul-alpha-zero (spec 0013). See grzhx/README.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism, cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256 } from '../eval/files.js';
import { buildRelease } from '../eval/crate.js';
import { binary, RUNS } from '../eval/paths.js';
import { buildLibrary, type BuildOption } from './build.js';
import { cellsFor, hostCells, runMatch } from './match.js';
import {
  checkTheirBudgets, defaultWorkers, parseBudgets, parseSets, parseTheirs, resolveOurs, SettingError,
  type BudgetSpec, type OurResolved, type TheirGiven,
} from './settings.js';
import { Host } from './processes.js';
import { assetPath, checkUpdates, defaultCacheDir, ensureRelease, fetchRelease, makePin, PIN_PATH, readPin, repoDir, writePin, type Pin } from './release.js';
import { verify, verifyCells } from './verify.js';

/** The cache fetched and their library built, once, before any host starts. */
async function prepare(cache: string, pin: Pin, options: BuildOption[]) {
  await ensureRelease(cache, pin, log);
  const built = buildLibrary(cache, pin, options, log);
  const hostPaths = {
    repo: repoDir(cache),
    library: built.library,
    actor: assetPath(cache, 'azul-generation-2300.pt'),
    actorSha256: pin.assets['azul-generation-2300.pt'],
  };
  return { built, hostPaths };
}

/** The cache fetched, their library built, and a host started on them. */
async function startHost(cache: string, pin: Pin): Promise<{ host: Host; library: string; cxxFlags: string[] }> {
  const { built, hostPaths } = await prepare(cache, pin, []);
  return { host: new Host(hostPaths), library: built.library, cxxFlags: built.cxxFlags };
}

interface Resolved {
  us: BudgetSpec[];
  them: BudgetSpec[];
  ours: OurResolved;
  theirs: TheirGiven;
}

/** [G13-21] to [G13-25]: every setting parsed and checked before anything is built or played. */
function resolveSettings(v: { us?: string; them?: string; 'us-set'?: string[]; 'them-set'?: string[] }): Resolved {
  const us = parseBudgets(v.us, 'us');
  const them = parseBudgets(v.them, 'them');
  const ours = resolveOurs(parseSets(v['us-set'] ?? [], 'us'));
  const theirs = parseTheirs(parseSets(v['them-set'] ?? [], 'them'));
  checkTheirBudgets(them, theirs);
  // [G13-34]: a checkpoint without its parity file is refused before any game.
  const parity = ours.checkpointPath.replace(/\.bin$/, '.parity');
  if (!existsSync(parity)) throw new SettingError(`no parity file beside ${ours.checkpointPath}, so it is not loaded ([0011 Z11-13])`);
  return { us, them, ours, theirs };
}

function machine() {
  return { cpu: cpus()[0]?.model ?? 'unknown', logicalCores: availableParallelism(), os: `${platform()} ${release()}` };
}

const USAGE = `usage: pnpm -F alphazero-bot grzhx <command> [options]

commands
  fetch             clone their repository at the pin and download the release into the cache
  check-updates     ask GitHub whether their branch or release moved; writes nothing
  pin <commit> <tag>  rewrite grzhx/pinned.json from a fresh fetch (a deliberate act)
  build             build their library into the cache

options
  --cache <dir>     where their files are kept (default ~/.cache/azul-grzhx)
`;

const log = (s: string): void => void process.stderr.write(`${s}\n`);

async function main(): Promise<void> {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cache: { type: 'string' },
      games: { type: 'string' },
      seed: { type: 'string', default: '1' },
      us: { type: 'string' },
      them: { type: 'string' },
      'us-set': { type: 'string', multiple: true },
      'them-set': { type: 'string', multiple: true },
      workers: { type: 'string' },
      out: { type: 'string' },
      'no-build': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (command === undefined || v.help || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const cache = resolve(v.cache ?? defaultCacheDir());
  switch (command) {
    case 'fetch': {
      await fetchRelease(cache, readPin(), log);
      return;
    }
    case 'check-updates': {
      const changed = await checkUpdates(readPin());
      if (changed.length === 0) {
        process.stdout.write('up to date\n');
        return;
      }
      for (const c of changed) process.stdout.write(`${c}\n`);
      process.exitCode = 1;
      return;
    }
    case 'pin': {
      const [commit, tag] = rest;
      if (commit === undefined || tag === undefined) throw new Error('pin takes <commit> <tag>');
      let old = null;
      try {
        old = readPin();
      } catch {
        /* the first pin */
      }
      const { pin, changes } = await makePin(old?.repository ?? 'grzhx/azul-alpha-zero', commit, tag, old);
      writePin(pin);
      for (const c of changes) process.stdout.write(`${c}\n`);
      process.stdout.write(`wrote ${PIN_PATH}: ${Object.keys(pin.blobs).length} blobs, ${Object.keys(pin.assets).length} assets\n`);
      return;
    }
    case 'build': {
      const pin = readPin();
      await ensureRelease(cache, pin, log);
      const b = buildLibrary(cache, pin, [], log);
      process.stdout.write(`${b.library}${b.cxxFlags.length ? `  (with ${b.cxxFlags.join(' ')})` : ''}\n`);
      return;
    }
    case 'info':
    case 'play': {
      const r = resolveSettings(v);
      const pin = readPin();
      const bin = v['no-build'] ? binary('release') : buildRelease();
      if (!existsSync(bin)) throw new Error(`no binary at ${bin}: drop --no-build`);
      const { built, hostPaths } = await prepare(cache, pin, r.theirs.build);
      const out = resolve(v.out ?? resolve(RUNS, 'grzhx', new Date().toISOString().replace(/[:.]/g, '-')));
      const cells = cellsFor(r.us, r.them, `${out}.configs`);
      // One host to hear their versions and have their library judge every cell ([G13-25]).
      const probe = new Host(hostPaths);
      let hello: Record<string, unknown>;
      let configured: { refused?: unknown; message?: string; cells?: { id: number; settings: Record<string, number>; source: Record<string, string> }[] };
      try {
        hello = await probe.ask({ type: 'hello' }, 600_000, 'hello');
        configured = await probe.ask({ type: 'configure', cells: hostCells(cells, r.theirs.settings) }, 600_000, 'configure');
      } finally {
        probe.close();
      }
      if (configured.refused !== undefined) throw new SettingError(`their library refused cell ${String(configured.refused)}: ${configured.message}`);
      const theirCells = configured.cells!;
      const torchThreads = theirCells[0]?.settings.torchThreads ?? 1;
      const threads = Math.max(...theirCells.map((c) => c.settings.threads ?? 1));
      const clocks = [...r.us, ...r.them].some((b) => b?.kind === 'ms');
      const reasons = [
        ...(r.us.some((b) => b?.kind === 'ms') ? ['our clock'] : []),
        ...(r.them.some((b) => b?.kind === 'ms') ? ["their clock, whose evaluation cache depends on timing ([G13-28])"] : []),
        ...(torchThreads !== 1 ? ['torchThreads above 1'] : []),
      ];
      const settings = {
        ours: { settings: r.ours.settings, source: r.ours.source, defaultSimulations: r.ours.defaultSimulations },
        theirs: theirCells.map((c) => ({ cell: c.id, us: cells[c.id].us, them: cells[c.id].them, settings: c.settings, source: c.source })),
      };
      if (command === 'info') {
        process.stdout.write(`${JSON.stringify({ ...settings, build: { options: built.options, cxxFlags: built.cxxFlags }, versions: hello }, null, 2)}\n`);
        return;
      }
      const header = {
        arguments: process.argv.slice(2),
        ours: { checkpoint: r.ours.settings.checkpoint, sha256: sha256(readFileSync(r.ours.checkpointPath)) },
        pin: { repository: pin.repository, commit: pin.commit, release: pin.release, assets: pin.assets },
        build: { options: built.options, cxxFlags: built.cxxFlags },
        versions: hello,
        machine: machine(),
        repeatable: !clocks && torchThreads === 1,
        notRepeatable: reasons.join(', '),
        settings,
      };
      const workers = v.workers !== undefined ? Number(v.workers) : defaultWorkers(availableParallelism(), threads, torchThreads);
      log(`${cells.length} cell(s), ${Math.ceil(Number(v.games ?? '100') / 2) * 2} games each, ${workers} worker(s); results in ${out}.jsonl`);
      const result = await runMatch({
        cells, ours: r.ours, theirSettings: r.theirs.settings, hostPaths, binary: bin,
        games: Number(v.games ?? '100'), seed: Number(v.seed), workers, out, header, log,
      });
      process.stdout.write(`summary: ${out}.json\n`);
      if (result.stopped) {
        process.stderr.write(`${result.error?.message ?? 'stopped'}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case 'verify': {
      const pin = readPin();
      const { host } = await startHost(cache, pin);
      try {
        const configured = await host.ask<{ refused?: unknown; message?: string }>({ type: 'configure', cells: verifyCells }, 600_000, 'configure');
        if (configured.refused !== undefined) throw new Error(`their library refused verify's settings: ${configured.message}`);
        const games = Number(v.games ?? '200');
        const r = await verify(host, games, Number(v.seed), log);
        process.stdout.write(`${r.games} games, ${r.plies} plies, ${r.roundEnds} round ends, ${r.disagreements.length} disagreements\n`);
        process.stdout.write(`refills inside a factory: ${r.refillsInsideAFactory}, floor overflows: ${r.floorOverflows}\n`);
        if (r.disagreements.length > 0) process.exitCode = 1;
        else if (r.refillsInsideAFactory === 0 || r.floorOverflows === 0) {
          process.stdout.write('the run was too short to reach every case [G13-44]: play more games\n');
          process.exitCode = 1;
        }
      } finally {
        host.close();
      }
      return;
    }
    default:
      throw new Error(`unknown command "${command}"\n${USAGE}`);
  }
}

main().catch((e: unknown) => {
  if (e instanceof SettingError) process.stderr.write('refused before any game: ');
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
});
