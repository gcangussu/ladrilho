import type { JSX } from '@solidjs/web';
import { FLOOR_PENALTIES, FLOOR_SLOTS, NUM_COLORS } from 'engine';
import { For, Show } from 'solid-js';
import { Tile } from './Tile.jsx';

/**
 * One player's floor line: the slots it occupies and what it currently costs.
 *
 * Both numbers are the engine's [U3-38] — `occupied` is `floorOccupied`
 * published beside the state [U3-4], and `penalty` is `players[p].floorPenalty`.
 * Neither is summed here, because summing five counts and adding one for the
 * marker is [0001 E1-26] and the engine already exports it.
 *
 * The ladder under the slots is `FLOOR_PENALTIES` imported from the engine
 * [U3-49] — the board's own printing, not a judgement about a move not yet made
 * [U3-30].
 */

/**
 * Which tile sits in which slot: the marker first, then colours `0..4`.
 *
 * Presentational, and carrying no rules meaning [U3-38] — the engine stores the
 * floor as per-colour counts precisely because the order never affects scoring
 * [0001 E1-3], and the penalty depends on how many slots are occupied, not on
 * which tile is in which [0001 E1-27].
 */
function occupants(floor: number[], marker: boolean): (number | 'marker')[] {
  const laid: (number | 'marker')[] = marker ? ['marker'] : [];
  for (let color = 0; color < NUM_COLORS; color++) {
    for (let n = 0; n < floor[color]; n++) laid.push(color);
  }
  return laid;
}

/** The slots themselves, with the penalty each one carries. */
export function FloorTiles(props: {
  floor: number[];
  marker: boolean;
  names: string[];
}): JSX.Element {
  const laid = (): (number | 'marker')[] => occupants(props.floor, props.marker);
  return (
    <span class="floor-slots">
      <For each={[...FLOOR_PENALTIES]} keyed={false}>
        {(cost, slot) => (
          <span class="floor-slot">
            <Show
              when={laid()[slot] === 'marker'}
              fallback={
                <Tile color={(laid()[slot] as number | undefined) ?? null} names={props.names} />
              }
            >
              <span class="tile marker">
                <span class="glyph" aria-hidden="true">
                  1
                </span>
                <span class="sr-only">first-player marker</span>
              </span>
            </Show>
            <span class="floor-cost" aria-hidden="true">
              {cost()}
            </span>
          </span>
        )}
      </For>
    </span>
  );
}

/** What the floor line is, said in game terms [U3-54]. */
export function floorLineName(occupied: number, penalty: number): string {
  return `floor line, ${occupied} of ${FLOOR_SLOTS} slots used, penalty ${penalty}`;
}

/** How many tiles are past the seventh slot, where they cost nothing [0001 E1-27]. */
export function floorOverflow(occupied: number): number {
  return occupied - FLOOR_SLOTS;
}

export function FloorLine(props: {
  floor: number[];
  marker: boolean;
  /** From the view model's `floorOccupied`, never recomputed here [U3-4]. */
  occupied: number;
  /** From `players[p].floorPenalty` [U3-38]. */
  penalty: number;
  names: string[];
  label: string;
}): JSX.Element {
  return (
    <div class="floor-line" role="group" aria-label={props.label}>
      <FloorTiles floor={props.floor} marker={props.marker} names={props.names} />
      <p class="floor-summary">
        Floor line: {props.occupied} of {FLOOR_SLOTS} slots, penalty {props.penalty}
        <Show when={floorOverflow(props.occupied) > 0}>
          {' '}
          (plus {floorOverflow(props.occupied)} beyond the last slot, costing nothing)
        </Show>
      </p>
    </div>
  );
}
