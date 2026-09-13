/**
 * `expert` as the arena sees it [A8-30].
 *
 * A module rather than a closure inside the lane, so the shape it reports can
 * be asserted: `match` only ever looks at `curtailed`, and the other three
 * fields would drift unnoticed.
 */

import type { AzulJSON } from 'engine';
import { createExpert, type ExpertOptions } from '../src/index.js';

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
