import {
  FACTORY_SIZE,
  FLOOR_SLOTS,
  NUM_COLORS,
  NUM_ROWS,
  TILES_PER_COLOR,
} from './constants.js';
import {
  bagCounts,
  completedColors,
  completedCols,
  completedRows,
  floorOccupied,
} from './inspect.js';
import type { AzulState, Player } from './types.js';

// Field offsets [E1-53]. Changing this layout needs a new spec: it invalidates
// every trained model [E1-57].
export const OFF_MY_WALL = 0;
export const OFF_OP_WALL = 25;
export const OFF_MY_LINES = 50;
export const OFF_OP_LINES = 80;
export const OFF_MY_FLOOR = 110;
export const OFF_OP_FLOOR = 117;
export const OFF_SCORES = 124;
export const OFF_FACTORIES = 126;
export const OFF_FACTORY_FLAGS = 151;
export const OFF_CENTER = 156;
export const OFF_CENTER_TOTAL = 161;
export const OFF_MARKER_CENTER = 162;
export const OFF_BAG = 163;
export const OFF_LID = 168;
export const OFF_TILES_LEFT = 173;
export const OFF_I_START = 174;
export const OFF_ROUND = 175;
export const OFF_MY_SETS = 176;
export const OFF_OP_SETS = 179;
export const ENCODED_SIZE = 182;

/**
 * The observation vector as seat `p` sees it [E1-67]: "me" is `p`, "them" is
 * the other player. Does not mutate `s`, so the opponent's view is reachable
 * without setting `currentPlayer` and re-encoding.
 *
 * Most fields are normalised into `[0, 1]`, but the divisors are scaling
 * constants rather than clamps and two fields legitimately exceed 1 — centre
 * colour counts (`/10`) and scores (`/100`). Only the floor slots and the
 * round index are clamped, and clamping the rest would silently diverge from
 * the reference encoder [E1-56].
 */
export function encodeFor(s: AzulState, p: Player): Float32Array {
  const v = new Float32Array(ENCODED_SIZE);
  const me = p;
  const them = (1 - p) as Player;

  for (let i = 0; i < 25; i++) {
    v[OFF_MY_WALL + i] = s.walls[me][i];
    v[OFF_OP_WALL + i] = s.walls[them][i];
  }

  // An empty pattern line contributes all zeros — no colour bit, zero fill [E1-54].
  for (const [off, q] of [
    [OFF_MY_LINES, me],
    [OFF_OP_LINES, them],
  ] as const) {
    for (let r = 0; r < NUM_ROWS; r++) {
      const n = s.plCount[q][r];
      if (n !== 0) {
        const base = off + r * 6;
        v[base + s.plColor[q][r]] = 1;
        v[base + 5] = n / (r + 1);
      }
    }
  }

  for (const [off, q] of [
    [OFF_MY_FLOOR, me],
    [OFF_OP_FLOOR, them],
  ] as const) {
    for (let c = 0; c < NUM_COLORS; c++) v[off + c] = s.floor[q][c] / FLOOR_SLOTS;
    v[off + 5] = Math.min(floorOccupied(s, q), FLOOR_SLOTS) / FLOOR_SLOTS;
    v[off + 6] = s.floorMarker[q] ? 1 : 0;
  }

  v[OFF_SCORES] = s.scores[me] / 100;
  v[OFF_SCORES + 1] = s.scores[them] / 100;

  for (let i = 0; i < s.factories.length; i++) {
    const base = OFF_FACTORIES + i * 5;
    let total = 0;
    for (let c = 0; c < NUM_COLORS; c++) {
      const n = s.factories[i][c];
      v[base + c] = n / FACTORY_SIZE;
      total += n;
    }
    if (total !== 0) v[OFF_FACTORY_FLAGS + i] = 1;
  }

  let centerTotal = 0;
  for (let c = 0; c < NUM_COLORS; c++) {
    const n = s.center[c];
    v[OFF_CENTER + c] = n / 10;
    centerTotal += n;
  }
  v[OFF_CENTER_TOTAL] = centerTotal / 20;
  v[OFF_MARKER_CENTER] = s.markerInCenter ? 1 : 0;

  // Bag and lid counts are public information in Azul and are encoded; the
  // bag's order is not, and must not be [E1-55].
  const bag = bagCounts(s);
  for (let c = 0; c < NUM_COLORS; c++) {
    v[OFF_BAG + c] = bag[c] / TILES_PER_COLOR;
    v[OFF_LID + c] = s.lid[c] / TILES_PER_COLOR;
  }

  v[OFF_TILES_LEFT] = s.tilesLeft / 20;
  // A disjunction, and both halves matter: set for the marker holder *and*
  // for whoever started this round, so mid-round both seats can see it [E1-63].
  v[OFF_I_START] = s.floorMarker[me] || s.firstPlayer === me ? 1 : 0;
  v[OFF_ROUND] = Math.min(s.roundIndex, 10) / 10;

  for (const [off, q] of [
    [OFF_MY_SETS, me],
    [OFF_OP_SETS, them],
  ] as const) {
    v[off] = completedRows(s, q) / 5;
    v[off + 1] = completedCols(s, q) / 5;
    v[off + 2] = completedColors(s, q) / 5;
  }
  return v;
}

/** The vector from the seat to move — `encodeFor(s, s.currentPlayer)` [E1-67]. */
export function encode(s: AzulState): Float32Array {
  return encodeFor(s, s.currentPlayer);
}
