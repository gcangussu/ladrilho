/**
 * Static evaluation [B4-11] through [B4-15]: what a position is worth, in
 * points, to one seat.
 *
 * Two things constrain the shape of this file.
 *
 * It reads only the two boards, the two scores and the marker — never
 * `factories`, `center`, `bag`, `lid` or `tilesLeft` [B4-7]. A boundary node
 * has already been dealt, because `endRound` tiles, scores and refills inside
 * one ply [0001 E1-21], so a value that looked at a factory would be a value
 * that looked at tiles no player has seen. The ban is absolute rather than
 * conditional so that it is a `grep` [B4-51].
 *
 * And it asks the engine what things are worth [B4-8]: `placementValue` for a
 * tile [0001 E1-68], `floorPenalty` for the floor [0001 E1-27], and the three
 * bonus constants for the end of the game [0001 E1-38]. What it decides for
 * itself is only how much to care, which lives in `weights.ts`.
 */

import {
  COLOR_BONUS,
  COL_BONUS,
  NUM_COLORS,
  NUM_ROWS,
  ROW_BONUS,
  floorPenalty,
  outcome,
  placementValue,
  wallCol,
  wallCompletedColors,
  wallCompletedCols,
  wallCompletedRows,
  type AzulState,
  type Player,
} from 'engine';
import { LINE_COMPLETE, LINE_PARTIAL, LINE_WASTE, PROXIMITY_EXPONENT } from './weights.js';

/**
 * A win, in the same points the rest of the evaluation speaks [B4-13]. Far
 * outside any reachable heuristic total — the largest conceivable board is
 * worth a few hundred — so no pile of bonuses can counterfeit one.
 */
export const WIN = 1_000_000;

const WALL_CELLS = NUM_ROWS * NUM_COLORS;

/**
 * How much of a bonus an **incomplete** set of `n` cells out of `outOf` is
 * worth.
 *
 * The denominator is passed rather than assumed: a row's width is its number of
 * *columns* and a column's height is its number of *rows*. Both are 5, and
 * writing one where the other is meant would be invisible — which is exactly
 * why it is spelled out.
 *
 * Entirely this package's own guess — the engine has no opinion about a set
 * nobody has finished. Cubed so the guess stays small until the set is nearly
 * closed, because the fifth tile is the one that actually pays and a bot
 * rewarded linearly would happily spread itself across five columns it will
 * never close.
 */
function fraction(n: number, outOf: number): number {
  return (n / outOf) ** PROXIMITY_EXPONENT;
}

/**
 * The bonuses the wall has *not* yet earned, weighted by how close each is.
 *
 * Complete sets are deliberately absent: those are [0001 E1-38], they are
 * worth their full bonus, and `boardValue` gets that number from the engine's
 * own counters. This function only ever looks at sets of fewer than five, so
 * there is no rule in it to get wrong — only a preference.
 *
 * The geometry it counts over is the engine's: `wallCol` says where a colour
 * sits [0001 E1-1], and the flat row-major index is [0001 E1-2].
 */
function partialProximity(wall: readonly number[]): number {
  let value = 0;

  for (let r = 0; r < NUM_ROWS; r++) {
    let n = 0;
    const base = r * NUM_COLORS;
    for (let col = 0; col < NUM_COLORS; col++) n += wall[base + col];
    if (n < NUM_COLORS) value += ROW_BONUS * fraction(n, NUM_COLORS);
  }
  for (let col = 0; col < NUM_COLORS; col++) {
    let n = 0;
    for (let r = 0; r < NUM_ROWS; r++) n += wall[r * NUM_COLORS + col];
    if (n < NUM_ROWS) value += COL_BONUS * fraction(n, NUM_ROWS);
  }
  for (let c = 0; c < NUM_COLORS; c++) {
    let n = 0;
    for (let r = 0; r < NUM_ROWS; r++) n += wall[r * NUM_COLORS + wallCol(c, r)];
    if (n < NUM_ROWS) value += COLOR_BONUS * fraction(n, NUM_ROWS);
  }

  return value;
}

/**
 * One seat's board, in points, on a wall this function advances as the round
 * would [B4-15].
 *
 * `wall` is a scratch buffer owned by the caller and overwritten here — the
 * single working wall [B4-50] permits, reused for both seats rather than
 * allocated twice. The state itself is never touched [B4-41].
 */
function boardValue(s: AzulState, q: Player, wall: number[]): number {
  const source = s.walls[q];
  for (let i = 0; i < WALL_CELLS; i++) wall[i] = source[i];

  let value = s.scores[q];

  // Rows resolve 0..4 and a tile an earlier row places is visible to a later
  // one [0001 E1-22], [0001 E1-25] — so this loop must run in order, and must
  // set each cell before moving on [B4-15].
  const plColor = s.plColor[q];
  const plCount = s.plCount[q];
  for (let r = 0; r < NUM_ROWS; r++) {
    const held = plCount[r];
    if (held === 0) continue;
    if (held === r + 1) {
      const col = wallCol(plColor[r], r);
      value += LINE_COMPLETE * placementValue(wall, r, col);
      wall[r * NUM_COLORS + col] = 1;
    } else {
      // A line that will not tile this round: what is committed, less what it
      // still owes. The debt outweighs the credit, which is why a bot holding
      // this evaluation does not casually open row 4.
      value += LINE_PARTIAL * held - LINE_WASTE * (r + 1 - held);
    }
  }

  // The engine's number, not our arithmetic [0001 E1-27]. Already negative.
  value += floorPenalty(s, q);

  // What this round will have completed, asked of the engine [B4-8] — the
  // wall-shaped form [0001 E1-70], because `completedRows` and its siblings
  // answer about a *state* and this wall is a speculation, not one. Counting
  // the cells here instead would be a second implementation of [0001 E1-38]'s
  // geometry inside the package whose premise is that it holds none.
  value += ROW_BONUS * wallCompletedRows(wall);
  value += COL_BONUS * wallCompletedCols(wall);
  value += COLOR_BONUS * wallCompletedColors(wall);

  // And how close the incomplete ones are, which is this package's own guess
  // and the only part of the paragraph above that is not a rule.
  value += partialProximity(wall);

  return value;
}

/**
 * The position from `p`'s seat, in points [B4-11].
 *
 * Exactly zero-sum [B4-12]: one board's value minus the other's, so
 * `evaluate(s, 0) === -evaluate(s, 1)` holds by construction rather than by
 * arithmetic that happens to agree. That is what lets the search be a plain
 * negamax with one sign flip.
 *
 * A finished game is valued by its result rather than by its board [B4-13]:
 * the heuristic has nothing useful to say about a position nobody will play
 * from, and `outcome` already owns the tie-break on completed rows
 * [0001 E1-39].
 */
export function evaluate(s: AzulState, p: Player): number {
  const margin = s.scores[p] - s.scores[1 - p];
  if (s.isTerminal) {
    const result = outcome(s);
    if (result === 0 || result === null) return margin;
    // `outcome` speaks in seats: +1 means player 0 won.
    const winner: Player = result === 1 ? 0 : 1;
    return (winner === p ? WIN : -WIN) + margin;
  }
  const wall = new Array<number>(WALL_CELLS);
  return boardValue(s, p, wall) - boardValue(s, (1 - p) as Player, wall);
}
