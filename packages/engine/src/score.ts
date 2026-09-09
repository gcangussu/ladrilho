/**
 * The rules that are questions about a **wall** rather than about a state:
 * what a placed tile scores [E1-68], and what a wall has completed [E1-70].
 *
 * They live here, and the state-shaped functions in `inspect.ts` and the round
 * scoring in `round.ts` call them, so each rule has exactly one implementation.
 *
 * They take a wall because of the caller that needed them. The bot's
 * evaluation values a wall it has advanced *speculatively* through a round's
 * worth of pattern lines ([0004 B4-9], [0004 B4-14]) — a wall that is not any
 * state the engine holds — and it asks a few million times a move, so a
 * state-shaped signature would force a clone per call in the hottest loop in
 * the project. Nothing here allocates.
 */

import { NUM_COLORS, NUM_ROWS, WALL_IDX } from './constants.js';

/** Length of the horizontal run through `(row, col)`, the new tile included. */
function horizontalRun(wall: readonly number[], row: number, col: number): number {
  const base = row * 5;
  let run = 1;
  for (let i = col - 1; i >= 0 && wall[base + i]; i--) run++;
  for (let i = col + 1; i < 5 && wall[base + i]; i++) run++;
  return run;
}

/** Length of the vertical run through `(row, col)`, the new tile included. */
function verticalRun(wall: readonly number[], row: number, col: number): number {
  let run = 1;
  for (let i = row - 1; i >= 0 && wall[i * 5 + col]; i--) run++;
  for (let i = row + 1; i < 5 && wall[i * 5 + col]; i++) run++;
  return run;
}

/**
 * What a tile placed at `(row, col)` scores [E1-24], [E1-68]: the horizontal
 * run plus the vertical run where either exceeds one, and 1 for a tile that
 * lands alone.
 *
 * `wall` is the flat `[25]` row-major wall of [E1-2]. **The cell at
 * `(row, col)` is not read** — each run starts from that cell's neighbours and
 * counts the new tile as the `1` it begins with — so the answer is the same
 * whether the caller has already set it or not. That is the normative
 * property, and it is what licenses `tileWall` to score before it places.
 * Callers are still expected to ask about an unset cell, because that is the
 * only reading under which the name means anything.
 */
export function placementValue(wall: readonly number[], row: number, col: number): number {
  const h = horizontalRun(wall, row, col);
  const v = verticalRun(wall, row, col);
  return h > 1 || v > 1 ? (h > 1 ? h : 0) + (v > 1 ? v : 0) : 1;
}

/**
 * The two runs through `(row, col)`, the new tile included [S7-11].
 *
 * Private, and private on purpose: nothing outside round resolution asks what
 * a hypothetical placement's runs would be, and the record's `h` and `v` are
 * the only witness the two numbers need. It stands on the same two scans
 * {@link placementValue} stands on and stops there — combining them is
 * [E1-24]'s fusion rule, which has exactly one implementation and it is
 * `placementValue`'s [E1-71].
 *
 * It allocates, unlike everything else in this file, and is reached only from
 * the explained path of [S7-4].
 */
export function placementRuns(
  wall: readonly number[],
  row: number,
  col: number,
): { h: number; v: number } {
  return { h: horizontalRun(wall, row, col), v: verticalRun(wall, row, col) };
}

/** Complete rows on `wall` — the flat `[25]` of [E1-2] — [E1-70]. */
export function wallCompletedRows(wall: readonly number[]): number {
  let n = 0;
  for (let r = 0; r < NUM_ROWS; r++) {
    const base = r * 5;
    if (wall[base] && wall[base + 1] && wall[base + 2] && wall[base + 3] && wall[base + 4]) n++;
  }
  return n;
}

/** Complete columns on `wall` [E1-70]. */
export function wallCompletedCols(wall: readonly number[]): number {
  let n = 0;
  for (let col = 0; col < 5; col++) {
    if (wall[col] && wall[col + 5] && wall[col + 10] && wall[col + 15] && wall[col + 20]) n++;
  }
  return n;
}

/** Colours placed in all five rows on `wall` [E1-70]. */
export function wallCompletedColors(wall: readonly number[]): number {
  let n = 0;
  for (let c = 0; c < NUM_COLORS; c++) {
    const base = c * NUM_ROWS;
    let placed = 0;
    for (let r = 0; r < NUM_ROWS; r++) placed += wall[WALL_IDX[base + r]];
    if (placed === NUM_ROWS) n++;
  }
  return n;
}
