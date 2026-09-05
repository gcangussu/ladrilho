import type { JSX } from '@solidjs/web';

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
}): JSX.Element {
  return (
    <span
      class={[
        'tile',
        { empty: props.color === null, ghost: !!props.ghost, placed: !!props.placed },
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
    </span>
  );
}
