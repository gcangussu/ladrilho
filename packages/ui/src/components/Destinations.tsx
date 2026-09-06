import type { JSX } from '@solidjs/web';
import type { AzulJSONPlayer } from 'engine';
import { FLOOR, NUM_ROWS } from 'engine';
import { For, Show } from 'solid-js';
import { FloorTiles, floorLineName, floorOverflow } from './FloorLine.jsx';
import { PatternLineTiles, patternLineName } from './PatternLines.jsx';
import { RovingGroup } from './RovingGroup.jsx';

/**
 * The six destinations of [0001 E1-6] — five pattern lines and the floor — as
 * controls on the board of the player to move [U3-79].
 *
 * Which of them is available comes from `legalActions` alone [U3-48]: the
 * caller asks the engine whether `encodeAction(source, colour, d)` is in the
 * legal set [U3-24]. Nothing here tests a row's capacity or its colour, which
 * would be [0001 E1-10] written a second time.
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
  const rows = (): number[] => [...Array(NUM_ROWS).keys(), FLOOR];

  const name = (dest: number): string =>
    dest === FLOOR
      ? floorLineName(props.floorOccupied, props.player.floorPenalty)
      : patternLineName(props.player.patternLines[dest], dest, props.names);

  return (
    <RovingGroup label={props.label} group="destinations" count={rows().length}>
      {(tabIndex) => (
        // `<For keyed={false}>` hands its callback an accessor in Solid v2, read
        // inside the JSX below and never in the callback body.
        <For each={rows()} keyed={false}>
          {(dest, index) => (
            <button
              type="button"
              data-roving="true"
              class={['destination', { floor: dest() === FLOOR }]}
              aria-label={name(dest())}
              // Present, focusable and inert rather than `disabled`, so a keyboard
              // player can still reach the row they are wondering about [U3-29].
              aria-disabled={props.available(dest()) ? 'false' : 'true'}
              tabindex={tabIndex(index)}
              onClick={() => props.onChoose(dest())}
            >
              <Show
                when={dest() === FLOOR}
                fallback={
                  <span class="pattern-line">
                    <PatternLineTiles
                      line={props.player.patternLines[dest()]}
                      names={props.names}
                    />
                  </span>
                }
              >
                <span class="floor-line">
                  <FloorTiles
                    floor={props.player.floor}
                    marker={props.player.floorMarker}
                    names={props.names}
                  />
                </span>
              </Show>
            </button>
          )}
        </For>
      )}
    </RovingGroup>
  );
}

/** The floor summary that sits beside the control, for the numbers [U3-38] wants shown. */
export function FloorSummary(props: { occupied: number; penalty: number }): JSX.Element {
  return (
    <p class="floor-summary">
      Floor line: {props.occupied} slots, penalty {props.penalty}
      <Show when={floorOverflow(props.occupied) > 0}>
        {' '}
        (plus {floorOverflow(props.occupied)} beyond the last slot, costing nothing)
      </Show>
    </p>
  );
}
