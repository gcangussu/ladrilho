import type { JSX } from '@solidjs/web';
import type { AzulJSONPlayer } from 'engine';
import { FLOOR, NUM_ROWS } from 'engine';
import { For } from 'solid-js';
import { FloorRow, FloorSummary } from './FloorLine.jsx';
import { PatternRow } from './PatternLines.jsx';
import { RovingGroup } from './RovingGroup.jsx';

/**
 * The six destinations of [0001 E1-6] — five pattern lines and the floor — as
 * controls on the board of the player to move [U3-79].
 *
 * Which of them is available comes from `legalActions` alone [U3-48]: the
 * caller asks the engine whether `encodeAction(source, colour, d)` is in the
 * legal set [U3-24]. Nothing here tests a row's capacity or its colour, which
 * would be [0001 E1-10] written a second time.
 *
 * The rows themselves are `PatternRow` and `FloorRow`, the same two components
 * the waiting board renders. This is the offered configuration of [U3-86] and
 * the arrangement is `.lines` either way, so the board keeps its size when the
 * turn passes; all that changes here is that a row is a control.
 */
export function Destinations(props: {
  player: AzulJSONPlayer;
  /** From the view model's `floorOccupied[p]` [U3-4]. */
  floorOccupied: number;
  names: string[];
  label: string;
  /** True while a selection is active and this destination is legal for it [U3-24]. */
  available: (dest: number) => boolean;
  onChoose: (dest: number) => void;
}): JSX.Element {
  /** The floor is the last of the six, so it is the last roving position. */
  const floorAt = NUM_ROWS;

  return (
    <RovingGroup class="lines" label={props.label} group="destinations" count={NUM_ROWS + 1}>
      {(tabIndex) => (
        <>
          <div class="pattern-lines">
            {/* `<For keyed={false}>` hands its callback an accessor in Solid v2,
                read inside the JSX below and never in the callback body. */}
            <For each={props.player.patternLines} keyed={false}>
              {(line, row) => (
                <PatternRow
                  line={line()}
                  row={row}
                  names={props.names}
                  control={{
                    tabindex: tabIndex(row),
                    available: props.available(row),
                    onChoose: () => props.onChoose(row),
                  }}
                />
              )}
            </For>
          </div>
          <div class="floor-block">
            <FloorRow
              floor={props.player.floor}
              marker={props.player.floorMarker}
              occupied={props.floorOccupied}
              penalty={props.player.floorPenalty}
              names={props.names}
              control={{
                tabindex: tabIndex(floorAt),
                available: props.available(FLOOR),
                onChoose: () => props.onChoose(FLOOR),
              }}
            />
            <FloorSummary occupied={props.floorOccupied} penalty={props.player.floorPenalty} />
          </div>
        </>
      )}
    </RovingGroup>
  );
}
