/**
 * The universe draw and the root it deals from [A8-22], [A8-7].
 *
 * The end-to-end check is [A8-36]: every recorded ply, boundaries included,
 * against the original's next board. What this file adds is the plumbing that
 * claim rests on — that an order written down from counts, popped by our
 * engine and topped up through the shuffle seam, deals what the original's
 * `setup_new_round` deals — checked on posed bags that make the recycle happen
 * where it is rare, partway through a display.
 */

import { describe, expect, it } from 'vitest';
import {
  FLOOR,
  apply,
  clone,
  legalActions,
  newGame,
  toCanonical,
  toJSON,
  type AzulJSON,
  type AzulState,
} from 'engine';
import { EXPERT } from '../src/index.js';
import { universeOrder, universeRoot, universeShuffle } from '../src/universe.js';

function counts(tiles: readonly number[]): number[] {
  const out = [0, 0, 0, 0, 0];
  for (const c of tiles) out[c]++;
  return out;
}

/**
 * The original's `select_tiles_from_bag` with a universe seed, transcribed
 * from AzulLogicNumba.py into the obvious loop. A second copy on purpose: it
 * shares the formula with `src/universe.ts` but none of the plumbing — no
 * order, no reversal, no pop — which is the part under test here.
 */
function theirDraw(bag: number[]): number {
  let seed = 0;
  for (let j = 0; j < 5; j++) seed += bag[j] * [1, 2, 4, 8, 16][j];
  const total = bag.reduce((x, y) => x + y);
  const t = (4594591 * (EXPERT.universeSeed + seed)) % total;
  let cumulative = 0;
  for (let c = 0; c < 5; c++) {
    cumulative += bag[c];
    if (cumulative > t) {
      bag[c]--;
      return c;
    }
  }
  throw new Error('unreachable: t < total');
}

/** `setup_new_round`'s five displays, from bag and discard counts. */
function theirDeal(bag: number[], discards: number[]): number[][] {
  const displays: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const display = [0, 0, 0, 0, 0];
    let wanted = 4;
    if (bag.reduce((x, y) => x + y) < 4) {
      wanted = 4 - bag.reduce((x, y) => x + y);
      for (let c = 0; c < 5; c++) {
        display[c] += bag[c];
        bag[c] = discards[c];
        discards[c] = 0;
      }
    }
    for (let k = 0; k < wanted; k++) display[theirDraw(bag)]++;
    displays.push(display);
  }
  return displays;
}

/** Floor moves until the round ends; returns the state after the refill. */
function finishRound(s: AzulState): void {
  const round = s.roundIndex;
  while (!s.isTerminal && s.roundIndex === round) {
    apply(s, legalActions(s).find((a) => a % 6 === FLOOR)!);
  }
}

describe('the universe order [A8-22]', () => {
  it('[A8-22] holds exactly the counts it was given', () => {
    for (const bag of [[20, 20, 20, 20, 20], [0, 3, 0, 1, 0], [0, 0, 0, 0, 0], [7, 0, 2, 9, 1]]) {
      const order = universeOrder(bag);
      expect(order.length).toBe(bag.reduce((x, y) => x + y));
      expect(counts(order)).toEqual(bag);
    }
  });

  it('[A8-22] pops, from the end, the successive draws of the original', () => {
    for (const bag of [[20, 20, 20, 20, 20], [3, 17, 0, 8, 12], [1, 0, 0, 0, 1]]) {
      const order = universeOrder(bag);
      const theirs = bag.slice();
      while (order.length > 0) expect(order.pop()).toBe(theirDraw(theirs));
    }
  });

  it('[A8-22] draws from a full bag what the original draws', () => {
    // Recorded by calling `Board.select_tiles_from_bag(1, 31416)` a hundred
    // times on a bag of 20 of each colour, at the pinned commit. The one check
    // in this file that no line of ours computed.
    const ORIGINAL = [
      3, 2, 1, 0, 0, 2, 0, 3, 0, 3, 2, 2, 0, 2, 3, 1, 0, 4, 4, 3, 2, 1, 1, 3, 3, 2, 4, 1, 4, 0, 1,
      2, 0, 2, 3, 0, 4, 1, 1, 1, 4, 0, 2, 3, 4, 4, 1, 2, 4, 2, 2, 3, 1, 4, 2, 3, 2, 4, 1, 0, 3, 0,
      0, 1, 0, 3, 0, 1, 4, 2, 2, 1, 0, 2, 1, 4, 4, 3, 3, 2, 2, 4, 3, 1, 4, 3, 0, 0, 0, 4, 3, 3, 1,
      4, 3, 4, 4, 1, 1, 0,
    ];
    const order = universeOrder([20, 20, 20, 20, 20]);
    expect(order.reverse()).toEqual(ORIGINAL);
  });

  it('[A8-22] leaves its argument alone', () => {
    const bag = [4, 4, 4, 4, 4];
    universeOrder(bag);
    expect(bag).toEqual([4, 4, 4, 4, 4]);
  });

  it('[A8-22] reorders a recycled bag in place, into the order of its own counts', () => {
    const bag = [4, 4, 3, 1, 0, 0, 2, 2] as Parameters<typeof universeShuffle>[0];
    universeShuffle(bag, 7);
    expect(bag).toEqual(universeOrder([2, 1, 2, 1, 2]));
  });
});

describe('the root [A8-22], [A8-7]', () => {
  it('[A8-22] is the position it was built from, dealing through the universe seam', () => {
    const s = newGame(5);
    for (let i = 0; i < 7; i++) apply(s, legalActions(s)[i % legalActions(s).length]);
    const position = toJSON(s);
    const root = universeRoot(position);
    expect(toJSON(root)).toEqual(position);
    expect(root.shuffle).toBe(universeShuffle);
    expect(root.bag).toEqual(universeOrder(position.bag));
  });

  it('[A8-7] deals what the original deals from bag and lid counts alone, recycle included', () => {
    // Posed bags that leave a display short, so the recycle falls partway
    // through one — the case [A8-51] makes the fixtures include because real
    // games rarely reach it. The engine's lid at the refill is the original's
    // discard pile, floors included.
    const cases: [number[], number[]][] = [
      [[1, 0, 2, 0, 0], [9, 3, 0, 5, 1]], // short at display 0
      [[3, 2, 2, 1, 1], [0, 4, 4, 4, 0]], // short at display 2
      [[0, 0, 0, 0, 0], [6, 6, 6, 6, 6]], // empty: the ordinary recycle
      [[4, 4, 4, 4, 4], [1, 1, 1, 1, 1]], // exactly enough: no recycle
    ];
    for (const [bag, lid] of cases) {
      const base = toJSON(newGame(9));
      const posed: AzulJSON = structuredClone(base);
      posed.bag = bag;
      posed.lid = lid;
      const root = universeRoot(posed);
      // Through a clone, as the search reaches every state [A8-21].
      const s = clone(root);
      finishRound(s);
      const before = toCanonical(root);
      // Floor-only play sends every tile on the table to a floor, and every
      // floor to the lid at the round's end: the original's discard pile at
      // the refill is the posed lid plus the table.
      const discards = lid.slice();
      for (let c = 0; c < 5; c++) {
        discards[c] += before.center[c];
        for (const f of before.factories) discards[c] += f[c];
      }
      const expected = theirDeal(bag.slice(), discards);
      expect(s.factories, `bag ${bag} lid ${lid}`).toEqual(expected);
      expect(toCanonical(root), 'the root was touched').toEqual(before);
    }
  });
});
