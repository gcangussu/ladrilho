/**
 * `pnpm -F alphazero-bot grzhx <command>`: our master against generation 2300
 * of grzhx/azul-alpha-zero (spec 0013). See grzhx/README.md.
 */

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildLibrary } from './build.js';
import { checkUpdates, defaultCacheDir, ensureRelease, fetchRelease, makePin, PIN_PATH, readPin, writePin } from './release.js';

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
      const b = buildLibrary(cache, [], log);
      process.stdout.write(`${b.library}${b.cxxFlags.length ? `  (with ${b.cxxFlags.join(' ')})` : ''}\n`);
      return;
    }
    default:
      throw new Error(`unknown command "${command}"\n${USAGE}`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
});
