import type { JSX } from '@solidjs/web';
import { Show } from 'solid-js';

/**
 * One tile, or one empty slot.
 *
 * [U3-36]: colour is never the only cue. Each colour also gets a glyph, and the
 * colour's name — always from `game.colorNames`, never a string of ours — rides
 * along for assistive technology. Where an enclosing control supplies its own
 * `aria-label` [U3-54] that label wins and this one is not announced, which is
 * what we want: the name is here for the parts of the board that are read
 * rather than operated.
 *
 * A glyph per colour, indexed by colour. A string, deliberately: the colours
 * are the engine's [0001 E1-1] and this adds a shape to each, no table of
 * numbers and no arithmetic.
 */
const GLYPHS = '●◆■▲★';

export function Tile(props: {
  /** The colour, or `null` for an empty slot. */
  color: number | null;
  names: string[];
  /** Marks a tile this round's wall-tiling placed [U3-43]. */
  placed?: boolean;
  /**
   * An empty wall cell, showing the colour that belongs there [U3-37].
   *
   * A wall cell's colour is fixed geometry that never changes [0001 E1-1], so
   * whether the cell is filled is the only thing it has to say — and saying it
   * with opacity alone would leave the wall unreadable to a screen reader.
   */
  ghost?: boolean;
  /**
   * What this cell earned in the most recent round, as the record states it
   * [U3-102] — shown on the tile it belongs to, and never computed here.
   */
  points?: number | null;
}): JSX.Element {
  return (
    <span
      class={[
        'tile',
        {
          empty: props.color === null,
          ghost: !!props.ghost,
          placed: !!props.placed,
          scored: props.points !== undefined && props.points !== null,
        },
      ]}
      data-color={props.color ?? undefined}
    >
      <span class="glyph" aria-hidden="true">
        {props.color === null ? '' : GLYPHS[props.color]}
      </span>
      <span class="sr-only">
        {props.color === null ? 'empty' : props.names[props.color]}
        {props.ghost ? ', not yet placed' : props.placed ? ', just placed' : ''}
      </span>
      {/* Hidden from assistive technology: the workings panel says the same
          thing in words, beside the run that earned it [U3-84]. */}
      <Show when={props.points !== undefined && props.points !== null}>
        <span class="badge" aria-hidden="true">
          +{props.points}
        </span>
      </Show>
    </span>
  );
}
