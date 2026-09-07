import { test } from 'vitest';
import { apply, legalActions, newGame, toJSON, type AzulState } from 'engine';
import { chooseMove } from '../src/index.js';

/**
 * The budgets in [B4-47] through [B4-50]. Explicitly non-gating: a regression
 * here is a bug to file, not a failing build, which is why these live in
 * `bench` and not in the test suite.
 */

/** A position `n` plies into a seeded game. */
function at(seed: number, n: number): AzulState {
  const s = newGame(seed);
  for (let i = 0; i < n && !s.isTerminal; i++) apply(s, legalActions(s)[0]);
  return s;
}

const ROUND_START = toJSON(at(20260906, 0));
const MID_ROUND = toJSON(at(20260906, 5));
const choose = chooseMove;

// A single `sharp` call is over a second at 400 000 nodes, so the default
// sample count needs a timeout well past Vitest's own.
test('sharp — seconds per move is 1e3 divided by the reported hz [B4-47]', async ({ bench }) => {
  await bench('first ply of a round, 400k nodes', () => {
    choose(ROUND_START, { tier: 'sharp' });
  }).run();
}, 300_000);

test('steady — milliseconds per move [B4-49]', async ({ bench }) => {
  await bench('first ply of a round', () => {
    choose(ROUND_START, { tier: 'steady' });
  }).run();
});

test('easy — milliseconds per move [B4-49]', async ({ bench }) => {
  await bench('first ply of a round', () => {
    choose(ROUND_START, { tier: 'easy' });
  }).run();
});

test('node rate — nodes/sec is hz times the node count [B4-50]', async ({ bench }) => {
  await bench('mid-round, 50k nodes', () => {
    choose(MID_ROUND, { tier: 'sharp', nodes: 50_000 });
  }).run();
});
