/**
 * Sessions [A8-23] through [A8-29], and the properties a whole game must keep
 * [A8-40], [A8-41], [A8-42].
 *
 * A session is the node table for one seat of one game, because the original
 * keeps its tree for the length of a game. So "the same position gets the same
 * move every time" is read as "the same game gets the same moves" [A8-27], and
 * a fresh session's first choice is still a pure function of the position.
 */

import { describe, expect, it } from 'vitest';
import { chooseMove } from 'bot';
import {
  apply,
  fromJSON,
  legalActions,
  newGame,
  toJSON,
  type AzulJSON,
  type AzulState,
} from 'engine';
import { createExpert } from '../src/index.js';
import { createSession } from '../src/session.js';
import { toTheirAction } from '../src/actions.js';
import { visitCounts } from '../src/search.js';
import { encodeBoard } from '../src/board.js';
import { universeRoot } from '../src/universe.js';
import type { Evaluator } from '../src/search.js';

/** Uniform over the legal actions, value nil: enough to drive the plumbing. */
const STUB: Evaluator = {
  normalised: false,
  evaluate(_board, legal) {
    const policy = new Float32Array(180);
    let count = 0;
    for (const bit of legal) count += bit;
    for (let a = 0; a < 180; a++) policy[a] = legal[a] === 1 ? 1 / count : 0;
    return { policy, value: new Float32Array([0, 0]) };
  },
};

/** A position a few plies into a recorded game. */
function position(seed: number, plies: number): AzulJSON {
  const s = newGame(seed);
  for (let i = 0; i < plies; i++) apply(s, legalActions(s)[0]);
  return toJSON(s);
}

describe('what a session promises [A8-23], [A8-24], [A8-29]', () => {
  it('[A8-23] runs exactly the simulations it was asked for', () => {
    const session = createSession(STUB, { simulations: 25 });
    const start = position(7, 3);
    const choice = session.choose(start);
    expect(choice.simulations).toBe(25);
    const counts = visitCounts(session.table, encodeBoard(toJSON(universeRoot(start))))!;
    // The first simulation expands the root and returns before any edge is
    // taken, as the original's does, so the root carries one less.
    expect([...counts].reduce((a, b) => a + b)).toBe(24);
  });

  it('[A8-23] adds to what the session already holds', () => {
    const session = createSession(STUB, { simulations: 20 });
    const start = position(7, 3);
    session.choose(start);
    const first = session.table.size;
    const again = session.choose(start);
    const counts = visitCounts(session.table, encodeBoard(toJSON(universeRoot(start))))!;
    // 19 from the first call — its first simulation expanded the root — and
    // 20 from the second, which found the root already there.
    expect([...counts].reduce((a, b) => a + b)).toBe(39)
    expect(again.rootVisits).toBeGreaterThan(0);
    // [A8-17]: the table only grows, and only during `choose`.
    expect(session.table.size).toBeGreaterThanOrEqual(first);
  });

  it('[A8-24] plays the most-visited action, ties to the lowest of their indices', () => {
    const session = createSession(STUB, { simulations: 30 });
    const start = position(11, 5);
    const choice = session.choose(start);
    const counts = visitCounts(session.table, encodeBoard(toJSON(universeRoot(start))))!;
    const best = Math.max(...counts);
    expect(counts[toTheirAction(choice.action)]).toBe(best);
    const tied = [...counts.keys()].filter((a) => counts[a] === best);
    expect(toTheirAction(choice.action)).toBe(Math.min(...tied));
    expect(choice.rootVisits).toBe(best);
  });

  it('[A8-24] reports the root’s running value, which is not points', () => {
    const session = createSession(STUB, { simulations: 10 });
    const choice = session.choose(position(3, 4));
    expect(choice.value).toBeGreaterThanOrEqual(-1);
    expect(choice.value).toBeLessThanOrEqual(1);
    expect(Math.fround(choice.value)).toBe(choice.value); // float32 [A8-50]
  });

  it('[A8-29] returns plain data that survives a structured clone', () => {
    const choice = createSession(STUB, { simulations: 5 }).choose(position(3, 4));
    expect(structuredClone(choice)).toEqual(choice);
    expect(Object.keys(choice).sort()).toEqual(['action', 'rootVisits', 'simulations', 'value']);
  });

  it('[A8-5] is handed a position and nothing else, so two states that look alike are alike', () => {
    // A session builds every state it searches from the `AzulJSON` it was
    // given. Two engine states that produce the same view — here one dealt by
    // the engine and one loaded back from that view with a different seed —
    // are therefore indistinguishable to it, whatever their bags hold.
    const dealt = newGame(31);
    for (let i = 0; i < 5; i++) apply(dealt, legalActions(dealt)[0]);
    const view = toJSON(dealt);
    const reloaded = toJSON(fromJSON(view, 987_654));
    expect(reloaded).toEqual(view);
    expect(createSession(STUB, { simulations: 12 }).choose(view)).toEqual(
      createSession(STUB, { simulations: 12 }).choose(reloaded),
    );
  });

  it('[A8-21] leaves the position it was handed alone', () => {
    const start = position(5, 6);
    const before = structuredClone(start);
    createSession(STUB, { simulations: 15 }).choose(start);
    expect(start).toEqual(before);
  });
});

describe('what a session refuses [A8-25], [A8-26], [A8-28], [A8-42]', () => {
  it('[A8-42] only ever returns a legal action', () => {
    const session = createSession(STUB, { simulations: 12 });
    const s = newGame(19);
    for (let ply = 0; ply < 6; ply++) {
      const view = toJSON(s);
      if (view.currentPlayer === 0) {
        const choice = session.choose(view);
        expect(view.legalActions).toContain(choice.action);
        apply(s, choice.action);
      } else {
        apply(s, legalActions(s)[0]);
      }
    }
  });

  it('[A8-25] throws on a finished game and on a position with no moves', () => {
    const finished: AzulJSON = { ...position(3, 2), isTerminal: true };
    expect(() => createSession(STUB).choose(finished)).toThrow(/over/);
    const stuck: AzulJSON = { ...position(3, 2), legalActions: [] };
    expect(() => createSession(STUB).choose(stuck)).toThrow(/no legal actions/);
  });

  it('[A8-26] serves one seat, and throws when asked about the other', () => {
    const session = createSession(STUB, { simulations: 5 });
    const s = newGame(21);
    const first = toJSON(s);
    session.choose(first);
    apply(s, legalActions(s)[0]);
    const other = toJSON(s);
    expect(other.currentPlayer).not.toBe(first.currentPlayer);
    expect(() => session.choose(other)).toThrow(/seat/);
  });

  it('[A8-28] throws a TypeError on a simulations override that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => createSession(STUB, { simulations: bad }), `${bad}`).toThrow(TypeError);
    }
    expect(() => createSession(STUB, { simulations: 1 })).not.toThrow();
  });
});

describe('whole games [A8-27], [A8-40], [A8-41]', () => {
  /** Plays a game out, `expert` on `seat`, `bot`'s easy tier opposite. */
  function playGame(seed: number, seat: number, simulations: number): number[] {
    const s: AzulState = newGame(seed);
    const expert = createExpert({ simulations });
    const actions: number[] = [];
    let plies = 0;
    while (!s.isTerminal && plies < 400) {
      const view = toJSON(s);
      const action =
        view.currentPlayer === seat
          ? expert.choose(view).action
          : chooseMove(view, { tier: 'easy' }).action;
      expect(view.legalActions).toContain(action);
      apply(s, action);
      actions.push(action);
      plies++;
    }
    expect(s.isTerminal, `seed ${seed} did not finish`).toBe(true);
    return actions;
  }

  it('[A8-40] plays whole games against bot’s tiers, and they end', () => {
    for (const [seed, seat] of [[101, 0], [202, 1]] as const) {
      const actions = playGame(seed, seat, 4);
      expect(actions.length).toBeGreaterThan(20);
    }
  });

  it('[A8-40] plays whole games against itself, one session per seat', () => {
    const s = newGame(303);
    const sessions = [createExpert({ simulations: 4 }), createExpert({ simulations: 4 })];
    let plies = 0;
    while (!s.isTerminal && plies < 400) {
      const view = toJSON(s);
      apply(s, sessions[view.currentPlayer].choose(view).action);
      plies++;
    }
    expect(s.isTerminal).toBe(true);
  });

  it('[A8-27] two fresh sessions given the same positions choose the same moves', () => {
    const replay = (): { action: number; value: number; rootVisits: number }[] => {
      const s = newGame(404);
      const expert = createExpert({ simulations: 6 });
      const choices = [];
      for (let ply = 0; ply < 14 && !s.isTerminal; ply++) {
        const view = toJSON(s);
        if (view.currentPlayer === 0) {
          const choice = expert.choose(view);
          choices.push({ action: choice.action, value: choice.value, rootVisits: choice.rootVisits });
          apply(s, choice.action);
        } else {
          apply(s, legalActions(s)[0]);
        }
      }
      return choices;
    };
    const first = replay();
    expect(first.length).toBeGreaterThan(5);
    expect(replay()).toEqual(first);
  });

  it('[A8-41] is unaffected by the order of the bag it is told about', () => {
    // Vacuous by construction today: `AzulJSON` reports the bag as counts, so
    // there is no order to permute. Kept as the guard that fails the day
    // someone widens the seam to hand this package a state, exactly as
    // [0004 B4-55] keeps its twin.
    const start = position(77, 8);
    const baseline = createExpert({ simulations: 6 }).choose(start);
    for (const permutation of [
      [1, 0, 2, 3, 4],
      [4, 3, 2, 1, 0],
      [2, 4, 0, 3, 1],
    ]) {
      const permuted: AzulJSON = structuredClone(start);
      permuted.bag = permutation.map((c) => start.bag[c]);
      // A permuted count vector is a different bag; permuting it back must
      // give the same position, and the same choice.
      const restored: AzulJSON = structuredClone(permuted);
      for (let c = 0; c < 5; c++) restored.bag[permutation[c]] = permuted.bag[c];
      expect(restored.bag).toEqual(start.bag);
      expect(createExpert({ simulations: 6 }).choose(restored)).toEqual(baseline);
    }
  });
});
