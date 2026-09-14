/**
 * `expert` as the arena sees it [A8-30].
 *
 * A module rather than a closure inside the lane, so the shape it reports can
 * be asserted: `match` only ever looks at `curtailed`, and the other three
 * fields would drift unnoticed.
 */

import type { AzulJSON } from 'engine';
import { createExpert, type ExpertOptions } from '../src/index.js';

/**
 * How many seeds a run was asked for [A8-30].
 *
 * `pnpm -F ai-bot gate 8` is a smoke run; pnpm also forwards a bare `--`, and
 * `Number('--')` is `NaN`, which would slice the seed list to nothing and make
 * a zero-game run look like a result. So the argument is validated rather than
 * trusted.
 */
export function seedLimit(argv: readonly string[], total: number): number {
  const argument = argv.find((value) => value !== '--');
  const limit = argument === undefined ? total : Number(argument);
  if (!Number.isInteger(limit) || limit <= 0 || limit > total) {
    throw new Error(`a seed count must be a whole number in 1..${total}, not ${String(argument)}`);
  }
  return limit;
}

/**
 * May a run of this many seeds write `gate/baseline.json` [A8-32]?
 *
 * Only a full one. The committed baseline costs the best part of an hour of
 * play and is what decides whether the interface offers `expert` at all; a
 * smoke run
 * must not be able to replace it, whatever it was asked for.
 */
export function mayWriteBaseline(count: number, total: number): boolean {
  return count === total;
}

/** What a chooser reports to the arena ([0005 M5-2]'s `Play`). */
export interface Play {
  action: number;
  nodes: number;
  curtailed: boolean;
  depth: number;
  complete: boolean;
}

/**
 * A chooser over a session built for one game [A8-30].
 *
 * Its work is `nodes = simulations`, `depth = 0`, and neither complete nor
 * curtailed: the search is not depth-bounded, and it is never curtailed
 * because this package has no clock to curtail it with ([A8-2]).
 */
export function expertChooser(options?: ExpertOptions): (position: AzulJSON) => Play {
  const session = createExpert(options);
  return (position) => {
    const choice = session.choose(position);
    return {
      action: choice.action,
      nodes: choice.simulations,
      curtailed: false,
      depth: 0,
      complete: false,
    };
  };
}
