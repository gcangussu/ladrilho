import {
  COLOR_BONUS,
  COL_BONUS,
  CUM_PENALTY,
  FACTORY_SIZE,
  FLOOR_PENALTIES,
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
import { placementRuns, placementValue } from './score.js';
import type {
  AzulState,
  Color,
  Placement,
  Player,
  PlayerBonuses,
  PlayerRound,
  RoundScoring,
} from './types.js';

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
 *
 * `sink` is the out-parameter of [S7-3]: `null` on the unexplained path, and
 * otherwise the array each placement is appended to *as it is charged*, from
 * the same `placementValue` call the accumulator takes its number from
 * [S7-10]. There is no second arithmetic here to drift from the first.
 */
function tileWall(s: AzulState, p: Player, sink: Placement[] | null): number {
  const wall = s.walls[p];
  const plColor = s.plColor[p];
  const plCount = s.plCount[p];
  const lid = s.lid;
  let gain = 0;
  for (let r = 0; r < NUM_ROWS; r++) {
    if (plCount[r] !== r + 1) continue; // a partial line waits for next round
    const c = plColor[r];
    const idx = WALL_IDX[c * NUM_ROWS + r];
    const col = idx - r * 5;
    const points = placementValue(wall, r, col); // [E1-68]: scored before placed
    gain += points;
    if (sink !== null) {
      // Also before the tile is placed, which changes nothing — neither the
      // value nor the runs read the cell at `(r, col)` [E1-68] — and keeps the
      // record's two numbers answering the same question the charge did.
      const runs = placementRuns(wall, r, col);
      sink.push({ row: r, col, h: runs.h, v: runs.v, points });
    }
    wall[idx] = 1;
    lid[c] += r; // the r tiles of the line that did not go on the wall
    plColor[r] = -1;
    plCount[r] = 0;
  }
  return gain;
}

/**
 * End-of-game bonuses, added unclamped to the running score [E1-38].
 *
 * `explain` is the sink one level up: the counts and the points they earned are
 * recorded where they are charged [S7-19], and the pair of scores around the
 * addition is what keeps the interface from having to redo it [S7-22]. On the
 * unexplained path nothing is built and nothing is allocated.
 */
function finishGame(
  s: AzulState,
  explain: boolean,
): readonly [PlayerBonuses, PlayerBonuses] | null {
  const sink: PlayerBonuses[] | null = explain ? [] : null;
  for (const p of PLAYERS) {
    const rows = completedRows(s, p);
    const cols = completedCols(s, p);
    const colors = completedColors(s, p);
    const rowPoints = ROW_BONUS * rows;
    const colPoints = COL_BONUS * cols;
    const colorPoints = COLOR_BONUS * colors;
    const total = rowPoints + colPoints + colorPoints;
    const scoreBefore = s.scores[p];
    s.scores[p] = scoreBefore + total;
    if (sink !== null) {
      sink.push({
        rows,
        cols,
        colors,
        rowPoints,
        colPoints,
        colorPoints,
        total,
        scoreBefore,
        scoreAfter: s.scores[p],
      });
    }
  }
  s.isTerminal = true;
  return sink === null ? null : [sink[0], sink[1]];
}

/**
 * Everything that happens once the board empties [E1-22]..[E1-37]: both
 * players tile and score (player 0 first), the marker goes back to the centre,
 * and then the game either ends or the next round is dealt.
 *
 * `explain` carries the sink of [S7-3] and nothing else. With it false this is
 * the function it has always been; with it true the same charges are also
 * written down as they are made, and the record is returned [S7-1].
 */
export function endRound(
  s: AzulState,
  lastMover: Player,
  explain: boolean,
): RoundScoring | null {
  // [S7-13] the round that is ending, read before anything moves. Read at the
  // end it would name the round that follows on one of the three exits and the
  // round that ended on the other two.
  const round = s.roundIndex;
  const rounds: PlayerRound[] | null = explain ? [] : null;

  for (const p of PLAYERS) {
    // `placements` and `rounds` are the same decision, made twice because the
    // compiler cannot see that they are: both are `null` exactly when the
    // caller asked for no record.
    const placements: Placement[] | null = rounds === null ? null : [];
    const tiling = tileWall(s, p, placements);
    // [S7-14] both read while the floor still holds what it cost: the clearing
    // below empties it and [E1-30] takes the marker back further down.
    const occupied = floorOccupied(s, p);
    const markerHeld = s.floorMarker[p];
    const penalty = CUM_PENALTY[Math.min(FLOOR_SLOTS, occupied)];
    const fl = s.floor[p];
    for (let c = 0; c < NUM_COLORS; c++) {
      s.lid[c] += fl[c];
      fl[c] = 0;
    }
    // Clamped per round, so a penalty larger than the score never carries a
    // debt into the next one [E1-28].
    const scoreBefore = s.scores[p];
    const charged = scoreBefore + tiling + penalty;
    s.scores[p] = Math.max(0, charged);
    if (rounds !== null && placements !== null) {
      rounds.push({
        placements,
        tiling,
        floor: {
          occupied,
          // [S7-16] by slot, in ladder order, never attributed to a tile: the
          // floor is a per-colour count and a marker flag [E1-3], with no
          // order to attribute by.
          rungs: FLOOR_PENALTIES.slice(0, Math.min(occupied, FLOOR_SLOTS)),
          markerHeld,
          penalty,
        },
        scoreBefore,
        scoreAfterRound: s.scores[p],
        // [S7-17] what the clamp did not take, a property of the round rather
        // than of the floor: [E1-28] clamps tiling and penalty together.
        forgiven: s.scores[p] - charged,
      });
    }
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
  let bonuses: readonly [PlayerBonuses, PlayerBonuses] | null = null;
  if (anyRowComplete(s)) {
    bonuses = finishGame(s, explain);
  } else {
    s.roundIndex++; // counts round transitions, not deals [E1-35]
    refill(s);
    if (s.tilesLeft === 0) {
      // Bag and lid both empty: nothing could be dealt, so the game stops here
      // and says so [E1-37]. Unreachable from a full census; posed positions
      // reach it.
      s.exhausted = true;
      bonuses = finishGame(s, explain);
    }
  }

  // [S7-20] `bonuses` is non-null exactly when one of the two endings above
  // ran, which is exactly when the game ended.
  return rounds === null ? null : { round, players: [rounds[0], rounds[1]], bonuses };
}
