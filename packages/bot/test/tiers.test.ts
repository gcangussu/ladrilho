/**
 * The three tiers [B4-32] through [B4-38], and the property test that plays
 * whole games at each [B4-52], [B4-53].
 *
 * The claim these exist to defend is intent 0003's: the settings are "actually
 * different, not just slower versions of each other". They differ in **how far
 * ahead each can see**, and the sharpest consequence is that `easy` never looks
 * at the reply and therefore *cannot* play denial — which is [B4-37], and which
 * a single witnessing pair falsifies if it is wrong.
 *
 * How strong each tier actually is belongs to *0005 — Opponent strength*: a
 * winrate needs a match, a match needs many games, and many games do not
 * belong in a suite budgeted at 30 seconds [B4-60].
 */

import { describe, expect, it } from 'vitest';
import {
  apply,
  clone,
  fromCanonical,
  legalActions,
  newGame,
  tileCensus,
  toCanonical,
  toJSON,
  type AzulJSON,
  type AzulState,
} from 'engine';
import { BUDGETS, TIERS, chooseMove, type Tier } from '../src/index.js';

/**
 * Modest budgets throughout, and explicit timeouts on the game-playing tests.
 *
 * Neither is a smell, and both are the same cause: through Vitest's module
 * runner every cross-package import is a getter call, and this package crosses
 * into the engine on every node it expands — so the search reads about a tenth
 * of its real throughput here. `bench/bundle.mjs` measures the shipped figure
 * (~319k nodes/sec against ~30k here). Optimising these tests would be
 * optimising the tooling tax; the budget is what keeps [B4-60]'s 30 seconds.
 *
 * `sharp`'s real 400 000 is exercised in `bench`, never in the fast suite.
 */
const TEST_NODES = 3000;

/** Long enough to absorb the tax above, short enough to fail a hang. */
const GAME_TIMEOUT_MS = 30_000;

function options(tier: Tier): { tier: Tier; nodes?: number } {
  return tier === 'sharp' ? { tier, nodes: TEST_NODES } : { tier };
}

function at(seed: number, n: number): AzulState {
  const s = newGame(seed);
  for (let i = 0; i < n && !s.isTerminal; i++) apply(s, legalActions(s)[0]);
  return s;
}

describe('the tier set [B4-32]', () => {
  it('[B4-32] is exactly three tiers, in strength order', () => {
    expect([...TIERS]).toEqual(['easy', 'steady', 'sharp']);
  });

  it('[B4-33] [B4-34] [B4-35] gives each tier the budget the spec fixes', () => {
    expect(BUDGETS.easy).toBe(180); // ACTION_SPACE [0001 E1-6]
    expect(BUDGETS.steady).toBe(20_000);
    expect(BUDGETS.sharp).toBe(400_000);
  });

  it('[B4-33] searches only its own move, and reports depth 1', () => {
    for (const seed of [1, 55, 900]) {
      const position = toJSON(at(seed, 6));
      const choice = chooseMove(position, { tier: 'easy' });
      expect(choice.depth).toBe(1);
      // One node per legal action and not one more: nothing below them.
      expect(choice.nodes).toBe(position.legalActions.length);
      expect(choice.curtailed).toBe(false);
    }
  });

  it('[B4-34] sees further than easy', () => {
    const position = toJSON(at(1, 0));
    expect(chooseMove(position, { tier: 'steady' }).depth).toBeGreaterThan(
      chooseMove(position, { tier: 'easy' }).depth,
    );
  });

  it('[B4-35] deepens further than steady when given the room', () => {
    const position = toJSON(at(1, 4));
    const steady = chooseMove(position, { tier: 'steady' });
    const sharp = chooseMove(position, { tier: 'sharp', nodes: 60_000 });
    expect(sharp.depth).toBeGreaterThanOrEqual(steady.depth);
    expect(sharp.nodes).toBeGreaterThan(steady.nodes);
  });
});

/**
 * [B4-37]. A pure self-maximiser's choice is invariant under *every* change to
 * the opponent's board, so one witnessing pair falsifies it — and the same pair
 * shows `easy` is invariant, which is [B4-33]'s point made observable.
 */
describe('denial [B4-37], [B4-38]', () => {
  /**
   * The same position with the opponent's row 0 filled in, and **nothing
   * else** different.
   *
   * The edit has to conserve tiles or the position is not one the engine could
   * ever reach: every wall cell it sets is paid for out of the bag, and every
   * pattern-line tile it clears is moved to the lid. An earlier version simply
   * set the cells, which invented four tiles and made 76 of 80 candidates
   * unlawful — the census guard below was silently rejecting almost everything
   * and the test looked like a failure of the search rather than of the
   * fixture.
   *
   * The mover's own wall, lines, floor and score are untouched and no source is
   * touched, so its legal actions are identical by construction — asserted
   * rather than assumed.
   */
  function withOpponentRowFilled(s: AzulState, cells: number): AzulState | null {
    const them = (1 - s.currentPlayer) as 0 | 1;
    const c = toCanonical(s);
    c.plColor[them] = c.plColor[them].slice();
    c.plCount[them] = c.plCount[them].slice();
    c.walls[them] = c.walls[them].slice();
    c.lid = c.lid.slice();
    c.bag = c.bag.slice();

    // Pattern-line tiles go to the lid: moved, not destroyed.
    for (let r = 0; r < 5; r++) {
      if (c.plCount[them][r] > 0) c.lid[c.plColor[them][r]] += c.plCount[them][r];
      c.plColor[them][r] = -1;
      c.plCount[them][r] = 0;
    }
    // Wall tiles come out of the bag. Row 0's column `col` is colour `col`
    // [0001 E1-1], and if the bag has none of it the fixture is not available
    // in this position.
    for (let col = 0; col < cells; col++) {
      if (c.walls[them][col] === 1) continue;
      const index = c.bag.indexOf(col as 0 | 1 | 2 | 3 | 4);
      if (index === -1) return null;
      c.bag.splice(index, 1);
      c.walls[them][col] = 1;
    }
    return fromCanonical(c, 0);
  }

  it('[B4-56] [B4-37] exhibits a position where the opponent’s board changes the move', () => {
    let witnesses = 0;
    let compared = 0;
    for (let seed = 1; seed <= 40 && witnesses === 0; seed++) {
      for (const n of [2, 4, 6, 8]) {
        const s = at(seed, n);
        if (s.isTerminal) continue;
        const loaded = withOpponentRowFilled(s, 4);
        if (loaded === null) continue;

        // The fixture must be a position the engine could have reached.
        expect(tileCensus(loaded), `seed ${seed} ply ${n}`).toEqual([20, 20, 20, 20, 20]);

        const before = toJSON(s);
        const after = toJSON(loaded);
        // Same options, different consequences: that is the whole design.
        expect(after.legalActions, `seed ${seed} ply ${n}`).toEqual(before.legalActions);
        compared++;

        const plain = chooseMove(before, { tier: 'sharp', nodes: 6000 });
        const versus = chooseMove(after, { tier: 'sharp', nodes: 6000 });
        if (plain.action !== versus.action) {
          witnesses++;
          // And `easy`, which never looks at the reply, is unmoved by it —
          // which is [B4-33]'s "structurally incapable of denial", observed.
          expect(chooseMove(before, { tier: 'easy' }).action).toBe(
            chooseMove(after, { tier: 'easy' }).action,
          );
          break;
        }
      }
    }
    // One comparison is enough — a single witnessing pair falsifies "the choice
    // ignores the opponent", which is the whole claim. This guard exists only
    // so a fixture that silently built nothing cannot masquerade as a pass.
    expect(compared, 'no lawful fixture was built at all — the test proved nothing').toBeGreaterThan(
      0,
    );
    expect(
      witnesses,
      'no position found where the opponent’s board changes the move — the search is ' +
        'maximising its own board only, which is [B4-37] failing',
    ).toBeGreaterThan(0);
  }, GAME_TIMEOUT_MS);

  it('[B4-56] [B4-38] will take tiles onto its own floor line when that is the move', () => {
    // The floor destination is 5 [0001 E1-6]; a move that takes there scores
    // negatively for us and is only ever chosen for what it denies or avoids.
    let floorMoves = 0;
    // Stops at the first witness rather than finishing the game: one move to
    // the floor is the whole claim, and the suite has 30 seconds [B4-60].
    outer: for (let seed = 1; seed <= 12; seed++) {
      const s = newGame(seed);
      let plies = 0;
      while (!s.isTerminal && plies < 40) {
        const choice = chooseMove(toJSON(s), { tier: 'sharp', nodes: 1500 });
        if (choice.action % 6 === 5) {
          floorMoves++;
          break outer;
        }
        apply(s, choice.action);
        plies++;
      }
    }
    expect(
      floorMoves,
      'the bot never once took to its own floor — [B4-38] says that move must be reachable',
    ).toBeGreaterThan(0);
  }, GAME_TIMEOUT_MS);
});

/**
 * [B4-52], [B4-53]: whole games at every tier, from recorded seeds, asserting
 * the invariants at every ply. A failure names the seed and the ply, because a
 * property failure nobody can reproduce is one nobody can fix.
 */
describe('whole games at every tier [B4-52], [B4-53]', () => {
  const SEEDS = [11, 4242, 20260906];

  for (const tier of ['easy', 'steady', 'sharp'] as Tier[]) {
    // `sharp` searches every ply of every game, so it gets one seed; the
    // cheaper tiers get all three. [B4-60] budgets this suite at 30 seconds.
    const seeds = tier === 'sharp' ? SEEDS.slice(0, 1) : SEEDS;
    it(`[B4-52] [B4-53] ${tier} plays complete, lawful games`, () => {
      for (const seed of seeds) {
        const s = newGame(seed);
        let plies = 0;
        while (!s.isTerminal) {
          const where = `seed ${seed} ply ${plies}`;
          const rootRound = s.roundIndex;
          const position = toJSON(s);
          const choice = chooseMove(position, options(tier));

          // [B4-42] the move is legal in the position it was asked about.
          expect(position.legalActions, where).toContain(choice.action);
          // [B4-45] the budget was respected.
          expect(choice.nodes, where).toBeLessThanOrEqual(
            tier === 'sharp' ? TEST_NODES : BUDGETS[tier],
          );
          // [B4-46] nothing it reported can describe a later round than the root.
          expect(s.roundIndex, where).toBe(rootRound);

          apply(s, choice.action);
          plies++;
          // [0001 E1-40] the engine's own census, at every ply.
          expect(tileCensus(s), where).toEqual([20, 20, 20, 20, 20]);
          expect(plies, `${where}: game did not terminate`).toBeLessThan(400);
        }
        expect(s.isTerminal).toBe(true);
      }
    }, GAME_TIMEOUT_MS);
  }

  it('[B4-53] leaves the position it was handed untouched across a whole game', () => {
    const s = newGame(77);
    while (!s.isTerminal) {
      const position: AzulJSON = toJSON(s);
      const before = structuredClone(position);
      const choice = chooseMove(position, { tier: 'steady' });
      expect(position).toEqual(before);
      apply(s, choice.action);
    }
  });

  it('[B4-30] replays a whole game identically', () => {
    const record = (): number[] => {
      const s = newGame(4242);
      const actions: number[] = [];
      while (!s.isTerminal) {
        const action = chooseMove(toJSON(s), { tier: 'sharp', nodes: TEST_NODES }).action;
        actions.push(action);
        apply(s, action);
      }
      return actions;
    };
    expect(record()).toEqual(record());
  }, GAME_TIMEOUT_MS);
});

/** `clone` must not change what the bot does with a position [0001 E1-48]. */
describe('cloning', () => {
  it('[B4-30] chooses identically from a clone', () => {
    for (const seed of [5, 500]) {
      const s = at(seed, 10);
      if (s.isTerminal) continue;
      expect(chooseMove(toJSON(clone(s)), { tier: 'steady' })).toEqual(
        chooseMove(toJSON(s), { tier: 'steady' }),
      );
    }
  });
});
