import { bench, describe } from 'vitest';
import { apply, clone, legalActions, newGame, Rng } from '../src/index.js';

/**
 * The budgets in [E1-58] and [E1-59]. Explicitly non-gating: a regression here
 * is a bug to file, not a failing build, which is why these live in `bench`
 * and not in the test suite.
 */

/** A fixed script of plies, so every iteration does identical work. */
function recordGame(seed: number): { actions: number[]; plies: number } {
  const s = newGame(seed);
  const rng = new Rng(seed);
  const actions: number[] = [];
  while (!s.isTerminal) {
    const legal = legalActions(s);
    const a = legal[rng.below(legal.length)];
    actions.push(a);
    apply(s, a);
  }
  return { actions, plies: actions.length };
}

const GAME = recordGame(20260903);
const START = newGame(20260903);

describe(`legalActions + apply — plies/second is the reported hz times ${GAME.plies} [E1-58]`, () => {
  bench(`one ${GAME.plies}-ply game`, () => {
    const s = clone(START);
    for (const a of GAME.actions) {
      legalActions(s);
      apply(s, a);
    }
  });
});

describe('clone — microseconds each is 1e6 divided by the reported hz [E1-59]', () => {
  const mid = clone(START);
  for (const a of GAME.actions.slice(0, 40)) apply(mid, a);
  bench('mid-game position', () => {
    clone(mid);
  });
});
