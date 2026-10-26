/**
 * The ship match ([0012 T12-34], [T12-35]): the test on pairs of games, and
 * how its entries name `master`.
 */

import { describe, expect, it } from 'vitest';
import type { AnchorsFile } from '../eval/anchors.js';
import type { LogEntry, ShipEntry } from '../eval/decision.js';
import type { GameRecord } from '../eval/series.js';
import {
  SHIP_TEST,
  addPairs,
  bounds,
  currentMaster,
  llr,
  pendingShips,
  pairedSeeds,
  scoreOf,
  verdict,
  type Pentanomial,
} from '../eval/ship.js';

const game = (index: number, seed: number, points: number): GameRecord => ({
  index, seed, points, scores: [0, 0], plies: 0,
  work: [{ nodes: 0, ms: 0 }, { nodes: 0, ms: 0 }], simulations: {},
});

const ship = (run: string, generation: number, decision: ShipEntry['decision']): LogEntry => ({
  kind: 'ship', run, date: 'd', generation, decision,
  master: decision === 'pin' ? null : { run: 'x', generation: 1 }, reason: 'a reason long enough to read',
});

describe('the ship test [T12-34]', () => {
  /**
   * Mutations, seen red ([Z11-48]): H0 and H1 swapped (`elo0` for `elo1`);
   * the variance left out of the ratio.
   */
  it("is Wald's ratio on pair scores, with fishtest's normal approximation", () => {
    const [lo, hi] = bounds();
    expect(lo).toBeCloseTo(Math.log(0.05 / 0.95), 12);
    expect(hi).toBeCloseTo(Math.log(0.95 / 0.05), 12);
    // A score halfway between H0's and H1's expected scores is evidence for neither.
    const s0 = 0.5;
    const s1 = 1 / (1 + 10 ** (-15 / 400));
    const m = (s0 + s1) / 2;
    // Pairs of ½ and 1 only: 21 wins in 1 000 puts the mean just below m, 22 just above,
    // and the ratio changes sign between them.
    expect(0.5 + 21 * 0.0005).toBeLessThan(m);
    expect(0.5 + 22 * 0.0005).toBeGreaterThan(m);
    expect(llr([0, 0, 979, 0, 21])).toBeLessThan(0);
    expect(llr([0, 0, 978, 0, 22])).toBeGreaterThan(0);
    // Winning every other pair outright and splitting the rest is far above +15 Elo.
    expect(llr([0, 0, 200, 0, 200])).toBeGreaterThan(hi);
    expect(llr([200, 0, 200, 0, 0])).toBeLessThan(lo);
    // The ratio scales with n at a fixed mean and variance, and inversely with the
    // variance at a fixed mean: both below have a mean of ½, variances 0.05 and 0.25.
    expect(llr([10, 0, 30, 0, 20])).toBeCloseTo(2 * llr([5, 0, 15, 0, 10]), 9);
    expect(llr([10, 0, 80, 0, 10])).toBeCloseTo(5 * llr([50, 0, 0, 0, 50]), 9);
    expect(llr([0, 0, 0, 0, 0])).toBe(0);
  });

  /**
   * Mutations, seen red ([Z11-48]): the cap read as accept; the first look
   * ignored once a later one crosses the other bound.
   */
  it('decides at the first look that crosses a bound, and rejects at the cap', () => {
    const small = { ...SHIP_TEST, maxGames: 800, batchPairs: 200 };
    const flat: Pentanomial = [50, 0, 100, 0, 50];
    expect(verdict([flat], small)).toBe('continue');
    expect(verdict([flat, [100, 0, 200, 0, 100]], small)).toBe('reject');
    expect(verdict([[0, 0, 100, 0, 100]], small)).toBe('accept');
    // A look that accepted is not undone by a later one that would reject.
    expect(verdict([[0, 0, 100, 0, 100], [200, 0, 100, 0, 100]], small)).toBe('accept');
    expect(verdict([], small)).toBe('continue');
  });

  /**
   * Mutation, seen red ([Z11-48]): the seeds not doubled, so a seed is played
   * from one seat only.
   */
  it('plays each seed from both seats, and scores the pair', () => {
    expect(pairedSeeds(7, 2)).toEqual([7, 7, 7 + 104729, 7 + 104729]);
    const games = [game(0, 7, 1), game(1, 7, 0), game(2, 9, 1), game(3, 9, 0.5)];
    expect(addPairs([0, 0, 0, 0, 0], games)).toEqual([0, 0, 1, 1, 0]);
    expect(() => addPairs([0, 0, 0, 0, 0], [game(0, 7, 1), game(1, 8, 1)])).toThrow(/one seed/);
    expect(scoreOf([0, 0, 1, 1, 0])).toEqual({ games: 4, score: 0.625 });
  });
});

describe('master in the log [T12-35]', () => {
  /** Mutation, seen red ([Z11-48]): a rejected match counted as naming master. */
  it('is the latest accepted or pinned', () => {
    expect(currentMaster([])).toBeNull();
    expect(currentMaster([ship('a', 1, 'pin')])).toEqual({ run: 'a', generation: 1 });
    expect(currentMaster([ship('a', 1, 'pin'), ship('b', 2, 'reject')])).toEqual({ run: 'a', generation: 1 });
    expect(currentMaster([ship('a', 1, 'pin'), ship('b', 2, 'accept'), ship('c', 3, 'reject')])).toEqual({ run: 'b', generation: 2 });
  });
});

describe('the ship matches a run owes [T12-34]', () => {
  const file: AnchorsFile = {
    simulations: 200, gamesPerMember: 800, pin: { run: 'x', generation: 1, rating: 856 },
    members: [{ run: 'x', generation: 1, checkpoint: '', rating: 856, se: 0, added: 'init' }], pairings: [], date: 'd', seconds: 0,
  };
  const at = (generation: number, rating: number): LogEntry =>
    ({ kind: 'milestone', run: 'r', date: 'd', generation, anchored: { rating } }) as unknown as LogEntry;

  /**
   * Mutations, seen red ([Z11-48]): a milestone with a ship entry still owed
   * one; one below today's master owed one; a master with no rating skipped
   * in silence; a pin not settling the candidate it names, which the case
   * with a later lower rating proves (without the pin, today's bar is that
   * lower rating, and the candidate would be owed a match against itself). A milestone logged
   * before the first ship entry has no master of its time, so it is owed
   * nothing by construction, which the first two cases hold.
   */
  it('are the milestones above master with no match of their own, since the first ship entry', () => {
    expect(pendingShips([at(10, 900)], 'r', file)).toEqual([]);
    const pin = ship('x', 1, 'pin');
    expect(pendingShips([at(10, 900), pin, at(20, 850), at(30, 860)], 'r', file)).toEqual([{ run: 'r', generation: 30 }]);
    const played = { ...(ship('r', 30, 'reject') as ShipEntry), master: { run: 'x', generation: 1 } };
    expect(pendingShips([pin, at(30, 860), played], 'r', file)).toEqual([]);
    // A pin of the candidate settles it: it is master, and owes nothing.
    expect(pendingShips([pin, at(30, 860), ship('r', 30, 'pin')], 'r', file)).toEqual([]);
    // Even when a later `rating` puts master's latest rating below the milestone's own.
    const rerated = { kind: 'rating', run: 'r', date: 'd', generation: 30, anchored: { rating: 850 } } as unknown as LogEntry;
    expect(pendingShips([pin, at(30, 860), rerated, ship('r', 30, 'pin')], 'r', file)).toEqual([]);
    // Owed against the master of its time, but today's master rates higher.
    const later = { ...(ship('r', 40, 'pin') as ShipEntry) };
    expect(pendingShips([pin, at(30, 860), at(40, 870), later], 'r', file)).toEqual([]);
    // Another run's milestones are its own business.
    expect(pendingShips([pin, at(30, 860)], 'other', file)).toEqual([]);
    // A master pinned with no rating on the anchors cannot be compared with.
    const unrated = { ...(ship('y', 9, 'pin') as ShipEntry) };
    expect(() => pendingShips([unrated, at(30, 860)], 'r', file)).toThrow(/no rating on the anchors/);
  });
});
