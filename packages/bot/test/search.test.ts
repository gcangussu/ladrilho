/**
 * The search [B4-16] through [B4-31], and the invariants that make its answer
 * mean anything [B4-42], [B4-45], [B4-46].
 *
 * Two of these need saying up front.
 *
 * [B4-57] is a **directed** test for the sign rule, because random play reaches
 * the position constantly and never notices it: valuing a subtree from the
 * wrong seat is wrong by a few points, throws nothing, and keeps every move
 * legal. It hunts for a real position where a boundary ply leaves the same seat
 * to move, and compares the search against a naive reference. What it actually
 * discriminates is the *boundary leaf's perspective* — the recursive same-seat
 * branch never runs, which the spy below asserts rather than assumes.
 *
 * [B4-46] and [B4-22] are properties of the search *tree* and of a *history*,
 * which no snapshot can show, so this file wraps the engine's `apply` **and
 * `clone`** and watches what the search does with them — sanctioned by [B4-61]
 * for the same reason [0003 U3-80] sanctions spying on `newGame`. Both spies
 * are needed: a search expands as clone-then-apply, so marking states only in
 * `apply` never sees a violation, and a test built that way passes with the
 * horizon removed entirely.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_SPACE,
  apply,
  clone,
  legalActions,
  newGame,
  toJSON,
  type AzulJSON,
  type AzulState,
} from 'engine';
import { chooseMove } from '../src/index.js';
// Not via the package entry: `search` takes a state and is not exported [B4-5].
import { search } from '../src/search.js';

/**
 * Timeouts here absorb the module-runner tax, not a slow search: every
 * cross-package import is a getter call under Vitest, so this package reads
 * about a tenth of its real throughput. `bench/` measures the shipped figure.
 */
const GAME_TIMEOUT_MS = 30_000;

/**
 * The budget for tests that need *a* search rather than a particular tier.
 *
 * `steady`'s 20 000 nodes over a 24-position corpus is 480 000 nodes a test,
 * which through the module runner's 10× tax is most of [B4-60]'s 30 seconds for
 * one assertion that has nothing to do with how deep the search went. Where the
 * tier is the subject — [B4-33], [B4-34], [B4-35] — the real one is used.
 */
const CHEAP = { tier: 'sharp', nodes: 1500 } as const;

/** A position `n` plies into a seeded game. */
function at(seed: number, n: number): AzulState {
  const s = newGame(seed);
  for (let i = 0; i < n && !s.isTerminal; i++) apply(s, legalActions(s)[0]);
  return s;
}

/** Positions from across a game, as the views the bot is actually handed. */
function views(): AzulJSON[] {
  const out: AzulJSON[] = [];
  for (const seed of [1, 7, 99, 4242]) {
    for (const n of [0, 3, 8, 17, 29, 46]) {
      const s = at(seed, n);
      if (!s.isTerminal) out.push(toJSON(s));
    }
  }
  return out;
}

/**
 * A position one ply away from a boundary that hands the round back to the seat
 * that just moved [0001 E1-30].
 *
 * Rare — about one child expansion in five hundred — so both the [B4-18] test
 * and the spy's seat census need it handed to them deliberately rather than
 * hoping a corpus wanders into one.
 */
function sameSeatAcrossBoundary(): AzulState | null {
  for (let seed = 1; seed < 400; seed++) {
    const s = newGame(seed);
    while (!s.isTerminal) {
      const legal = legalActions(s);
      for (const a of legal) {
        const child = clone(s);
        const mover = child.currentPlayer;
        apply(child, a);
        const crossed = child.roundIndex !== s.roundIndex;
        if (crossed && !child.isTerminal && child.currentPlayer === mover) return s;
      }
      apply(s, legal[0]);
    }
  }
  return null;
}

describe('what the search returns [B4-16]', () => {
  it('[B4-16] [B4-42] always returns a member of legalActions', () => {
    for (const position of views()) {
      const choice = chooseMove(position, CHEAP);
      expect(position.legalActions).toContain(choice.action);
    }
  });

  it('[B4-16] throws on a terminal position rather than returning one', () => {
    const s = newGame(3);
    while (!s.isTerminal) apply(s, legalActions(s)[0]);
    expect(s.isTerminal).toBe(true);
    expect(() => chooseMove(toJSON(s), { tier: 'easy' })).toThrow(/game is over|legal actions/i);
  });

  it('[B4-40] returns plain, structurally cloneable data', () => {
    const choice = chooseMove(views()[0], { tier: 'easy' });
    expect(structuredClone(choice)).toEqual(choice);
    expect(JSON.parse(JSON.stringify(choice))).toEqual(choice);
  });

  it('[B4-41] does not mutate the position it is given', () => {
    const position = views()[2];
    const before = structuredClone(position);
    chooseMove(position, CHEAP);
    expect(position).toEqual(before);
  });
});

describe('the budget [B4-26], [B4-27], [B4-45]', () => {
  it('[B4-45] [B4-26] never expands more nodes than its budget', () => {
    for (const position of views()) {
      for (const nodes of [1, 50, 500, 2000]) {
        const choice = chooseMove(position, { tier: 'sharp', nodes });
        // The floor is [B4-23]'s mandatory first iteration, which neither bound
        // may stop: a budget below the root's move count would otherwise return
        // a move nothing looked at. Depth 1 costs one node per legal action, so
        // the overshoot cannot exceed the action space [0001 E1-6].
        expect(choice.nodes, `budget ${nodes}`).toBeLessThanOrEqual(
          Math.max(nodes, ACTION_SPACE),
        );
        if (nodes >= position.legalActions.length) {
          expect(choice.nodes, `budget ${nodes}`).toBeLessThanOrEqual(nodes);
        }
      }
    }
  });

  it('[B4-23] [B4-45] finishes its first iteration however small the budget', () => {
    for (const position of views()) {
      const choice = chooseMove(position, { tier: 'sharp', nodes: 1 });
      // Depth 1 ran in full, so the answer is a move something actually valued
      // rather than the lowest legal action carrying a fabricated zero.
      expect(choice.depth).toBe(1);
      expect(choice.nodes).toBe(position.legalActions.length);
      expect(position.legalActions).toContain(choice.action);
      // And it agrees with `easy`, which is exactly a completed depth-1 search.
      expect(choice.action).toBe(chooseMove(position, { tier: 'easy' }).action);
    }
  });

  it('[B4-26] spends more nodes when given more, until the round runs out', () => {
    const position = views()[0]; // first ply of a round: the widest tree there is
    const small = chooseMove(position, { tier: 'sharp', nodes: 1000 });
    const large = chooseMove(position, { tier: 'sharp', nodes: 50_000 });
    expect(large.nodes).toBeGreaterThan(small.nodes);
    expect(large.depth).toBeGreaterThan(small.depth);
  });

  it('[B4-29] does not report curtailed when the node budget is what stopped it', () => {
    for (const position of views()) {
      // The clock is deliberately taken out of the picture. This test is about
      // the *node* budget, and leaving the 4-second fail-safe in place makes it
      // a test of how busy the machine is — it fails on a loaded box, which is
      // the fail-safe working exactly as [B4-28] says it should.
      const choice = chooseMove(position, {
        tier: 'sharp',
        nodes: 2000,
        milliseconds: 600_000,
      });
      expect(choice.curtailed).toBe(false);
    }
  });

  it('[B4-28] [B4-29] reports curtailed when the clock stops it first', () => {
    // A budget far past what one millisecond can buy, so the fail-safe wins.
    const choice = chooseMove(views()[0], { tier: 'sharp', nodes: 50_000_000, milliseconds: 1 });
    expect(choice.curtailed).toBe(true);
    expect(choice.nodes).toBeLessThan(50_000_000);
    // Curtailed or not, it still returns a legal move [B4-42].
    expect(views()[0].legalActions).toContain(choice.action);
  });
});

describe('the horizon [B4-19], [B4-20], [B4-46]', () => {
  it('[B4-20] reports a complete search near the end of a round, and stops deepening', () => {
    // Late in a round the tree runs out before the budget does.
    let sawComplete = false;
    for (const seed of [1, 7, 99]) {
      for (let n = 8; n < 11; n++) {
        const s = at(seed, n);
        if (s.isTerminal) continue;
        // A modest budget on purpose: a complete search stops when the round
        // runs out, well short of any budget, and [B4-60] keeps this suite
        // under 30 s. `sharp`'s real 400 000 is measured in `bench`, not here.
        const choice = chooseMove(toJSON(s), {
          tier: 'sharp',
          nodes: 5000,
          milliseconds: 600_000,
        });
        if (choice.complete) {
          sawComplete = true;
          // It stopped because the round did, not because the budget did.
          expect(choice.nodes).toBeLessThan(5000);
          expect(choice.curtailed).toBe(false);
        }
      }
    }
    expect(sawComplete, 'no position in the corpus searched its round exhaustively').toBe(true);
  }, GAME_TIMEOUT_MS);

  it('[B4-20] deepening past a complete search cannot change the move', () => {
    for (const seed of [1, 7, 99, 4242]) {
      const s = at(seed, 9);
      if (s.isTerminal) continue;
      const modest = chooseMove(toJSON(s), { tier: 'sharp', nodes: 5000 });
      if (!modest.complete) continue;
      const generous = chooseMove(toJSON(s), { tier: 'sharp', nodes: 50_000 });
      expect(generous.action).toBe(modest.action);
      expect(generous.nodes).toBe(modest.nodes);
    }
  }, GAME_TIMEOUT_MS);
});

/**
 * [B4-46], through the `apply` the search is obliged to use [B4-17]. Sanctioned
 * by [B4-61]: this is a property of a history, and no state shows it.
 */
describe('the search never looks past a boundary [B4-6], [B4-46]', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Both `apply` and `clone` have to be watched, and missing that made an
   * earlier version of this test vacuous.
   *
   * The search expands a node as `clone` then `apply`, so a state marked as a
   * boundary product is never itself passed to `apply` again — its *clone* is,
   * and a clone is a different object. Marking only in `apply` therefore never
   * saw a violation: the test passed with the horizon deliberately removed.
   * Wrapping `clone` to carry the mark across is what closes it, and the
   * mutation that proved the old version empty now fails this one.
   */
  it('[B4-46] [B4-6] expands no node whose parent ended a round', async () => {
    const engine = await import('engine');
    const realApply = engine.apply;
    const realClone = engine.clone;
    /** States produced by a boundary ply, and clones descended from them. */
    const fromBoundary = new WeakSet<AzulState>();
    let expandedPastBoundary = 0;
    let boundaries = 0;

    // Also counted: how the seat moves across a ply. `search.ts` has a branch
    // for a non-boundary child that keeps the seat, and [B4-19] makes that
    // branch unreachable — only `endRound` hands the round back to the same
    // player, and that ply is a boundary. Asserting the zero here is what
    // stops the comment claiming it from going stale silently.
    let flips = 0;
    let sameSeatBoundary = 0;
    let sameSeatNonBoundary = 0;

    // Every position is built *before* the spies go on. Building them plays
    // ordinary games, which legitimately apply plies from post-boundary states
    // — under the spies that reads as thousands of horizon violations, and an
    // earlier version of this test reported exactly that.
    const roots: AzulState[] = [];
    for (const seed of [1, 7, 99, 4242, 20260906]) {
      for (const n of [2, 5, 8]) {
        const root = at(seed, n);
        if (!root.isTerminal) roots.push(root);
      }
    }
    // Plus one position known to contain a same-seat boundary, so the seat
    // census below exercises that case rather than hoping to meet it.
    const sameSeat = sameSeatAcrossBoundary();
    if (sameSeat !== null) roots.push(sameSeat);

    const cloneSpy = vi.spyOn(engine, 'clone').mockImplementation((s: AzulState) => {
      const copy = realClone(s);
      if (fromBoundary.has(s)) fromBoundary.add(copy);
      return copy;
    });
    const applySpy = vi.spyOn(engine, 'apply').mockImplementation((s: AzulState, a: number) => {
      if (fromBoundary.has(s)) expandedPastBoundary++;
      const before = s.roundIndex;
      const mover = s.currentPlayer;
      realApply(s, a);
      const boundary = s.roundIndex !== before || s.isTerminal;
      if (s.currentPlayer !== mover) flips++;
      else if (boundary) sameSeatBoundary++;
      else sameSeatNonBoundary++;
      if (boundary) {
        fromBoundary.add(s);
        boundaries++;
      }
    });

    try {
      // Several positions rather than one: the horizon has to hold everywhere,
      // and a small budget each keeps this inside [B4-60].
      for (const root of roots) {
        search(realClone(root), {
          maxDepth: Number.MAX_SAFE_INTEGER,
          nodes: 4000,
          milliseconds: 10_000,
        });
      }
    } finally {
      applySpy.mockRestore();
      cloneSpy.mockRestore();
    }

    expect(boundaries, 'the position reached no boundary at all — nothing was tested').toBeGreaterThan(0);
    expect(expandedPastBoundary, 'the search expanded a node past a round boundary').toBe(0);

    // [B4-18]: where the sign rule actually applies. Mid-round `apply` always
    // alternates, so the unnegated recursive branch never runs and the rule is
    // carried entirely by the boundary leaf's perspective. If this stops being
    // zero, [B4-19] has changed and that branch is now live.
    expect(flips, 'no ordinary alternating plies were seen').toBeGreaterThan(0);
    expect(sameSeatBoundary, 'no boundary handed the round back to the same seat').toBeGreaterThan(
      0,
    );
    expect(
      sameSeatNonBoundary,
      'a non-boundary ply kept the seat — the recursive same-seat branch is now live, and ' +
        '[B4-18] is no longer carried by the boundary leaf alone',
    ).toBe(0);
  });
});

/**
 * [B4-22]: iterative deepening searches the previous iteration's best move
 * first at the root.
 *
 * This was briefly excused as unobservable. It is not, and the instrument was
 * already in the file: `iterate` applies every root move exactly once per
 * iteration, in `rootOrder` order, so the sequence of root-level `apply` calls
 * splits into equal chunks and each chunk's first entry is that iteration's
 * opening move. Marking the root and propagating the mark through `clone` is
 * enough to pick those calls out — the same [B4-61] machinery the horizon test
 * uses.
 */
describe('root move ordering [B4-22]', () => {
  it('[B4-22] opens each iteration with the previous iteration’s best move', async () => {
    const engine = await import('engine');
    const realApply = engine.apply;
    const realClone = engine.clone;

    const root = at(1, 1);
    const width = legalActions(root).length;
    expect(width, 'a root with one move cannot show an ordering').toBeGreaterThan(3);

    const DEPTH = 3;
    const previous = search(realClone(root), {
      maxDepth: DEPTH - 1,
      nodes: Number.MAX_SAFE_INTEGER,
      milliseconds: 60_000,
    });

    // Only *direct* clones of the root, and each counted once. Propagating a
    // mark down the tree the way the horizon test does would mark every node,
    // since a clone of a marked child is still marked — an earlier version did
    // exactly that and saw 5228 "root moves" instead of 216.
    const searchRoot = realClone(root);
    const rootClones = new WeakSet<AzulState>();
    const rootMoves: number[] = [];
    const cloneSpy = vi.spyOn(engine, 'clone').mockImplementation((s: AzulState) => {
      const copy = realClone(s);
      if (s === searchRoot) rootClones.add(copy);
      return copy;
    });
    const applySpy = vi.spyOn(engine, 'apply').mockImplementation((s: AzulState, a: number) => {
      if (rootClones.has(s)) {
        rootMoves.push(a);
        rootClones.delete(s); // it is a child now, not the root
      }
      realApply(s, a);
    });

    try {
      search(searchRoot, {
        maxDepth: DEPTH,
        nodes: Number.MAX_SAFE_INTEGER,
        milliseconds: 60_000,
      });
    } finally {
      applySpy.mockRestore();
      cloneSpy.mockRestore();
    }

    // One full-width pass per iteration, so the chunks are exact.
    expect(rootMoves.length, 'root moves are not a whole number of passes').toBe(width * DEPTH);
    const opensWith = (iteration: number): number => rootMoves[iteration * width];

    // The last iteration opens with what the one before it settled on, which
    // `previous` computes independently at that same depth.
    expect(opensWith(DEPTH - 1), 'the final iteration did not open with the previous best').toBe(
      previous.action,
    );
    // And the first iteration cannot: there is no previous best to lead with.
    expect(opensWith(0)).toBe(rootMoves[0]);
  });
});

/**
 * [B4-18]: the trap. `endRound` hands the next round to the marker holder
 * ([0001 E1-30]), who may be the seat that just moved, so a boundary ply can
 * leave the same player to move.
 */
describe('the sign follows currentPlayer, not ply parity [B4-18]', () => {
  it('[B4-18] finds a real position where a boundary keeps the same seat to move', () => {
    const s = sameSeatAcrossBoundary();
    expect(s, 'no position in 400 seeds keeps the same seat across a boundary').not.toBeNull();
  });

  /**
   * A reference negamax written the naive way — no alpha-beta, no ordering, no
   * budget, no deepening — against the real search at the same depth.
   *
   * What this does and does not discriminate is worth being exact about. The
   * sign rule below is not an *independent* statement of [B4-18]: there is only
   * one correct way to write it, so any correct reference states it the same
   * way. What it compares is a seat-reading implementation against a
   * seat-reading reference, which a parity-based search would fail — and that
   * is the discrimination [B4-57] asks for.
   *
   * The clause it actually exercises is the **boundary leaf's perspective**,
   * not the negated subtree, because the same-seat recursive branch never runs
   * (asserted above). Change `evaluate(child, s.currentPlayer)` to
   * `child.currentPlayer` in either file and the depth-2 and depth-3
   * comparisons fail; that is this test's live content.
   */
  it('[B4-18] [B4-57] agrees with an independent reference at the same depth', async () => {
    const { evaluate } = await import('../src/evaluate.js');
    const root = sameSeatAcrossBoundary();
    expect(root).not.toBeNull();

    function reference(s: AzulState, depth: number): number {
      if (s.isTerminal) return evaluate(s, s.currentPlayer);
      if (depth === 0) return evaluate(s, s.currentPlayer);
      let best = -Infinity;
      for (const a of legalActions(s)) {
        const child = clone(s);
        apply(child, a);
        const boundary = child.roundIndex !== s.roundIndex || child.isTerminal;
        // No alpha-beta, no ordering, and the seat read from the child rather
        // than assumed from the depth.
        const v = boundary
          ? evaluate(child, s.currentPlayer)
          : child.currentPlayer === s.currentPlayer
            ? reference(child, depth - 1)
            : -reference(child, depth - 1);
        if (v > best) best = v;
      }
      return best;
    }

    // Two kinds of position, and the second is the one that bites.
    //
    // At the same-seat root above, every boundary child hands the round back to
    // the seat that moved — so `evaluate(child, s.currentPlayer)` and
    // `evaluate(child, child.currentPlayer)` are the *same call* there, and a
    // flipped perspective is invisible. Verified: mutating both call sites in
    // `search.ts` left the whole suite green when this test used only that
    // root. Positions whose boundary children flip the seat are what make the
    // perspective observable, and they are the common case.
    const roots: AzulState[] = [root!];
    for (const seed of [1, 7, 99, 4242]) {
      for (const n of [7, 8, 9]) {
        const candidate = at(seed, n);
        if (!candidate.isTerminal) roots.push(candidate);
      }
    }

    // The reference is full-width with no pruning, so depth 3 costs about b³ a
    // root — over thirteen roots that is most of [B4-60]'s budget. Depth 3 goes
    // to the two roots that discriminate (the same-seat one, and one whose
    // boundaries flip the seat); the rest are checked at 1 and 2, which is
    // where a sign error shows up anyway.
    for (const [index, position] of roots.entries()) {
      const depths = index <= 1 ? [1, 2, 3] : [1, 2];
      for (const depth of depths) {
        const mine = search(clone(position), {
          maxDepth: depth,
          nodes: Number.MAX_SAFE_INTEGER,
          milliseconds: 60_000,
        });
        expect(mine.value, `root ${index} depth ${depth}`).toBeCloseTo(
          reference(clone(position), depth),
          9,
        );
      }
    }
  }, GAME_TIMEOUT_MS);
});

describe('determinism [B4-30], [B4-31]', () => {
  it('[B4-54] [B4-30] chooses the same move, value and node count twice', () => {
    // A modest budget across the whole corpus: determinism is a property of
    // every search, not of a deep one, and [B4-60] budgets this suite at 30 s.
    for (const position of views()) {
      const first = chooseMove(position, { tier: 'sharp', nodes: 2000 });
      const second = chooseMove(position, { tier: 'sharp', nodes: 2000 });
      expect(second).toEqual(first);
    }
  });

  it('[B4-54] [B4-30] is unchanged by a round trip through toJSON', () => {
    for (const position of views()) {
      const direct = chooseMove(position, CHEAP);
      const roundTripped = chooseMove(JSON.parse(JSON.stringify(position)) as AzulJSON, CHEAP);
      expect(roundTripped).toEqual(direct);
    }
  });

  it('[B4-3] is unaffected by another search running between two calls', () => {
    const position = views()[1];
    const alone = chooseMove(position, CHEAP);
    chooseMove(views()[3], { tier: 'sharp', nodes: 5000 });
    chooseMove(views()[4], { tier: 'easy' });
    expect(chooseMove(position, CHEAP)).toEqual(alone);
  });

  /**
   * [B4-44]: the barrier, as a regression guard. Trivially true while the bot
   * is handed an `AzulJSON` — `toJSON` reports counts, so two states differing
   * only in bag order *are* the same view. The day someone widens the seam to
   * pass a state, this is the test that fails, and it fails for the right
   * reason.
   */
  it('[B4-55] [B4-44] chooses the same move whatever order the bag is in', () => {
    for (const seed of [11, 77, 4242]) {
      const s = at(seed, 12);
      if (s.isTerminal) continue;
      const base = chooseMove(toJSON(s), CHEAP);
      for (const permute of [
        (b: number[]) => b.slice().reverse(),
        (b: number[]) => b.slice().sort((x, y) => y - x),
        (b: number[]) => [...b.slice(7), ...b.slice(0, 7)],
      ]) {
        const other = clone(s);
        other.bag = permute(s.bag) as typeof other.bag;
        expect(chooseMove(toJSON(other), CHEAP)).toEqual(base);
      }
    }
  });
});

describe('bad arguments [B4-39]', () => {
  it('[B4-39] throws a TypeError on an unknown tier', () => {
    expect(() => chooseMove(views()[0], { tier: 'brutal' as never })).toThrow(TypeError);
  });

  it('[B4-39] throws a TypeError on a non-positive or fractional override', () => {
    for (const nodes of [0, -1, 1.5, Number.NaN]) {
      expect(() => chooseMove(views()[0], { tier: 'sharp', nodes }), `nodes ${nodes}`).toThrow(
        TypeError,
      );
    }
    for (const milliseconds of [0, -5, 2.5]) {
      expect(() =>
        chooseMove(views()[0], { tier: 'sharp', milliseconds }),
      ).toThrow(TypeError);
    }
  });
});
