import { ACTION_SPACE, CENTER, FLOOR, FLOOR_SLOTS, NUM_COLORS, NUM_ROWS, WALL_IDX } from './constants.js';
import { decodeAction } from './actions.js';
import { floorOccupied } from './inspect.js';
import { endRound } from './round.js';
import type { AzulState, Player, RoundScoring } from './types.js';

/**
 * Plays one ply, including any round or game transition it triggers [E1-21].
 * Mutates `s`, returns nothing [S7-2].
 *
 * An out-of-range or illegal action throws and leaves the state untouched
 * [E1-14]. The validation that makes that true is in {@link ply} below, which
 * is the one implementation both entry points share.
 */
export function apply(s: AzulState, action: number): void {
  ply(s, action, false);
}

/**
 * The same ply, and additionally what round resolution charged [S7-1].
 *
 * Returns `null` on a ply that ends no round — which is most of them — and
 * allocates nothing on that path [S7-4]: the sink is a parameter of round
 * resolution, and round resolution is entered only when `tilesLeft` reaches
 * zero. The record it returns shares nothing mutable with `s`, so a caller may
 * keep it for as long as it likes [S7-8]; the engine keeps none [S7-7].
 *
 * It throws on the same inputs `apply` does, and returns nothing on that path
 * [E1-14], [S7-5].
 */
export function applyExplained(s: AzulState, action: number): RoundScoring | null {
  return ply(s, action, true);
}

/**
 * The one implementation of a ply [S7-3]. `explain` is the only difference
 * between the two entry points above, and it reaches nothing but `endRound`.
 *
 * Everything is validated before a single tile moves [E1-14], because a
 * half-applied state is a defect rather than an outcome — which is also why
 * neither entry point can return a partial record [S7-5].
 */
function ply(s: AzulState, action: number, explain: boolean): RoundScoring | null {
  if (s.isTerminal) throw new Error('game is over');
  if (!Number.isInteger(action) || action < 0 || action >= ACTION_SPACE) {
    throw new Error(`action ${action} out of range`);
  }
  const [src, color, dest] = decodeAction(action);
  const p = s.currentPlayer;
  const pool = src === CENTER ? s.center : s.factories[src];
  const count = pool[color];
  if (count === 0) throw new Error(`no color ${color} at source ${src}`);
  if (dest !== FLOOR) {
    const held = s.plCount[p][dest];
    if (held > dest) throw new Error(`pattern line ${dest} is full`);
    if (held !== 0 && s.plColor[p][dest] !== color) {
      throw new Error(`pattern line ${dest} holds another color`);
    }
    if (s.walls[p][WALL_IDX[color * NUM_ROWS + dest]]) {
      throw new Error(`color ${color} already on wall row ${dest}`);
    }
  }

  // --- take the tiles: all of the colour leaves the pool [E1-15], and the
  // rest of a factory display goes to the centre [E1-16].
  pool[color] = 0;
  if (src === CENTER) {
    // Only the first take from the centre each round moves the marker [E1-17].
    if (s.markerInCenter) {
      s.markerInCenter = false;
      s.floorMarker[p] = true;
    }
  } else {
    for (let c = 0; c < NUM_COLORS; c++) {
      if (pool[c] !== 0) {
        s.center[c] += pool[c];
        pool[c] = 0;
      }
    }
  }
  s.tilesLeft -= count;

  // --- place them [E1-18], [E1-19]
  let overflow: number;
  if (dest !== FLOOR) {
    const room = dest + 1 - s.plCount[p][dest];
    s.plColor[p][dest] = color;
    if (count < room) {
      s.plCount[p][dest] += count;
      overflow = 0;
    } else {
      s.plCount[p][dest] = dest + 1;
      overflow = count - room;
    }
  } else {
    overflow = count;
  }

  // Overflow fills the floor up to seven occupied slots, marker included;
  // anything past that goes straight to the lid [E1-20].
  if (overflow !== 0) {
    const room = FLOOR_SLOTS - floorOccupied(s, p);
    if (overflow <= room) {
      s.floor[p][color] += overflow;
    } else if (room > 0) {
      s.floor[p][color] += room;
      s.lid[color] += overflow - room;
    } else {
      s.lid[color] += overflow;
    }
  }

  if (s.tilesLeft !== 0) {
    s.currentPlayer = (1 - p) as Player;
    return null;
  }
  return endRound(s, p, explain);
}
