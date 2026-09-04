/**
 * The per-ply invariant battery [0002 V2-18], [0002 V2-19].
 *
 * Every one of these is asserted after every ply of every replay, and again on
 * every ply of the randomised self-play fuzz [0002 V2-24]. They return a
 * description of the first violation rather than throwing, so the caller can
 * name the vector and ply in the failure message.
 */

import {
  NUM_COLORS,
  NUM_ROWS,
  tileCensus,
  wallColorAt,
  type AzulState,
} from '../../src/index.js';

/** `[20,20,20,20,20]` for anything reachable from `newGame` [0001 E1-40]. */
export const FULL_CENSUS = [20, 20, 20, 20, 20];

/**
 * Conservation [0001 E1-40], asserted as *invariance*: the census after a ply
 * equals the census before it. `expected` is the census the replay started
 * with, so a posed short-census fixture is held to its own total rather than
 * to 100 tiles [0002 V2-18], [0002 V2-35].
 */
export function checkCensus(s: AzulState, expected: number[]): string | null {
  const census = tileCensus(s);
  for (let c = 0; c < NUM_COLORS; c++) {
    if (census[c] !== expected[c]) {
      return `[E1-40] census ${census.join(',')} != ${expected.join(',')}`;
    }
  }
  return null;
}

/**
 * The remaining structural invariants: [0001 E1-41], [0001 E1-42],
 * [0001 E1-43], [0001 E1-44], [0001 E1-45] and [0001 E1-64], plus the
 * pattern-line emptiness rule [0001 E1-4].
 *
 * `shuffles` is the number of shuffle calls the harness has served since the
 * replay began, which is what [0001 E1-64] pins `shufflesUsed` to; pass `null`
 * to skip that one (self-play uses the seeded generator and serves none).
 */
export function checkInvariants(
  s: AzulState,
  shuffles: number | null,
  previousShufflesUsed: number,
): string | null {
  // [E1-41] tilesLeft equals the sum of all display and centre counts.
  let board = 0;
  for (let c = 0; c < NUM_COLORS; c++) board += s.center[c];
  for (const f of s.factories) for (let c = 0; c < NUM_COLORS; c++) board += f[c];
  if (s.tilesLeft !== board) return `[E1-41] tilesLeft ${s.tilesLeft} != board ${board}`;

  // [E1-42] the marker is in exactly one place.
  const places = (s.markerInCenter ? 1 : 0) + (s.floorMarker[0] ? 1 : 0) + (s.floorMarker[1] ? 1 : 0);
  if (places !== 1) return `[E1-42] marker is in ${places} places`;

  for (const p of [0, 1] as const) {
    const wall = s.walls[p];
    // [E1-43] no pattern line over capacity, holding two colours, or holding a
    // colour already on its wall row. [E1-4] an empty line has colour -1.
    for (let r = 0; r < NUM_ROWS; r++) {
      const n = s.plCount[p][r];
      const c = s.plColor[p][r];
      if (n < 0 || n > r + 1) return `[E1-43] p${p} line ${r} holds ${n} of ${r + 1}`;
      if (n === 0) {
        if (c !== -1) return `[E1-4] p${p} line ${r} is empty but has colour ${c}`;
        continue;
      }
      if (c < 0 || c >= NUM_COLORS) return `[E1-43] p${p} line ${r} colour ${c}`;
      if (wall[r * 5 + ((c + r) % NUM_COLORS)] !== 0) {
        return `[E1-43] p${p} line ${r} holds colour ${c}, already on that wall row`;
      }
    }

    // [E1-44] no wall cell set twice, and each colour at most once per row and
    // per column. On the fixed wall a cell's colour is its position, so the
    // observable form is: every cell is 0 or 1, and no row or column repeats a
    // colour once the cells are read back through the geometry.
    const perRow: number[][] = [[], [], [], [], []];
    const perCol: number[][] = [[], [], [], [], []];
    for (let r = 0; r < NUM_ROWS; r++) {
      for (let col = 0; col < 5; col++) {
        const cell = wall[r * 5 + col];
        if (cell !== 0 && cell !== 1) return `[E1-44] p${p} wall (${r},${col}) is ${cell}`;
        if (cell === 1) {
          const colour = wallColorAt(r, col);
          if (perRow[r].includes(colour)) return `[E1-44] p${p} row ${r} repeats colour ${colour}`;
          if (perCol[col].includes(colour)) {
            return `[E1-44] p${p} column ${col} repeats colour ${colour}`;
          }
          perRow[r].push(colour);
          perCol[col].push(colour);
        }
      }
    }

    // [E1-45] scores are never negative.
    if (s.scores[p] < 0) return `[E1-45] p${p} score ${s.scores[p]}`;
  }

  // [E1-64] shufflesUsed never decreases, and rises by exactly one per shuffle.
  if (s.shufflesUsed < previousShufflesUsed) {
    return `[E1-64] shufflesUsed fell from ${previousShufflesUsed} to ${s.shufflesUsed}`;
  }
  if (shuffles !== null && s.shufflesUsed !== shuffles) {
    return `[E1-64] shufflesUsed ${s.shufflesUsed} != ${shuffles} shuffle calls served`;
  }
  return null;
}
