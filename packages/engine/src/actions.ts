import {
  ACTION_SPACE,
  CENTER,
  FLOOR,
  NUM_COLORS,
  NUM_ROWS,
  WALL_IDX,
} from './constants.js';
import type { AzulState, Color, Player } from './types.js';

/** `source * 30 + color * 6 + destination` [E1-6]. */
export function encodeAction(source: number, color: number, dest: number): number {
  return source * 30 + color * 6 + dest;
}

/** The exact inverse of {@link encodeAction} over the whole space [E1-7]. */
export function decodeAction(action: number): [source: number, color: Color, dest: number] {
  const source = (action / 30) | 0;
  const rest = action % 30;
  return [source, ((rest / 6) | 0) as Color, rest % 6];
}

/**
 * `ACTION_TABLE[source][color][mask]` is the ready-made ascending action list
 * for a player whose open pattern rows for `color` are the set bits of `mask`,
 * with the always-legal floor action last [E1-60]. Built once, frozen, read
 * on every ply.
 */
type ActionLists = readonly (readonly (readonly number[])[])[];
const ACTION_TABLE: readonly ActionLists[] = Object.freeze(
  Array.from({ length: 6 }, (_, src) =>
    Object.freeze(
      Array.from({ length: NUM_COLORS }, (_, color) =>
        Object.freeze(
          Array.from({ length: 1 << NUM_ROWS }, (_, mask) => {
            const list: number[] = [];
            for (let r = 0; r < NUM_ROWS; r++) {
              if ((mask >> r) & 1) list.push(encodeAction(src, color, r));
            }
            list.push(encodeAction(src, color, FLOOR));
            return Object.freeze(list);
          }),
        ),
      ),
    ),
  ),
);

/**
 * Bit `r` of `out[c]` is set when colour `c` may still go into `p`'s pattern
 * line `r` [E1-10]. Recomputed per call rather than cached: 25 cheap reads
 * cost less than the risk of a stale cache, and it keeps `recount` honest.
 */
function openMasks(s: AzulState, p: Player): number[] {
  const out = [0, 0, 0, 0, 0];
  const wall = s.walls[p];
  const plColor = s.plColor[p];
  const plCount = s.plCount[p];
  for (let c = 0; c < NUM_COLORS; c++) {
    const base = c * NUM_ROWS;
    let mask = 0;
    for (let r = 0; r < NUM_ROWS; r++) {
      const n = plCount[r];
      if (n <= r && (n === 0 || plColor[r] === c) && !wall[WALL_IDX[base + r]]) {
        mask |= 1 << r;
      }
    }
    out[c] = mask;
  }
  return out;
}

/**
 * Exactly the actions for which {@link isLegal} is true, no duplicates, in
 * ascending order [E1-13]. Empty in a terminal state [E1-11].
 */
export function legalActions(s: AzulState): number[] {
  if (s.isTerminal) return [];
  const masks = openMasks(s, s.currentPlayer);
  const out: number[] = [];
  for (let src = 0; src <= CENTER; src++) {
    const pool = src === CENTER ? s.center : s.factories[src];
    const bySource = ACTION_TABLE[src];
    for (let c = 0; c < NUM_COLORS; c++) {
      if (pool[c] !== 0) out.push(...bySource[c][masks[c]]);
    }
  }
  return out;
}

/** Whether the current player may play `action` right now [E1-9]..[E1-12]. */
export function isLegal(s: AzulState, action: number): boolean {
  if (s.isTerminal) return false;
  if (!Number.isInteger(action) || action < 0 || action >= ACTION_SPACE) return false;
  const [src, color, dest] = decodeAction(action);
  const pool = src === CENTER ? s.center : s.factories[src];
  if (pool[color] === 0) return false;
  // Taking to the floor is legal whenever the source holds the colour, so a
  // player with tiles available always has a move [E1-12].
  if (dest === FLOOR) return true;
  const p = s.currentPlayer;
  const held = s.plCount[p][dest];
  if (held > dest) return false;
  if (held !== 0 && s.plColor[p][dest] !== color) return false;
  return s.walls[p][WALL_IDX[color * NUM_ROWS + dest]] === 0;
}
