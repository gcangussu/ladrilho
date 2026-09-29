/**
 * Where everything lives. Run from `eval/` in the suite and from
 * `node_modules/.alphazero/` in the bundle: both sit below the package.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PACKAGE = HERE.includes('node_modules') ? join(HERE, '..', '..') : join(HERE, '..');
export const REPO = join(PACKAGE, '..', '..');

export const RUNS = join(PACKAGE, 'runs');
export const MILESTONES = join(PACKAGE, 'milestones');
export const LOG = join(MILESTONES, 'log.json');
export const GATES = join(PACKAGE, 'gate');
export const LATENCY = join(PACKAGE, 'latency');
export const CORPUS = join(LATENCY, 'corpus.bin');
export const LOCK = join(PACKAGE, '.lock');
export const TRAIN = join(PACKAGE, 'train');

export function binary(profile: 'debug' | 'release'): string {
  return join(PACKAGE, 'target', profile, 'alphazero');
}

/** A run's own directory and its files ([Z11-30]). */
export function runPaths(name: string) {
  const dir = join(RUNS, name);
  return {
    dir,
    config: join(dir, 'config.json'),
    state: join(dir, 'state.json'),
    losses: join(dir, 'losses.json'),
    throughput: join(dir, 'throughput.json'),
    latencyPoints: join(dir, 'latency-measurements.json'),
    checkpoint: (g: number) => join(dir, 'checkpoints', `${g}.bin`),
    manifest: (g: number) => join(dir, 'generations', `${g}.json`),
    samples: (g: number) => join(dir, 'samples', `${g}.bin`),
  };
}

/** `milestones/<run>/<generation>/checkpoint.bin`. */
export function milestoneCheckpoint(run: string, generation: number): string {
  return join(MILESTONES, run, String(generation), 'checkpoint.bin');
}

/**
 * The run and generation a milestone checkpoint's path names ([Z11-4]): the
 * checkpoint's header carries no run name.
 */
export function parseMilestonePath(path: string): { run: string; generation: number } {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  const n = parts.length;
  const at = parts.lastIndexOf('milestones');
  if (n < 4 || parts[n - 1] !== 'checkpoint.bin' || at !== n - 4 || !/^\d+$/.test(parts[n - 2])) {
    throw new Error(`${path} is not milestones/<run>/<generation>/checkpoint.bin`);
  }
  return { run: parts[n - 3], generation: Number(parts[n - 2]) };
}

/** A run name that is safe as a directory name. */
export function checkRunName(name: string | undefined): string {
  if (name === undefined || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`a run name is letters, digits, - and _, not ${String(name)}`);
  }
  return name;
}
