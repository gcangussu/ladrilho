/**
 * Building positions without poking state fields [0002 V2-3].
 *
 * The harness has exactly two lawful ways to reach a position: play into it
 * through `apply`, or load a canonical snapshot through `fromCanonical`
 * [0001 E1-62]. Writing to `AzulState` fields is forbidden here even though
 * [0001 E1-5] permits it elsewhere — a fixture assembled by poking fields
 * tests the poking, and anything only reachable that way is a gap in the
 * engine's own surface.
 *
 * The third route below is the shuffle seam [0001 E1-61]: `newGame` deals from
 * the bag the seam leaves behind, so choosing that order chooses the opening
 * board exactly, through the engine's own public constructor.
 */

import { NUM_COLORS, TILES_PER_COLOR, newGame, type AzulState, type Color } from '../../src/index.js';

const BAG_SIZE = NUM_COLORS * TILES_PER_COLOR;

/**
 * A new game whose first refill deals `dealt`, in that order: display 0 gets
 * the first four tiles, display 1 the next four, and so on [0001 E1-32].
 *
 * Tiles are drawn from the **end** of the bag, so the seam writes `dealt`
 * backwards into the tail and pads the head with whatever colours are left.
 */
export function gameDealing(dealt: Color[]): AzulState {
  if (dealt.length !== 20) throw new Error(`a refill deals 20 tiles, got ${dealt.length}`);
  const remaining = new Array<number>(NUM_COLORS).fill(TILES_PER_COLOR);
  for (const c of dealt) remaining[c]--;
  if (remaining.some((n) => n < 0)) throw new Error(`more than ${TILES_PER_COLOR} of a colour`);
  const rest: Color[] = [];
  for (let c = 0; c < NUM_COLORS; c++) {
    for (let i = 0; i < remaining[c]; i++) rest.push(c as Color);
  }
  return newGame(0, (bag) => {
    if (bag.length !== BAG_SIZE) throw new Error(`opening bag holds ${bag.length}`);
    for (let i = 0; i < rest.length; i++) bag[i] = rest[i];
    for (let i = 0; i < dealt.length; i++) bag[BAG_SIZE - 1 - i] = dealt[i];
  });
}

/** Four tiles of one colour, the shape a monochrome display is dealt from. */
export function mono(color: Color): Color[] {
  return [color, color, color, color];
}
