/**
 * The tile harness's own logic (tile/README.md): what can be checked without
 * their files. The translation against their engine is `tile verify`, which
 * needs the cache and so is not part of this suite.
 */

import { describe, expect, it } from 'vitest';
import { ACTION_SPACE, apply, clone, legalActions, newGame, outcome, Rng, type AzulState } from 'engine';
import { actionFromTheirs, actionToTheirs } from '../tile/convert.js';
import { jobsFor } from '../tile/match.js';
import { Exact } from '../tile/solvercheck.js';
import { parseTheirSpec } from '../tile/theirs.js';

describe('the action ids', () => {
  it('renumber only the display, and invert each other over the whole space', () => {
    for (let a = 0; a < ACTION_SPACE; a++) {
      expect(actionFromTheirs(actionToTheirs(a))).toBe(a);
      expect(actionToTheirs(a) % 30).toBe(a % 30);
    }
    // Our centre is source 5, theirs display 0; our factory 0 is their display 1.
    expect(actionToTheirs(5 * 30 + 7)).toBe(7);
    expect(actionToTheirs(0 * 30 + 7)).toBe(37);
  });
});

describe('a match', () => {
  it('plays every deal from both seats, and the same deals in every cell', () => {
    const jobs = jobsFor({ games: 6, seed: 40, us: [100, 200], them: [parseTheirSpec('nnue:10'), parseTheirSpec('mcts:5@4')] });
    expect(jobs).toHaveLength(24);
    for (let cell = 0; cell < 4; cell++) {
      const mine = jobs.filter((j) => j.cell === cell);
      expect(mine.map((j) => [j.seed, j.ourSeat])).toEqual([
        [40, 0], [40, 1], [41, 0], [41, 1], [42, 0], [42, 1],
      ]);
    }
  });
});

describe('the exact search of solver-check', () => {
  type Cont = (s: AzulState) => number;
  function brute(s: AzulState, round: number, cont: Cont): number {
    if (s.isTerminal) return outcome(s)! * 1000 + s.scores[0] - s.scores[1];
    if (s.roundIndex !== round) return cont(s);
    const values = legalActions(s).map((m) => {
      const c = clone(s);
      apply(c, m);
      return brute(c, round, cont);
    });
    return s.currentPlayer === 0 ? Math.max(...values) : Math.min(...values);
  }

  // Continuing lines scored by margin, not by a constant: constant leaves make
  // most bounds equal to the true value, and a table that mixes up its bounds
  // then passes. Storing every result as exact, or a fail-low as a lower
  // bound, was seen to fail this.
  const margin: Cont = (s) => s.scores[0] - s.scores[1];

  it('agrees with unpruned minimax on every child, one table across siblings as grading uses it', () => {
    const rng = new Rng(5);
    let positions = 0;
    let checked = 0;
    for (let g = 0; positions < 120; g++) {
      const s = newGame(1000 + g);
      while (!s.isTerminal) {
        const legal = legalActions(s);
        if (s.roundIndex >= 2 && s.tilesLeft <= 8 && s.tilesLeft >= 5) {
          positions++;
          const e = new Exact(margin, 1e9);
          for (const m of legal) {
            const c = clone(s);
            apply(c, m);
            expect(e.value(c, s.roundIndex)).toBe(brute(clone(c), s.roundIndex, margin));
            checked++;
          }
          break;
        }
        const lines = legal.filter((m) => m % 6 !== 5);
        const pool = lines.length > 0 && rng.below(10) < 8 ? lines : legal;
        apply(s, pool[rng.below(pool.length)]);
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});
