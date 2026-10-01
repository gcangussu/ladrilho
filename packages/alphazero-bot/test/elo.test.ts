/** The pool's Elo arithmetic ([Z11-73]). */

import { describe, expect, it } from 'vitest';
import { ELO_BOUND, ELO_SCALE, expected, fitPool, performance, settle, verdict } from '../eval/elo.js';

describe('Elo ratings [Z11-73]', () => {
  it('expects the logistic score: even at equal ratings, ten to one at 400 points', () => {
    expect(expected(0, 0)).toBe(0.5);
    expect(expected(400, 0)).toBeCloseTo(10 / 11, 12);
    expect(expected(0, 400)).toBeCloseTo(1 / 11, 12);
  });

  /** Mutation, seen red: the expected score's sign reversed. */
  it('rates a performance where the expected score meets the actual one, with its standard error', () => {
    const even = performance([{ opponent: 100, games: 400, score: 200 }]);
    expect(even.rating).toBeCloseTo(100, 6);
    // At an even score the information is games / 4 per ELO_SCALE²: 2·ELO_SCALE/√400.
    expect(even.se).toBeCloseTo((2 * ELO_SCALE) / 20, 6);
    expect(performance([{ opponent: 0, games: 110, score: 100 }]).rating).toBeCloseTo(400, 6);
    // Two opponents: the rating balances the two shortfalls, wherever it lands.
    const two = performance([
      { opponent: 0, games: 200, score: 150 },
      { opponent: 200, games: 200, score: 90 },
    ]);
    const slope = 150 - 200 * expected(two.rating, 0) + 90 - 200 * expected(two.rating, 200);
    expect(Math.abs(slope)).toBeLessThan(1e-6);
    expect(two.rating).toBeGreaterThan(0);
    expect(two.rating).toBeLessThan(200);
  });

  it('stops a clean sweep or a whitewash at the bound', () => {
    expect(performance([{ opponent: 50, games: 30, score: 30 }]).rating).toBeCloseTo(50 + ELO_BOUND, 6);
    expect(performance([{ opponent: 50, games: 30, score: 0 }]).rating).toBeCloseTo(50 - ELO_BOUND, 6);
    expect(() => performance([])).toThrow(/at least one game/);
  });

  /** Mutation, seen red: the anchor fitted with the others. */
  it("recovers a pool's ratings from its own games, the anchor held at 0", () => {
    const truth = [0, 100, 250];
    const games = 300;
    const pairings = [
      [0, 1],
      [0, 2],
      [1, 2],
    ].map(([a, b]) => ({ a, b, games, score: games * expected(truth[a], truth[b]) }));
    const fitted = fitPool(3, pairings, 0);
    fitted.forEach((r, i) => expect(r.rating).toBeCloseTo(truth[i], 2));
    expect(fitted[0].se).toBe(0);
    expect(fitted[1].se).toBeGreaterThan(0);
    // Pinned elsewhere, the same games give the same gaps.
    const shifted = fitPool(3, pairings, 1);
    expect(shifted[1].rating).toBe(0);
    expect(shifted[2].rating - shifted[0].rating).toBeCloseTo(250, 2);
  });

  /**
   * Mutations, seen red: the margin at one standard error; a tie after the
   * extra games going to the challenger.
   */
  it('replaces the weakest champion beyond two standard errors, plays more within them, and keeps it on a tie', () => {
    const c = (rating: number) => ({ rating, se: 10 });
    expect(verdict(c(125), 100)).toBe('replace');
    expect(verdict(c(120), 100)).toBe('replace');
    expect(verdict(c(115), 100)).toBe('more');
    expect(verdict(c(85), 100)).toBe('more');
    expect(verdict(c(80), 100)).toBe('keep');
    expect(settle(c(100.5), 100)).toBe('replace');
    expect(settle(c(100), 100)).toBe('keep');
    expect(settle(c(99), 100)).toBe('keep');
  });
});
