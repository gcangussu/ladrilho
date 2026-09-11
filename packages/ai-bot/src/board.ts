/**
 * The board [A8-8]: the original's 23×6 grid of 8-bit integers, from the
 * perspective of the seat to move, built from `AzulJSON` alone [A8-5].
 *
 * It is the network's input and the node table's key [A8-10], and nothing
 * more [A8-6]. Legality, transitions and results all come from the engine; no
 * function here or anywhere else in the package reads a rule back out of it.
 */

import type { AzulJSON, AzulJSONPlayer } from 'engine';

export const BOARD_ROWS = 23;
export const BOARD_COLS = 6;
export const BOARD_SIZE = BOARD_ROWS * BOARD_COLS;

/** The largest value an 8-bit signed cell can hold [A8-9]. */
const INT8_MAX = 127;

/**
 * A score saturated to 127 [A8-9].
 *
 * The original keeps scores in 8 bits and, through its own floor clamp, has
 * never shown its network a score above 127 on any board it evaluated; 127 is
 * the nearest value it has seen. A wrapped value would be the one input it has
 * certainly never met. Scores are never negative ([0001 E1-28]), so there is
 * no lower end to saturate.
 */
function score(n: number): number {
  return n > INT8_MAX ? INT8_MAX : n;
}

/** Rows 9–12's pattern-line colours or counts for one seat, and column 5. */
function patternRow(out: Int8Array, row: number, player: AzulJSONPlayer, colours: boolean): void {
  const base = row * BOARD_COLS;
  const lines = player.patternLines;
  for (let r = 0; r < lines.length; r++) {
    out[base + r] = colours ? lines[r].color : lines[r].count;
  }
  if (colours) {
    out[base + 5] = player.floorMarker ? 1 : 0;
  } else {
    // The original counts the marker as a floor tile (`make_move`).
    let floor = player.floorMarker ? 1 : 0;
    for (const n of player.floor) floor += n;
    out[base + 5] = floor;
  }
}

/** Rows 13–17 or 18–22: one seat's wall, row by row. */
function wallRows(out: Int8Array, firstRow: number, player: AzulJSONPlayer): void {
  for (let r = 0; r < player.wall.length; r++) {
    const base = (firstRow + r) * BOARD_COLS;
    const cells = player.wall[r];
    for (let col = 0; col < cells.length; col++) out[base + col] = cells[col];
  }
}

/** The board of spec 0008's table, as 138 values in row-major order [A8-8]. */
export function encodeBoard(position: AzulJSON): Int8Array {
  const out = new Int8Array(BOARD_SIZE);
  const me = position.players[position.currentPlayer];
  const them = position.players[1 - position.currentPlayer];

  // Row 0. The original's round counter starts at 1 on the first deal; ours
  // counts round transitions from 0 ([0001 E1-35]).
  out[0] = score(me.score);
  out[1] = score(them.score);
  out[2] = position.round + 1;

  for (let c = 0; c < position.bag.length; c++) {
    out[1 * BOARD_COLS + c] = position.bag[c];
    // Row 2 counts the floors because the original moves a tile to its discard
    // pile the moment it reaches a floor line, where ours keeps it there until
    // the round ends ([0001 E1-3]). The sum is the same number.
    out[2 * BOARD_COLS + c] =
      position.lid[c] + position.players[0].floor[c] + position.players[1].floor[c];
    out[3 * BOARD_COLS + c] = position.center[c];
  }
  out[3 * BOARD_COLS + 5] = position.markerInCenter ? 1 : 0;

  for (let d = 0; d < position.factories.length; d++) {
    const display = position.factories[d];
    for (let c = 0; c < display.length; c++) out[(4 + d) * BOARD_COLS + c] = display[c];
  }

  patternRow(out, 9, me, true);
  patternRow(out, 10, them, true);
  patternRow(out, 11, me, false);
  patternRow(out, 12, them, false);
  wallRows(out, 13, me);
  wallRows(out, 18, them);
  return out;
}
