import { test } from 'vitest';
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

/**
 * Vitest 5 runs benchmarks through the module runner, where every reference to
 * an import is a getter call whose overhead lands inside the measurement. Bind
 * the hot functions to locals once so the loops below measure the engine.
 */
const applyLocal = apply;
const cloneLocal = clone;
const legalActionsLocal = legalActions;

test(`legalActions + apply — plies/second is the reported hz times ${GAME.plies} [E1-58]`, async ({ bench }) => {
  await bench(`one ${GAME.plies}-ply game`, () => {
    const s = cloneLocal(START);
    for (const a of GAME.actions) {
      legalActionsLocal(s);
      applyLocal(s, a);
    }
  }).run();
});

test('clone — microseconds each is 1e6 divided by the reported hz [E1-59]', async ({ bench }) => {
  const mid = cloneLocal(START);
  for (const a of GAME.actions.slice(0, 40)) applyLocal(mid, a);
  await bench('mid-game position', () => {
    cloneLocal(mid);
  }).run();
});
