import type { JSX } from '@solidjs/web';
import type { AzulJSONPlayer } from 'engine';
import { For, Repeat } from 'solid-js';
import { Tile } from './Tile.jsx';

type Line = AzulJSONPlayer['patternLines'][number];

/**
 * The tiles of one pattern line, filling from the right so a line's tiles sit
 * against the wall it feeds.
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

/** One player's five pattern lines, shown but not offered. */
export function PatternLines(props: {
  lines: Line[];
  names: string[];
  label: string;
}): JSX.Element {
  return (
    <div class="pattern-lines" role="group" aria-label={props.label}>
      <For each={props.lines} keyed={false}>
        {(line, r) => (
          <div class="pattern-line" data-row={r}>
            <span class="sr-only">{patternLineName(line(), r, props.names)}</span>
            <PatternLineTiles line={line()} names={props.names} />
          </div>
        )}
      </For>
    </div>
  );
}
