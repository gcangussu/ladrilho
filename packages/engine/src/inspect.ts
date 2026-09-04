import {
  CUM_PENALTY,
  FLOOR_SLOTS,
  NUM_COLORS,
  NUM_ROWS,
  PLAYERS,
  ROW_BASES,
  WALL_IDX,
  wallColorAt,
} from './constants.js';
import type { AzulState, Player } from './types.js';

/** Floor slots in use, marker included [E1-26]. May exceed the 7 that score. */
export function floorOccupied(s: AzulState, p: Player): number {
  const fl = s.floor[p];
  let n = s.floorMarker[p] ? 1 : 0;
  for (let c = 0; c < NUM_COLORS; c++) n += fl[c];
  return n;
}

/** The (negative) penalty for `p`'s floor line; slots past the 7th cost 0 [E1-27]. */
export function floorPenalty(s: AzulState, p: Player): number {
  return CUM_PENALTY[Math.min(FLOOR_SLOTS, floorOccupied(s, p))];
}

export function completedRows(s: AzulState, p: Player): number {
  const wall = s.walls[p];
  let n = 0;
  for (const base of ROW_BASES) {
    if (wall[base] && wall[base + 1] && wall[base + 2] && wall[base + 3] && wall[base + 4]) n++;
  }
  return n;
}

export function completedCols(s: AzulState, p: Player): number {
  const wall = s.walls[p];
  let n = 0;
  for (let col = 0; col < 5; col++) {
    if (wall[col] && wall[col + 5] && wall[col + 10] && wall[col + 15] && wall[col + 20]) n++;
  }
  return n;
}

export function completedColors(s: AzulState, p: Player): number {
  const wall = s.walls[p];
  let n = 0;
  for (let c = 0; c < NUM_COLORS; c++) {
    const base = c * NUM_ROWS;
    let placed = 0;
    for (let r = 0; r < NUM_ROWS; r++) placed += wall[WALL_IDX[base + r]];
    if (placed === NUM_ROWS) n++;
  }
  return n;
}

/** True when either player has a complete wall row — the game's end condition [E1-36]. */
export function anyRowComplete(s: AzulState): boolean {
  return completedRows(s, 0) > 0 || completedRows(s, 1) > 0;
}

/**
 * `+1` if player 0 wins, `-1` if player 1 wins, `0` for a draw, `null` while
 * the game is unfinished. Ties on score break on complete rows [E1-39].
 */
export function outcome(s: AzulState): 1 | 0 | -1 | null {
  if (!s.isTerminal) return null;
  const [s0, s1] = s.scores;
  if (s0 !== s1) return s0 > s1 ? 1 : -1;
  const r0 = completedRows(s, 0);
  const r1 = completedRows(s, 1);
  if (r0 !== r1) return r0 > r1 ? 1 : -1;
  return 0;
}

/** Per-colour counts of the bag. Its *order* is hidden information [E1-52]. */
export function bagCounts(s: AzulState): number[] {
  const counts = [0, 0, 0, 0, 0];
  for (const c of s.bag) counts[c]++;
  return counts;
}

/** Tiles on factories plus the centre — what `tilesLeft` must equal [E1-41]. */
export function boardTiles(s: AzulState): number {
  let total = 0;
  for (let c = 0; c < NUM_COLORS; c++) total += s.center[c];
  for (const f of s.factories) {
    for (let c = 0; c < NUM_COLORS; c++) total += f[c];
  }
  return total;
}

/**
 * Every tile, wherever it is [E1-40]. `[20,20,20,20,20]` for any state
 * reachable from `newGame`; an artificially posed position may hold fewer, and
 * what must hold there is that a ply neither creates nor destroys any.
 */
export function tileCensus(s: AzulState): number[] {
  const counts = bagCounts(s);
  for (let c = 0; c < NUM_COLORS; c++) {
    counts[c] += s.lid[c] + s.center[c];
    for (const f of s.factories) counts[c] += f[c];
    for (const fl of s.floor) counts[c] += fl[c];
  }
  for (const p of PLAYERS) {
    const plColor = s.plColor[p];
    const plCount = s.plCount[p];
    for (let r = 0; r < NUM_ROWS; r++) {
      if (plCount[r]) counts[plColor[r]] += plCount[r];
    }
    const wall = s.walls[p];
    for (let r = 0; r < NUM_ROWS; r++) {
      for (let col = 0; col < 5; col++) {
        if (wall[r * 5 + col]) counts[wallColorAt(r, col)]++;
      }
    }
  }
  return counts;
}

/**
 * Rebuilds everything the engine derives from the board — today just
 * `tilesLeft` — after a caller has edited state fields by hand [E1-5]. The
 * engine keeps it current itself on every `apply`, so this is for callers.
 * It leaves the generator and `shufflesUsed` alone: no board implies either.
 */
export function recount(s: AzulState): void {
  s.tilesLeft = boardTiles(s);
}
