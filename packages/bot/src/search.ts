/**
 * Negamax with alpha-beta over the engine's own transitions [B4-17], bounded
 * by a node count [B4-26] and stopped at the round boundary [B4-19].
 *
 * Three things in here are less obvious than they look.
 *
 * **The sign follows `currentPlayer`, never the ply parity** [B4-18].
 * `endRound` hands the next round to the marker holder [0001 E1-30], who may
 * be the player who just moved, so a ply can leave the *same* seat to move.
 *
 * Where that actually bites is the **boundary leaf**, not the recursion. Only
 * `endRound` can hand the round back to the same player, and a ply that runs
 * `endRound` is a boundary ply, which [B4-19] makes a leaf — so the unnegated
 * recursive branch below is, as the code stands, unreachable. Measured over
 * 120 games and 144 700 child expansions: 144 409 seat flips, 291 same-seat
 * boundaries, and **zero** same-seat non-boundary children. `search.test.ts`
 * asserts that zero, so the day [B4-19] changes the branch stops being dead
 * and the assertion says so.
 *
 * The live content of [B4-18] is therefore `evaluate(child, s.currentPlayer)`
 * at the boundary: valuing the leaf from the *parent's* seat. Write
 * `child.currentPlayer` there and you have precisely the bug [B4-18] describes
 * — a subtree valued from the wrong side, wrong by a few points, throwing
 * nothing and keeping every move legal. The recursive branch is kept as
 * defence rather than deleted, because it is what makes the rule true by
 * construction instead of by a coincidence of [B4-19].
 *
 * **A boundary node is a leaf whatever depth remains** [B4-6], [B4-19]. The
 * tiles the next round deals come from a bag whose order no player knows, and
 * `endRound` deals them inside the same ply that scores the round — so
 * searching past one is searching a fiction. The evaluation is blind to the
 * deal anyway [B4-7], which is what makes the leaf value honest.
 *
 * **A leaf needs no sign juggling.** `evaluate` is exactly zero-sum [B4-12],
 * so a leaf's value from any seat's perspective is one call with that seat.
 * Only the recursive case has to care whose turn the child is.
 */

import {
  CENTER,
  FLOOR,
  apply,
  clone,
  decodeAction,
  legalActions,
  type AzulState,
} from 'engine';
import { evaluate } from './evaluate.js';

/** How often the wall-clock fail-safe may be read [B4-28]. */
const CLOCK_MASK = 1023;

/**
 * Per-call search state. A parameter rather than a module binding, because
 * [B4-3] forbids module-level mutable state and a search that could see
 * another search's counters is a search whose answer depends on what else the
 * process was doing.
 */
interface Context {
  nodes: number;
  budget: number;
  deadline: number;
  /**
   * True while the first iteration runs, during which neither bound may stop
   * the search [B4-23].
   *
   * Without it a budget of one node — or the [B4-28] fail-safe firing on a slow
   * device during depth 1 — returns an action nothing looked at, with a value
   * nothing computed. There is no "last completed iteration's answer" when no
   * iteration completed, and inventing one puts a meaningless number in front
   * of the player through [0006 W6-25]. Depth 1 costs one node per legal action
   * and so at most `ACTION_SPACE` [0001 E1-6], which is the overshoot [B4-45]
   * allows.
   */
  mandatory: boolean;
  /** The clock stopped us, not the budget [B4-29]. */
  curtailed: boolean;
  /** Set the moment any leaf was reached by running out of depth [B4-20]. */
  depthLimited: boolean;
  /** Latched once either bound is hit; unwinds the recursion. */
  stopped: boolean;
}

/**
 * Move ordering [B4-21]: a pure function of the position and the action, so
 * two runs order identically.
 *
 * It is a guess at which moves are good, and it exists only to make alpha-beta
 * cut earlier. It never changes which move is chosen, only how fast — and that
 * is what keeps the pattern-line arithmetic below from being a second copy of
 * [0001 E1-10]'s capacity rule: a wrong guess here costs nodes, never
 * correctness, because every root move is searched at full width and ties are
 * broken by action number rather than by order. Both of those would stop being
 * true under a transposition table ([B4-25]) or a different tie-break, at which
 * point this arithmetic becomes load-bearing and must come from the engine. Filling
 * a line exactly is the strongest signal; overflowing onto the floor is the
 * worst; taking the marker costs a tempo that is worth about a tile.
 */
function orderingScore(s: AzulState, action: number): number {
  const [src, color, dest] = decodeAction(action);
  const p = s.currentPlayer;
  const pool = src === CENTER ? s.center : s.factories[src];
  const count = pool[color];
  let score: number;
  if (dest === FLOOR) {
    score = -3 * count;
  } else {
    const room = dest + 1 - s.plCount[p][dest];
    const overflow = count > room ? count - room : 0;
    score = (count - overflow) * 1.2 - overflow * 3;
    if (count === room) score += 4;
  }
  if (src === CENTER && s.markerInCenter) score -= 1.5;
  return score;
}

/**
 * Legal actions, best-guess first [B4-21].
 *
 * `legalActions` returns ascending [0001 E1-13] and `Array.prototype.sort` is
 * stable, so equal-scoring moves keep ascending action order — which is what
 * makes the root's tie-break in {@link chooseAction} reachable rather than
 * decided here by accident.
 */
function ordered(s: AzulState, actions: readonly number[]): number[] {
  const scored = actions.map((action) => ({ action, score: orderingScore(s, action) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.action);
}

/** Whether this ply ended the round or the game — the leaf test of [B4-19]. */
function isBoundary(parent: AzulState, child: AzulState): boolean {
  // Both clauses are needed, for the reason [0003 U3-39] spells out: a row
  // completion ends the game before the round index moves [0001 E1-36], and
  // exhaustion raises both [0001 E1-37].
  return child.roundIndex !== parent.roundIndex || child.isTerminal;
}

/** Budget and fail-safe [B4-27], [B4-28]. Latches `stopped` once either hits. */
function exhausted(ctx: Context): boolean {
  if (ctx.stopped) return true;
  if (ctx.mandatory) return false; // the first iteration always finishes
  if (ctx.nodes >= ctx.budget) {
    ctx.stopped = true;
    return true;
  }
  if ((ctx.nodes & CLOCK_MASK) === 0 && performance.now() >= ctx.deadline) {
    ctx.curtailed = true;
    ctx.stopped = true;
    return true;
  }
  return false;
}

/**
 * The value of `s` from `s.currentPlayer`'s perspective, searching `depth`
 * more plies.
 *
 * Returns a meaningless number once `ctx.stopped` latches; every caller up the
 * chain discards it, and the root discards the whole iteration [B4-24].
 */
function negamax(s: AzulState, depth: number, alpha: number, beta: number, ctx: Context): number {
  if (s.isTerminal) return evaluate(s, s.currentPlayer);
  if (depth === 0) {
    ctx.depthLimited = true;
    return evaluate(s, s.currentPlayer);
  }

  let best = -Infinity;
  for (const action of ordered(s, legalActions(s))) {
    if (exhausted(ctx)) return best;
    const child = clone(s);
    apply(child, action);
    ctx.nodes++;

    const value = isBoundary(s, child)
      ? // A leaf, valued from the *parent's* seat. Zero-sum makes the
        // perspective a parameter rather than a negation [B4-12] — and this is
        // where [B4-18] actually bites; see the note at the top of the file.
        evaluate(child, s.currentPlayer)
      : child.currentPlayer === s.currentPlayer
        ? // Unreachable while [B4-19] makes every boundary a leaf: only
          // `endRound` keeps the seat, and that ply is a boundary. Kept so the
          // rule holds by construction, not by that coincidence.
          negamax(child, depth - 1, alpha, beta, ctx)
        : -negamax(child, depth - 1, -beta, -alpha, ctx);

    if (value > best) best = value;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // this subtree cannot affect the result
  }
  return best;
}

/** What one completed root iteration decided. */
interface Iteration {
  action: number;
  value: number;
}

/**
 * One full-width pass over the root's moves at `depth`.
 *
 * Returns `null` when the budget ran out partway, which is [B4-24]: an
 * unfinished iteration has searched its first few moves against a real window
 * and the rest against nothing, so its "best" is the best of an arbitrary
 * prefix and is systematically worse than the previous depth's answer.
 */
function iterate(
  root: AzulState,
  actions: readonly number[],
  depth: number,
  ctx: Context,
): Iteration | null {
  let bestAction = -1;
  let bestValue = -Infinity;
  let alpha = -Infinity;

  for (const action of actions) {
    if (exhausted(ctx)) return null;
    const child = clone(root);
    apply(child, action);
    ctx.nodes++;

    const value = isBoundary(root, child)
      ? evaluate(child, root.currentPlayer)
      : child.currentPlayer === root.currentPlayer
        ? negamax(child, depth - 1, alpha, Infinity, ctx)
        : -negamax(child, depth - 1, -Infinity, -alpha, ctx);

    if (ctx.stopped) return null;

    // Ties go to the lower action number [B4-30], so the answer does not
    // depend on the order `ordered` happened to produce.
    if (value > bestValue || (value === bestValue && action < bestAction)) {
      bestValue = value;
      bestAction = action;
    }
    if (value > alpha) alpha = value;
  }
  return bestAction === -1 ? null : { action: bestAction, value: bestValue };
}

/**
 * What bounds a search. An object rather than three positional numbers: at a
 * call site `search(root, 3, 20000, 4000)` says nothing about which number is
 * the budget and which the clock.
 */
export interface Limits {
  /** Plies of lookahead. `Number.MAX_SAFE_INTEGER` to deepen until stopped. */
  maxDepth: number;
  /** The node budget [B4-26]. */
  nodes: number;
  /** The wall-clock fail-safe [B4-28], in milliseconds. */
  milliseconds: number;
}

/** What a search reports back to {@link chooseMove}. */
export interface SearchResult {
  action: number;
  value: number;
  depth: number;
  nodes: number;
  complete: boolean;
  curtailed: boolean;
}

/**
 * Iteratively deepen from the root until the budget is spent, `maxDepth` is
 * reached, or the search is complete [B4-20], [B4-22], [B4-23].
 *
 * `root` is consumed read-only; every child is a clone [B4-17].
 */
export function search(root: AzulState, limits: Limits): SearchResult {
  const ctx: Context = {
    nodes: 0,
    budget: limits.nodes,
    deadline: performance.now() + limits.milliseconds,
    curtailed: false,
    depthLimited: false,
    stopped: false,
    mandatory: true,
  };

  const legal = legalActions(root);
  // No `best` until an iteration produces one: [B4-23] has no answer to give
  // before then, and the first iteration is guaranteed to run.
  let best: Iteration | null = null;
  let reached = 0;
  let complete = false;
  // The root's own ordering, reused each iteration with the previous best
  // pulled to the front [B4-22].
  let rootOrder = ordered(root, legal);

  for (let depth = 1; depth <= limits.maxDepth; depth++) {
    ctx.depthLimited = false;
    const iteration = iterate(root, rootOrder, depth, ctx);
    ctx.mandatory = false; // depth 1 is done; every later iteration may abort
    if (iteration === null) break; // [B4-24]

    best = iteration;
    reached = depth;
    rootOrder = [iteration.action, ...rootOrder.filter((a) => a !== iteration.action)];

    if (!ctx.depthLimited) {
      // Every leaf was a boundary or a terminal node: the rest of the round is
      // searched exactly and deepening cannot change the answer [B4-20].
      complete = true;
      break;
    }
    if (exhausted(ctx)) break;
  }

  // `best` is non-null: the first iteration cannot abort [B4-23], and a root
  // with no legal actions was refused by `chooseMove` [B4-16].
  if (best === null) throw new Error('search produced no iteration');
  return {
    action: best.action,
    value: best.value,
    depth: reached,
    nodes: ctx.nodes,
    complete,
    curtailed: ctx.curtailed,
  };
}
