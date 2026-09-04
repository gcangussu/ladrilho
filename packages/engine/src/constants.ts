/**
 * Board constants and the fixed wall geometry. See spec 0001 — Engine core.
 *
 * Everything here is frozen: [E1-51] forbids module-level mutable state, and
 * these tables are read on every ply by every state in the process.
 */

/** Colours are 0..4 = blue, yellow, red, black, teal. */
export const NUM_COLORS = 5;
export const TILES_PER_COLOR = 20;
export const NUM_TILES = NUM_COLORS * TILES_PER_COLOR;
/** The two-player factory count. */
export const NUM_FACTORIES = 5;
export const FACTORY_SIZE = 4;
export const NUM_ROWS = 5;

/** Action `source` value meaning "the centre pool" [E1-6]. */
export const CENTER = 5;
/** Action `dest` value meaning "the floor line" [E1-6]. */
export const FLOOR = 5;
/** `source (6) * color (5) * dest (6)` [E1-6]. */
export const ACTION_SPACE = 180;

export const FLOOR_PENALTIES: readonly number[] = Object.freeze([
  -1, -1, -2, -2, -2, -3, -3,
]);
export const FLOOR_SLOTS = FLOOR_PENALTIES.length;

/**
 * `CUM_PENALTY[n]` is the penalty for `n` occupied floor slots, `n` in `0..7`
 * [E1-27]. Slots past the seventh cost nothing, so callers clamp the index.
 */
export const CUM_PENALTY: readonly number[] = Object.freeze(
  FLOOR_PENALTIES.reduce((acc, p) => acc.concat(acc[acc.length - 1] + p), [0]),
);

export const ROW_BONUS = 2;
export const COL_BONUS = 7;
export const COLOR_BONUS = 10;

export const COLOR_NAMES: readonly string[] = Object.freeze([
  'blue',
  'yellow',
  'red',
  'black',
  'teal',
]);
/** One character per colour, for `renderText`. */
export const COLOR_CHARS = 'BYRKT';

/** Wall column of `color` in `row` on the standard fixed wall [E1-1]. */
export function wallCol(color: number, row: number): number {
  return (color + row) % NUM_COLORS;
}

/** Colour of the wall cell at `(row, col)` — the inverse of {@link wallCol} [E1-1]. */
export function wallColorAt(row: number, col: number): number {
  return (col - row + NUM_COLORS) % NUM_COLORS;
}

/**
 * Flat wall lookup: `WALL_IDX[color * 5 + row]` is the row-major index of that
 * colour's cell in that row [E1-1], [E1-2].
 */
export const WALL_IDX: readonly number[] = Object.freeze(
  Array.from({ length: NUM_COLORS * NUM_ROWS }, (_, i) => {
    const color = (i / NUM_ROWS) | 0;
    const row = i % NUM_ROWS;
    return row * 5 + wallCol(color, row);
  }),
);

/** The two seats, for loops that must run in seat order [E1-22]. */
export const PLAYERS: readonly [0, 1] = Object.freeze([0, 1]);

/** Row-major index of the first cell of each wall row. */
export const ROW_BASES: readonly number[] = Object.freeze([0, 5, 10, 15, 20]);
