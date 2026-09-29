/**
 * What the suite shares: where the debug checker is, and the fixed runs of
 * [C10-36] that several tests stand on.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkerPath } from '../../src/checker.js';
import type { Engine } from '../../src/engine.js';
import { type RunOptions, type RunResult, run } from '../../src/run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE = join(HERE, '..', '..');
export const REPO = join(PACKAGE, '..', '..');

/** The checker the `test` script builds before the suite runs. */
export const CHECKER = checkerPath('debug');

/**
 * The fixed runs of [C10-36]. Sized from measured rates, not from what this
 * seed happens to reach: a short start ends in exhaustion in about 4% of
 * games under any policy (8, 7, 5, 4 and 4 in 200 for the five tried), and a
 * `floor` game charges an eighth slot about 0.15 times (6 in 40 games).
 */
export const EVERYDAY: Record<'mix' | 'short' | 'floor', RunOptions> = {
  mix: { games: 40, seed: 20260926, steer: 'mix', start: { kind: 'new' }, startText: 'new', cap: 400 },
  short: {
    games: 100,
    seed: 20260926,
    steer: 'uniform',
    start: { kind: 'short', max: 80 },
    startText: 'short:80',
    cap: 400,
  },
  floor: { games: 20, seed: 20260926, steer: 'floor', start: { kind: 'new' }, startText: 'new', cap: 400 },
};

export function runWith(engine: Engine, options: RunOptions): Promise<RunResult> {
  return run(engine, CHECKER, options);
}
