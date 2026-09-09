/**
 * The explained path is the same path [0007 S7-28].
 *
 * `applyExplained` adds a caller to round resolution, to `tileWall` and to
 * `finishGame`, and every existing test of those three drives `apply`. That is
 * the configuration CLAUDE.md names — a new caller meeting a requirement whose
 * tests all predate it — so the first thing this file asserts is not what the
 * record says, but that saying it changed nothing.
 *
 * What the record *says* is [0007 S7-30]'s corpus, next door.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTION_SPACE,
  Rng,
  apply,
  applyExplained,
  clone,
  legalActions,
  newGame,
  toCanonical,
  type AzulState,
} from '../src/index.js';
import { deepDiff } from './support/diff.js';

const GAMES = 60;
const PLY_CAP = 400;

/** The action a seeded picker takes in this position. */
function pick(s: AzulState, picker: Rng): number {
  const legal = legalActions(s);
  return legal[picker.below(legal.length)];
}

describe('apply and applyExplained are one transition [S7-28]', () => {
  /**
   * Two states, one game: the same actions in the same order, one played
   * through each entry point, compared under `toCanonical` [0001 E1-62] after
   * every single ply. Not only at the end — two cancelling divergences agree
   * on a final score often enough to matter, and a record is written on the
   * ply that resolves a round, which is exactly the ply a comparison of finals
   * would let slip past.
   *
   * The seed is in every failure message and reproduces the game exactly: the
   * deal comes from it and so does the move picker.
   */
  it('leaves canonically equal states over seeded random play', () => {
    const faults: string[] = [];
    let records = 0;
    let plies = 0;

    for (let seed = 0; seed < GAMES && faults.length === 0; seed++) {
      const plain = newGame(seed);
      const explained = newGame(seed);
      const picker = new Rng(seed ^ 0x5eed);

      let ply = 0;
      while (!plain.isTerminal && ply < PLY_CAP) {
        const action = pick(plain, picker);
        const round = plain.roundIndex;
        // Both states are equal going in, so `legalActions` agrees and the one
        // action is legal in both.
        apply(plain, action);
        const record = applyExplained(explained, action);
        ply++;
        plies++;
        if (record !== null) records++;

        const d = deepDiff(toCanonical(explained), toCanonical(plain));
        if (d !== null) {
          faults.push(`seed ${seed} ply ${ply} (action ${action}): ${d}`);
          break;
        }
        // [S7-1] a record exactly on the plies that resolved a round. A
        // resolution is the only thing that moves `roundIndex` [0001 E1-35] or
        // raises `isTerminal` [0001 E1-36], and the disjunction of the two is
        // what [0003 U3-39] detects a transition by.
        const resolved = plain.roundIndex !== round || plain.isTerminal;
        if ((record !== null) !== resolved) {
          faults.push(`seed ${seed} ply ${ply}: record ${String(record !== null)}, resolution ${String(resolved)}`);
          break;
        }
      }
      if (!plain.isTerminal) faults.push(`seed ${seed}: still running after ${PLY_CAP} plies`);
    }

    expect(faults.slice(0, 5)).toEqual([]);
    // The property is worthless if the games never reached a resolution: five
    // rounds a game is the low end of a real game, sixty games is 300.
    expect(records).toBeGreaterThan(GAMES * 4);
    expect(plies).toBeGreaterThan(GAMES * 40);
  });

  /**
   * The same claim from the other side: a position played by one entry point
   * continues identically under the other. A clone splits the game in two at
   * every ply of a real game and plays the *next* ply both ways.
   */
  it('is interchangeable ply by ply, in either direction', () => {
    const s = newGame(7);
    const picker = new Rng(0xa11ce);
    let swaps = 0;
    while (!s.isTerminal && swaps < PLY_CAP) {
      const action = pick(s, picker);
      const other = clone(s);
      apply(s, action);
      applyExplained(other, action);
      expect(toCanonical(other), `ply ${swaps} diverged`).toEqual(toCanonical(s));
      swaps++;
    }
    expect(s.isTerminal).toBe(true);
    expect(swaps).toBeGreaterThan(40);
  });
});

describe('the seam [S7-1], [S7-2], [S7-5]', () => {
  /**
   * [S7-2], first clause. The whole no-cost argument rests on `apply` being
   * untouched, and the one observable half of that is what it returns —
   * including on the ply that now builds a record for the other entry point.
   */
  it('[S7-37] apply returns undefined, on a round-ending ply too', () => {
    const s = newGame(11);
    const picker = new Rng(3);
    let resolutions = 0;
    while (!s.isTerminal) {
      const round = s.roundIndex;
      const returned = apply(s, pick(s, picker)) as unknown;
      expect(returned).toBeUndefined();
      if (s.roundIndex !== round || s.isTerminal) resolutions++;
    }
    // Not vacuous: the loop above really did drive resolutions through `apply`.
    expect(resolutions).toBeGreaterThan(3);
  });

  it('[S7-1] returns null on every ply that ends no round', () => {
    const s = newGame(23);
    const picker = new Rng(5);
    let nulls = 0;
    while (!s.isTerminal) {
      const round = s.roundIndex;
      const record = applyExplained(s, pick(s, picker));
      const resolved = s.roundIndex !== round || s.isTerminal;
      expect(record === null, `round ${round}: record without a resolution`).toBe(!resolved);
      if (record === null) nulls++;
    }
    expect(nulls).toBeGreaterThan(40);
  });

  /**
   * [S7-5], which is [0001 E1-14] one entry point along: the same inputs
   * throw, the state is untouched, and nothing partial comes back. The record
   * is the return value, so "no partial record" is the same statement as "it
   * threw instead of returning" — and the state comparison is what says the
   * throw happened before anything moved.
   */
  it('[S7-5] throws on an illegal or out-of-range action and moves nothing', () => {
    const s = newGame(4);
    const before = toCanonical(s);
    const legal = new Set(legalActions(s));
    const illegal = [...Array(ACTION_SPACE).keys()].find((a) => !legal.has(a));
    for (const action of [-1, ACTION_SPACE, 1.5, Number.NaN, illegal]) {
      expect(() => applyExplained(s, action as number), `action ${String(action)}`).toThrow();
      expect(toCanonical(s), `action ${String(action)} mutated the state`).toEqual(before);
    }
    // And on a finished game, which is the other throw [0001 E1-14].
    const done = newGame(4);
    const picker = new Rng(9);
    while (!done.isTerminal) applyExplained(done, pick(done, picker));
    expect(() => applyExplained(done, legalActions(done)[0] ?? 0)).toThrow();
  });
});
