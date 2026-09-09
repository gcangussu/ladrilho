import type { JSX } from '@solidjs/web';
import type { AzulJSONPlayer } from 'engine';
import { For, Repeat, Show } from 'solid-js';
import { Tile } from './Tile.jsx';

type Line = AzulJSONPlayer['patternLines'][number];

/**
 * The tiles of one pattern line, filling from the right so a line's tiles sit
 * against the wall it feeds — which under [U3-88] is where the wall now is.
 *
 * A row's capacity is `capacity` as the engine reports it, not `r + 1` computed
 * here — the two agree, and the one that is not our arithmetic is the one to
 * use [U3-3].
 */
export function PatternLineTiles(props: { line: Line; names: string[] }): JSX.Element {
  return (
    <Repeat count={props.line.capacity}>
      {(slot) => (
        <Tile
          color={slot < props.line.capacity - props.line.count ? null : props.line.color}
          names={props.names}
        />
      )}
    </Repeat>
  );
}

/** What a pattern line is, said in game terms rather than as an index [U3-54]. */
export function patternLineName(line: Line, row: number, names: string[]): string {
  const held =
    line.count === 0
      ? 'empty'
      : `holds ${line.count} of ${line.capacity} ${names[line.color]}`;
  return `pattern line ${row + 1}, ${held}`;
}

/** How a row behaves when it is offered rather than shown [U3-24], [U3-25]. */
export interface RowControl {
  /** The roving group's answer for this row's position [U3-53]. */
  tabindex: number;
  available: boolean;
  onChoose: () => void;
}

/**
 * One pattern line, in both of [U3-86]'s configurations: a control on the board
 * of the player to move [U3-79], an inert row on every other board.
 *
 * One function and one class, deliberately. The two configurations used to be
 * two separate renderings, and their heights agreed only by accident — they did
 * not, so a board grew when the turn arrived and shrank when it left. What
 * decides the box is `.pattern-line`, which is on both; what `control` decides
 * is what the row *is*, and that adds nothing to the box.
 */
export function PatternRow(props: {
  line: Line;
  row: number;
  names: string[];
  /** Null on a board that is shown rather than offered. */
  control: RowControl | null;
}): JSX.Element {
  const label = (): string => patternLineName(props.line, props.row, props.names);
  return (
    <Show
      when={props.control}
      fallback={
        <div class="pattern-line" data-row={props.row}>
          <span class="sr-only">{label()}</span>
          <PatternLineTiles line={props.line} names={props.names} />
        </div>
      }
    >
      {(control) => (
        <button
          type="button"
          data-roving="true"
          class="pattern-line destination"
          data-row={props.row}
          aria-label={label()}
          // Present, focusable and inert rather than `disabled`, so a keyboard
          // player can still reach the row they are wondering about [U3-29].
          aria-disabled={control().available ? 'false' : 'true'}
          tabindex={control().tabindex}
          onClick={() => control().onChoose()}
        >
          <PatternLineTiles line={props.line} names={props.names} />
        </button>
      )}
    </Show>
  );
}

/** One player's five pattern lines, shown but not offered. */
export function PatternLines(props: {
  lines: Line[];
  names: string[];
  label: string;
}): JSX.Element {
  return (
    <div class="pattern-lines" role="group" aria-label={props.label}>
      <For each={props.lines} keyed={false}>
        {(line, r) => <PatternRow line={line()} row={r} names={props.names} control={null} />}
      </For>
    </div>
  );
}
