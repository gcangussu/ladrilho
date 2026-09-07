/**
 * The contract between the bot and everything either side of it: the engine
 * additions it cannot work without [B4-9], [B4-10], [B4-58], the shape of the
 * position it is handed [B4-5], and the promise that choosing a move is a plain
 * synchronous call [B4-4].
 *
 * The corpus-wide checks on the engine additions live in the engine's own suite
 * — `packages/engine/test/score.test.ts` replays every recorded game against
 * [0001 E1-68] and rebuilds every recorded position through [0001 E1-69]. What
 * is asserted here is the narrower thing this package actually depends on, and
 * it is asserted here because a change to the engine that kept its own tests
 * green could still break the bot.
 */

import { describe, expect, it } from 'vitest';
import {
  apply,
  fromJSON,
  legalActions,
  newGame,
  placementValue,
  toJSON,
  wallCompletedColors,
  wallCompletedCols,
  wallCompletedRows,
  type AzulJSON,
  type AzulState,
} from 'engine';
import { chooseMove, evaluate } from '../src/index.js';

function at(seed: number, n: number): AzulState {
  const s = newGame(seed);
  for (let i = 0; i < n && !s.isTerminal; i++) apply(s, legalActions(s)[0]);
  return s;
}

describe('the engine additions the bot needs [B4-9], [B4-10], [B4-58]', () => {
  it('[B4-58] [B4-9] exports a per-tile placement value that scores adjacency', () => {
    const empty = new Array<number>(25).fill(0);
    expect(placementValue(empty, 2, 2)).toBe(1);
    const withRun = empty.slice();
    withRun[2 * 5 + 0] = 1;
    withRun[2 * 5 + 1] = 1;
    expect(placementValue(withRun, 2, 2)).toBe(3);
    // Pure: the wall it is handed is not touched [0001 E1-51].
    const before = withRun.slice();
    placementValue(withRun, 2, 2);
    expect(withRun).toEqual(before);
  });

  it('[B4-58] exports wall-shaped completion counters [0001 E1-70]', () => {
    const wall = new Array<number>(25).fill(0);
    expect(wallCompletedRows(wall)).toBe(0);
    for (let col = 0; col < 5; col++) wall[col] = 1;
    expect(wallCompletedRows(wall)).toBe(1);
    expect(wallCompletedCols(wall)).toBe(0);
    const full = new Array<number>(25).fill(1);
    expect(wallCompletedRows(full)).toBe(5);
    expect(wallCompletedCols(full)).toBe(5);
    expect(wallCompletedColors(full)).toBe(5);
  });

  it('[B4-58] [B4-10] rebuilds a position from the view, legalActions intact', () => {
    for (const seed of [1, 77, 4242]) {
      for (const n of [0, 9, 23, 41]) {
        const s = at(seed, n);
        if (s.isTerminal) continue;
        const json = toJSON(s);
        const rebuilt = fromJSON(json, 0);
        expect(legalActions(rebuilt), `seed ${seed} ply ${n}`).toEqual(json.legalActions);
        expect(rebuilt.tilesLeft).toBe(json.tilesLeft);
        // And the rebuild is worth the same as the original, which is what
        // makes searching the rebuild equivalent to searching the position.
        expect(evaluate(rebuilt, rebuilt.currentPlayer)).toBeCloseTo(
          evaluate(s, s.currentPlayer),
          9,
        );
      }
    }
  });
});

/**
 * [B4-5]. The barrier is the transport: `toJSON` reports the bag as counts and
 * never its order [0001 E1-52], so there is no order in a position for the bot
 * to leak. This asserts the *shape* — that what crosses is a plain view and
 * nothing state-like rides along.
 */
describe('the bot is handed a view, not a state [B4-5]', () => {
  it('[B4-5] takes a position that carries counts rather than a bag order', () => {
    const position = toJSON(at(9, 15));
    // The view's bag is five counts, not eighty tiles.
    expect(position.bag).toHaveLength(5);
    expect(position.bag.every((n) => Number.isInteger(n))).toBe(true);
    // It is plain data all the way down, so it can cross a worker boundary.
    expect(structuredClone(position)).toEqual(position);
    // And it is enough on its own: nothing else is passed.
    expect(() => chooseMove(position, { tier: 'easy' })).not.toThrow();
  });

  it('[B4-5] works from a position that has been through JSON, losing every prototype', () => {
    const position = toJSON(at(9, 15));
    const flattened = JSON.parse(JSON.stringify(position)) as AzulJSON;
    expect(chooseMove(flattened, { tier: 'steady' })).toEqual(
      chooseMove(position, { tier: 'steady' }),
    );
  });
});

/**
 * [B4-4]. Keeping the page alive is done by *where* this runs — a worker, which
 * is *0006 — Opponent in the interface*'s — not by yielding inside it. So this
 * must be an ordinary blocking call that schedules nothing.
 */
describe('choosing a move is synchronous [B4-4]', () => {
  it('[B4-4] returns a value rather than a promise', () => {
    const choice = chooseMove(toJSON(at(3, 7)), { tier: 'easy' });
    expect(choice).not.toBeInstanceOf(Promise);
    expect(typeof choice.action).toBe('number');
  });

  it('[B4-4] schedules no work', () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const names = ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'requestAnimationFrame'];
    const saved: Record<string, unknown> = {};
    const boom = (name: string) => (): never => {
      throw new Error(`the bot scheduled work via ${name} [B4-4]`);
    };
    const realPromise = globalThis.Promise;
    for (const name of names) {
      saved[name] = globals[name];
      globals[name] = boom(name);
    }
    try {
      const choice = chooseMove(toJSON(at(3, 7)), { tier: 'steady' });
      expect(choice.action).toBeGreaterThanOrEqual(0);
      // A promise would need a microtask to settle, and there is none to be had.
      expect(globalThis.Promise).toBe(realPromise);
    } finally {
      for (const name of names) globals[name] = saved[name];
    }
  });
});

/**
 * [B4-23], [B4-24]: the anytime contract. A search stopped partway through an
 * iteration reports the *previous* iteration's answer, never a partial one — an
 * unfinished iteration has searched its first few root moves against a real
 * window and the rest against nothing, so its best is the best of an arbitrary
 * prefix rather than of the position.
 */
describe('anytime behaviour [B4-23], [B4-24]', () => {
  /**
   * Asserted on **node counts**, not on the chosen action.
   *
   * Comparing actions does not discriminate: [B4-22] pulls the previous best
   * to the front of the next iteration, so an implementation that wrongly
   * returned its partial best would report the same action, and the comparison
   * search uses the *reported* depth — making the test self-consistent under
   * both implementations. Measured at these seeds, the action was identical at
   * the stopped depth, one deeper, and in the stopped search.
   *
   * Work is what tells them apart. A search that stopped after completing
   * depth D has spent at least a full depth-D pass; one that returned a
   * partial depth-D+1 answer would have to have spent less than a full
   * depth-D+1 pass. So `stopped.nodes >= exact(depth D).nodes` holds for a
   * correct implementation and fails for the broken one, by a wide margin and
   * without depending on where the budget happens to land.
   */
  it('[B4-23] [B4-24] reports a depth it actually finished, not a partial one', async () => {
    const { search } = await import('../src/search.js');
    for (const seed of [1, 88, 4242]) {
      const root = at(seed, 2);
      if (root.isTerminal) continue;
      const stopped = chooseMove(toJSON(root), { tier: 'sharp', nodes: 777 });
      expect(stopped.depth).toBeGreaterThanOrEqual(1);

      const exact = search(fromJSON(toJSON(root), 0), {
        maxDepth: stopped.depth,
        nodes: Number.MAX_SAFE_INTEGER,
        milliseconds: 60_000,
      });
      expect(exact.action, `seed ${seed}`).toBe(stopped.action);
      expect(exact.value).toBeCloseTo(stopped.value, 9);
      // The discriminating clause: it paid for the depth it claims.
      expect(
        stopped.nodes,
        `seed ${seed}: reported depth ${stopped.depth} but spent fewer nodes than a full pass`,
      ).toBeGreaterThanOrEqual(exact.nodes);
    }
  });

  it('[B4-23] deepens monotonically as the budget grows', () => {
    const position = toJSON(at(1, 0));
    let previous = 0;
    for (const nodes of [200, 1000, 5000, 20_000]) {
      const depth = chooseMove(position, { tier: 'sharp', nodes }).depth;
      expect(depth, `budget ${nodes}`).toBeGreaterThanOrEqual(previous);
      previous = depth;
    }
  });

  /**
   * Node counts, not actions: an ordering that varied between runs would search
   * a different number of nodes even where it happened to agree on the move.
   * The ordering's *content* — that iteration N+1 opens with iteration N's best
   * — is [B4-22], asserted in `search.test.ts` where the spy lives.
   */
  it('[B4-21] does the same work on repeated searches of the same position', () => {
    const position = toJSON(at(5, 3));
    const runs = [0, 1, 2].map(() => chooseMove(position, { tier: 'sharp', nodes: 4000 }));
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(runs[0].nodes).toBeGreaterThan(1);
  });
});
