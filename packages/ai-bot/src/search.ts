/**
 * The search [A8-17] through [A8-24], and the number types it keeps [A8-50].
 *
 * A port of the original's `MCTS.search` and `pick_highest_UCB`, restricted to
 * the path `pit.py` takes: a full search, no Dirichlet noise, forced playouts
 * on. Every arithmetic order here is the original's as written, because
 * reassociating any of it changes the last bit and with it the visit counts
 * [A8-38] compares.
 *
 * The node table stores statistics only [A8-17]. States are re-derived on
 * every simulation by `clone` and `apply` from the root [A8-21], as the
 * original re-derives its boards, and the table is keyed by the board [A8-10],
 * so two positions reached by different paths that encode alike share a node —
 * that is the original's transposition handling, and it cannot be dropped,
 * because merging paths merges visit counts and visit counts choose the move.
 */

import {
  apply,
  clone,
  legalActions,
  outcome,
  toJSON,
  type AzulState,
} from 'engine';
import { fromTheirAction, toTheirAction } from './actions.js';
import { encodeBoard } from './board.js';
import { EPS, EXPERT } from './constants.js';

/** Their action space. */
const ACTIONS = 180;

/** What the network hands the search [A8-14]. */
export interface Evaluation {
  /** Raw policy by their action, as the network returned it. */
  policy: Float32Array;
  /** `[me, them]`. */
  value: Float32Array;
}

/**
 * The seam [A8-38] replaces: a function from a board to an evaluation.
 *
 * `normalised` says whether `policy` has already been normalised. The
 * reference search's recorded outputs are, and [A8-50] requires they be used
 * as given rather than normalised twice.
 */
export interface Evaluator {
  evaluate(board: Int8Array, legal: Uint8Array): Evaluation;
  normalised: boolean;
}

interface Node {
  /** Their action indices, ascending: the order selection visits [A8-19]. */
  legal: number[];
  /** Prior by their action, normalised, float32 [A8-50]. */
  P: Float32Array;
  /** Visits to this node. */
  Ns: number;
  /** The node's running value, float32 [A8-50]. */
  Qs: number;
  Nsa: Int32Array;
  /** Float64 [A8-50]. Meaningful only where `hasQsa` is set. */
  Qsa: Float64Array;
  hasQsa: Uint8Array;
}

/** The node table of one session: one seat of one game [A8-26]. */
export type NodeTable = Map<string, Node>;

/**
 * The board as a table key [A8-10]. One character per cell, so two boards
 * share a key exactly when all 138 values agree.
 */
export function boardKey(board: Int8Array): string {
  let key = '';
  for (let i = 0; i < board.length; i++) key += String.fromCharCode(board[i] & 0xff);
  return key;
}

/**
 * `P` normalised as the reference search normalises it [A8-50]: a float32
 * running total over all 180 entries in ascending index order, rounded after
 * every addition, then every entry divided by it and rounded.
 *
 * This is numba's `sum` of a float32 array compiled without `fastmath` — a
 * sequential accumulation in the array's own type — and the order matters:
 * summing in float64 and rounding once gives a different last bit.
 */
export function normalise(policy: Float32Array): Float32Array {
  let total = 0;
  for (let a = 0; a < ACTIONS; a++) total = Math.fround(total + policy[a]);
  const out = new Float32Array(ACTIONS);
  for (let a = 0; a < ACTIONS; a++) out[a] = Math.fround(policy[a] / total);
  return out;
}

/** The legal mask by their action, for the network and the node [A8-12]. */
function theirLegal(s: AzulState): { mask: Uint8Array; ascending: number[] } {
  const mask = new Uint8Array(ACTIONS);
  const ascending: number[] = [];
  for (const action of legalActions(s)) {
    const theirs = toTheirAction(action);
    mask[theirs] = 1;
    ascending.push(theirs);
  }
  ascending.sort((a, b) => a - b);
  return { mask, ascending };
}

/**
 * The value of a finished game, from the seat to move [A8-18] step 1.
 *
 * Float32, as `check_end_game` builds it, and the draw is the original's 0.01
 * for both seats rather than a zero.
 */
function terminalValue(s: AzulState): [number, number] {
  const decided = outcome(s);
  if (decided === 0) {
    const draw = Math.fround(EXPERT.drawValue);
    return [draw, draw];
  }
  const winner = decided === 1 ? 0 : 1;
  return winner === s.currentPlayer ? [1, -1] : [-1, 1];
}

/**
 * Selection [A8-19]: the legal actions in ascending order of **their** index.
 *
 * The order is theirs for two reasons, either of which would decide it alone.
 * A forced playout takes the first qualifying action in iteration order, so
 * the order is visible without any tie; and the tie-break is by first-seen.
 * Iterating in our encoding would put the centre last instead of first.
 */
function select(node: Node, simulation: number, forced: boolean): number {
  const first = node.Qs - EXPERT.fpu;
  let best = -Infinity;
  let chosen = -1;
  const root = Math.sqrt(node.Ns);
  const rootEps = Math.sqrt(node.Ns + EPS);
  for (const a of node.legal) {
    if (forced) {
      if (node.Nsa[a] < Math.floor(Math.sqrt(EXPERT.k * node.P[a] * simulation))) return a;
    }
    const u =
      node.hasQsa[a] === 1
        ? node.Qsa[a] + (EXPERT.cpuct * node.P[a] * root) / (1 + node.Nsa[a])
        : first + EXPERT.cpuct * node.P[a] * rootEps;
    // Strictly greater, so a tie falls to the lowest of their indices.
    if (u > best) {
      best = u;
      chosen = a;
    }
  }
  return chosen;
}

/**
 * One simulation [A8-18]: a descent from `s` to a leaf, and the backup.
 *
 * `simulation` is the 0-based index of this simulation within the current
 * `choose`, which is what the forced-playout bound is computed from.
 *
 * `forced` is true only for the node a simulation starts from. The original's
 * `MCTS.search` recurses as `self.search(next_s)`, without passing
 * `forced_playouts`, and the parameter defaults to false — so a forced playout
 * can only ever be taken at the root. Applying it at every node explores a
 * different tree, which is what [A8-38]'s lookup found by reaching boards the
 * original never evaluated.
 */
export function simulate(
  table: NodeTable,
  evaluator: Evaluator,
  s: AzulState,
  simulation: number,
  forced = false,
): [number, number] {
  if (s.isTerminal) return terminalValue(s);

  const board = encodeBoard(toJSON(s));
  const key = boardKey(board);
  const node = table.get(key);

  if (node === undefined) {
    const { mask, ascending } = theirLegal(s);
    const { policy, value } = evaluator.evaluate(board, mask);
    table.set(key, {
      legal: ascending,
      P: evaluator.normalised ? policy : normalise(policy),
      Ns: 0,
      Qs: Math.fround(value[0]),
      Nsa: new Int32Array(ACTIONS),
      Qsa: new Float64Array(ACTIONS),
      hasQsa: new Uint8Array(ACTIONS),
    });
    return [value[0], value[1]];
  }

  const a = select(node, simulation, forced && EXPERT.forcedPlayouts);
  const child = clone(s);
  apply(child, fromTheirAction(a));
  const result = simulate(table, evaluator, child, simulation);
  // The sign follows `currentPlayer`, never ply parity [A8-20]: a boundary ply
  // can leave the same seat to move.
  const v: [number, number] =
    child.currentPlayer === s.currentPlayer ? result : [result[1], result[0]];

  // In this order [A8-18] step 3. `Qsa` is float64; `Qs` is float32 and is
  // rounded after every arithmetic step, which is what NumPy 2 does with a
  // float32 scalar and a weak Python int.
  const previous = node.hasQsa[a] === 1 ? node.Qsa[a] : 0;
  node.Qsa[a] = (node.Nsa[a] * previous + v[0]) / (node.Nsa[a] + 1);
  node.hasQsa[a] = 1;
  node.Qs = Math.fround(Math.fround(Math.fround((node.Ns + 1) * node.Qs) + v[0]) / (node.Ns + 2));
  node.Nsa[a] += 1;
  node.Ns += 1;
  return v;
}

/** A node's visit counts by their action, or `null` if it was never expanded. */
export function visitCounts(table: NodeTable, board: Int8Array): Int32Array | null {
  const node = table.get(boardKey(board));
  return node === undefined ? null : node.Nsa;
}

/** What `choose` reads back from the root once the simulations are done. */
export function rootChoice(table: NodeTable, board: Int8Array): {
  action: number;
  value: number;
  rootVisits: number;
} {
  const node = table.get(boardKey(board));
  if (node === undefined) throw new Error('the root was never expanded');
  // Most visits, ties to the lowest of their indices [A8-24].
  let best = -1;
  let action = -1;
  for (const a of node.legal) {
    if (node.Nsa[a] > best) {
      best = node.Nsa[a];
      action = a;
    }
  }
  return { action: fromTheirAction(action), value: node.Qs, rootVisits: best };
}
