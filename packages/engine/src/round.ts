import {
  COLOR_BONUS,
  COL_BONUS,
  CUM_PENALTY,
  FACTORY_SIZE,
  FLOOR_SLOTS,
  NUM_COLORS,
  NUM_ROWS,
  PLAYERS,
  ROW_BONUS,
  WALL_IDX,
} from './constants.js';
import {
  anyRowComplete,
  completedColors,
  completedCols,
  completedRows,
  floorOccupied,
} from './inspect.js';
import { shuffleInPlace } from './rng.js';
import { placementValue } from './score.js';
import type { AzulState, Color, Player } from './types.js';

/**
 * The one place randomness enters [E1-47]. Calls the seam with the state's
 * current `shufflesUsed` as the index, then increments it — the same on the
 * seeded path as on an injected one, because the count is a property of the
 * position, not of how the position was built [E1-61].
 */
export function runShuffle(s: AzulState): void {
  if (s.shuffle !== null) s.shuffle(s.bag, s.shufflesUsed);
  else shuffleInPlace(s.bag, s.rng);
  s.shufflesUsed++;
}

/**
 * Deals `FACTORY_SIZE` tiles to each display in order, drawing from the end of
 * the bag [E1-32]. A draw that *finds* the bag empty recycles the lid and
 * shuffles [E1-33]; if the lid is empty too, nothing is shuffled and dealing
 * stops early, leaving the remaining displays short [E1-34].
 */
export function refill(s: AzulState): void {
  const bag = s.bag;
  const lid = s.lid;
  let dealt = 0;
  for (const f of s.factories) {
    for (let k = 0; k < FACTORY_SIZE; k++) {
      if (bag.length === 0) {
        for (let c = 0; c < NUM_COLORS; c++) {
          for (let n = lid[c]; n > 0; n--) bag.push(c as Color);
          lid[c] = 0;
        }
        if (bag.length === 0) {
          s.tilesLeft = dealt;
          return;
        }
        runShuffle(s);
      }
      f[bag.pop() as Color]++;
      dealt++;
    }
  }
  s.tilesLeft = dealt;
}

/**
 * Wall-tiling and scoring for one player. Rows resolve in order `0..4` and a
 * tile placed by an earlier row is visible to a later one [E1-22], [E1-25].
 * Returns the tiling gain; the caller adds the floor penalty.
 */
function tileWall(s: AzulState, p: Player): number {
  const wall = s.walls[p];
  const plColor = s.plColor[p];
  const plCount = s.plCount[p];
  const lid = s.lid;
  let gain = 0;
  for (let r = 0; r < NUM_ROWS; r++) {
    if (plCount[r] !== r + 1) continue; // a partial line waits for next round
    const c = plColor[r];
    const idx = WALL_IDX[c * NUM_ROWS + r];
    gain += placementValue(wall, r, idx - r * 5); // [E1-68]: scored before placed
    wall[idx] = 1;
    lid[c] += r; // the r tiles of the line that did not go on the wall
    plColor[r] = -1;
    plCount[r] = 0;
  }
  return gain;
}

/** End-of-game bonuses, added unclamped to the running score [E1-38]. */
function finishGame(s: AzulState): void {
  for (const p of PLAYERS) {
    s.scores[p] +=
      ROW_BONUS * completedRows(s, p) +
      COL_BONUS * completedCols(s, p) +
      COLOR_BONUS * completedColors(s, p);
  }
  s.isTerminal = true;
}

/**
 * Everything that happens once the board empties [E1-22]..[E1-37]: both
 * players tile and score (player 0 first), the marker goes back to the centre,
 * and then the game either ends or the next round is dealt.
 */
export function endRound(s: AzulState, lastMover: Player): void {
  for (const p of PLAYERS) {
    let gain = tileWall(s, p);
    gain += CUM_PENALTY[Math.min(FLOOR_SLOTS, floorOccupied(s, p))];
    const fl = s.floor[p];
    for (let c = 0; c < NUM_COLORS; c++) {
      s.lid[c] += fl[c];
      fl[c] = 0;
    }
    // Clamped per round, so a penalty larger than the score never carries a
    // debt into the next one [E1-28].
    s.scores[p] = Math.max(0, s.scores[p] + gain);
  }

  // The marker holder gives it up and starts the next round [E1-30]. When
  // nobody took from the centre all round the marker never left it, and
  // ordinary alternation decides instead [E1-31].
  let holder: Player | null = null;
  for (const p of PLAYERS) {
    if (s.floorMarker[p]) {
      s.floorMarker[p] = false;
      holder = p;
    }
  }
  if (holder === null) holder = (1 - lastMover) as Player;
  s.markerInCenter = true;
  s.firstPlayer = holder;
  s.currentPlayer = holder;

  // The handoff above runs before this check, so a terminal state still
  // reports a lawful marker and first player [E1-66].
  if (anyRowComplete(s)) {
    finishGame(s);
    return;
  }

  s.roundIndex++; // counts round transitions, not deals [E1-35]
  refill(s);
  if (s.tilesLeft === 0) {
    // Bag and lid both empty: nothing could be dealt, so the game stops here
    // and says so [E1-37]. Unreachable from a full census; posed positions
    // reach it.
    s.exhausted = true;
    finishGame(s);
  }
}
