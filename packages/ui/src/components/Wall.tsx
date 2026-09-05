import type { JSX } from '@solidjs/web';
import { NUM_COLORS, NUM_ROWS, wallColorAt } from 'engine';
import { Repeat } from 'solid-js';
import { Tile } from './Tile.jsx';

/**
 * One player's wall.
 *
 * The colour of every cell, filled or not, comes from `wallColorAt` [U3-37] —
 * a stateless engine function, so a component may call it directly [U3-4].
 * Nothing here knows the wall's geometry; it asks.
 *
 * The flat `[25]` index of [0001 E1-2] is reached by nested loops over the
 * engine's own row and column counts. No `%` anywhere: `newlyPlaced` is flat
 * and `wall` is 5×5, and walking both with the same two counters is what keeps
 * the two indexings in step.
 */
export function Wall(props: {
  /** 5 rows of 5 cells, 0/1, from `players[p].wall`. */
  wall: number[][];
  /** `[25]` flat row-major, from `transition.newlyPlaced[p]`, or `null` [U3-43]. */
  placed: number[] | null;
  names: string[];
  label: string;
}): JSX.Element {
  return (
    <div class="wall" role="group" aria-label={props.label}>
      <Repeat count={NUM_ROWS}>
        {(r) => (
          <div class="wall-row">
            <Repeat count={NUM_COLORS}>
              {(col) => (
                <Tile
                  color={wallColorAt(r, col)}
                  names={props.names}
                  ghost={!props.wall[r][col]}
                  placed={!!props.placed?.[r * NUM_COLORS + col]}
                />
              )}
            </Repeat>
          </div>
        )}
      </Repeat>
    </div>
  );
}
