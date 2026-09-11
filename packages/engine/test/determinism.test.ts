/**
 * Determinism, the shuffle seam, cloning, and the canonical snapshot.
 *
 * These are the requirements the conformance replay depends on rather than
 * tests: if the seam is not indexed, or `clone` does not carry the stream, a
 * vector cannot be replayed at all.
 */

import { describe, expect, it } from 'vitest';
import {
  FLOOR,
  NUM_COLORS,
  Rng,
  TILES_PER_COLOR,
  apply,
  clone,
  fromCanonical,
  legalActions,
  newGame,
  toCanonical,
  type AzulState,
  type CanonicalState,
  type Color,
} from '../src/index.js';
import { deepDiff } from './support/diff.js';
import { gameVectors, loadVectors } from './support/vectors.js';

/** Plays `n` plies of floor-only moves, which never ends the game. */
function playFloor(s: AzulState, n: number): void {
  for (let i = 0; i < n && !s.isTerminal; i++) {
    apply(s, legalActions(s).find((a) => a % 6 === FLOOR)!);
  }
}

describe('the engine PRNG [E1-46]', () => {
  it('replays a seed identically and separates two seeds', () => {
    const a = newGame(7);
    const b = newGame(7);
    expect(toCanonical(a)).toEqual(toCanonical(b));
    playFloor(a, 40);
    playFloor(b, 40);
    expect(toCanonical(a)).toEqual(toCanonical(b));
    expect(toCanonical(newGame(8)).bag).not.toEqual(toCanonical(newGame(7)).bag);
  });

  it('is xoshiro128** over splitmix32, and the shuffle runs descending', () => {
    // The algorithm, the seeding and the shuffle direction are contractual:
    // change any of them and every recorded game changes. These goldens are
    // what "change" would look like.
    const r = new Rng(12345);
    expect([r.next(), r.next(), r.next(), r.next()]).toEqual([
      1093274547, 203003357, 3741353573, 3803725158,
    ]);
    const bounded = new Rng(12345);
    expect([bounded.below(5), bounded.below(100), bounded.below(1), bounded.below(37)]).toEqual([
      2, 57, 0, 24,
    ]);
    const opening = toCanonical(newGame(20260903));
    expect(opening.factories).toEqual([
      [1, 0, 1, 1, 1],
      [0, 1, 2, 1, 0],
      [0, 1, 2, 1, 0],
      [1, 1, 1, 0, 1],
      [0, 4, 0, 0, 0],
    ]);
    expect(opening.bag.slice(0, 12)).toEqual([4, 3, 4, 3, 4, 1, 4, 3, 2, 1, 1, 3]);
  });

  it('never consults Math.random', () => {
    const real = Math.random;
    Math.random = (): number => {
      throw new Error('the engine must use its own generator [E1-46]');
    };
    try {
      const s = newGame(3);
      playFloor(s, 120); // long enough to force a lid recycle
      expect(s.shufflesUsed).toBeGreaterThan(1);
    } finally {
      Math.random = real;
    }
  });

  it('draws from the generator only for shuffles [E1-47]', () => {
    // Inspection must not consume the stream. Two states from the same seed
    // diverge only if something outside a shuffle drew from it.
    const quiet = newGame(11);
    const busy = newGame(11);
    for (let i = 0; i < 30; i++) {
      legalActions(busy);
      toCanonical(busy);
      clone(busy);
    }
    playFloor(quiet, 120);
    playFloor(busy, 120);
    expect(toCanonical(busy)).toEqual(toCanonical(quiet));
    expect(busy.shufflesUsed).toBeGreaterThan(1);
  });
});

describe('the shuffle seam [E1-61]', () => {
  it('is indexed, not stateful, and increments shufflesUsed straight after', () => {
    const seen: number[] = [];
    const s = newGame(5, (bag, index) => {
      // The index is the state's `shufflesUsed` at the moment of the call...
      seen.push(index);
      bag.sort((a, b) => a - b);
    });
    // ...and the counter has moved on by the time the call returns.
    expect(seen).toEqual([0]);
    expect(s.shufflesUsed).toBe(1);
    playFloor(s, 200);
    for (let i = 0; i < seen.length; i++) expect(seen[i]).toBe(i);
    expect(s.shufflesUsed).toBe(seen.length);
  });

  it('is called once at newGame and once per lid recycle, and nowhere else', () => {
    let calls = 0;
    const s = newGame(5, (bag) => {
      calls++;
      bag.reverse();
    });
    expect(calls).toBe(1); // the opening shuffle [E1-65]
    let previous = calls;
    let plies = 0;
    while (plies < 200 && !s.isTerminal) {
      const round = s.roundIndex;
      apply(s, legalActions(s).find((a) => a % 6 === FLOOR)!);
      plies++;
      if (calls !== previous) {
        // A shuffle only ever happens inside a refill, which only ever happens
        // at a round transition.
        expect(s.roundIndex, 'shuffled outside a refill').not.toBe(round);
        expect(calls).toBe(previous + 1);
        previous = calls;
      }
    }
    expect(calls).toBeGreaterThan(1);
  });

  it('makes the seed irrelevant while it is supplied', () => {
    const order = (bag: Color[]): void => {
      bag.sort((a, b) => a - b);
    };
    const a = newGame(1, order);
    const b = newGame(999_999, order);
    expect(toCanonical(a)).toEqual(toCanonical(b));
    playFloor(a, 130);
    playFloor(b, 130);
    expect(toCanonical(a)).toEqual(toCanonical(b));
  });

  it('[E1-72] reaches a clone, which recycles once with its own index and spares its source', () => {
    // The configuration [0008 A8-22] drives on every simulation: a state built
    // with an injected shuffle, cloned, and the clone applied across a lid
    // recycle. The seam's other cases all drive states nobody cloned.
    const calls: { bag: Color[]; index: number }[] = [];
    const source = newGame(3, (bag, index) => {
      calls.push({ bag: bag.slice(), index });
      bag.sort((a, b) => a - b);
    });
    // Four refills after the opening deal empty the 80 tiles left in the bag,
    // so the next refill recycles.
    while (source.roundIndex < 4) playFloor(source, 1);
    expect(source.bag.length).toBe(0);
    calls.length = 0;
    const before = toCanonical(source);

    const child = clone(source);
    while (child.roundIndex < 5) playFloor(child, 1);

    expect(calls).toHaveLength(1);
    expect(calls[0].index).toBe(before.shufflesUsed);
    expect(child.shufflesUsed).toBe(before.shufflesUsed + 1);
    // The bag handed over is the recycled lid: everything the refill then
    // dealt, plus whatever it left in the bag.
    const recycled = [0, 0, 0, 0, 0];
    for (const c of calls[0].bag) recycled[c]++;
    const afterDeal = [0, 0, 0, 0, 0];
    for (const c of child.bag) afterDeal[c]++;
    for (const f of child.factories) for (let c = 0; c < NUM_COLORS; c++) afterDeal[c] += f[c];
    expect(recycled).toEqual(afterDeal);
    expect(toCanonical(source)).toEqual(before);
  });

  it('is accepted by fromCanonical too, which does not shuffle on load', () => {
    const v = gameVectors()[0];
    let calls = 0;
    const s = fromCanonical(v.plies[3].state, 0, (bag) => {
      calls++;
      bag.reverse();
    });
    expect(calls).toBe(0);
    expect(s.shufflesUsed).toBe(v.plies[3].state.shufflesUsed);
  });
});

describe('clone [E1-48]', () => {
  it('duplicates the generator state and shufflesUsed', () => {
    const parent = newGame(21);
    playFloor(parent, 25);
    const child = clone(parent);
    expect(toCanonical(child)).toEqual(toCanonical(parent));
    // Both must reach a lid recycle and deal the same bag from it, which is
    // only possible if the clone carries the parent's stream position.
    playFloor(parent, 110);
    playFloor(child, 110);
    expect(toCanonical(child)).toEqual(toCanonical(parent));
    expect(child.shufflesUsed).toBe(parent.shufflesUsed);
    expect(parent.shufflesUsed).toBeGreaterThan(1);
  });

  it('shares no mutable container with its parent', () => {
    const parent = newGame(21);
    playFloor(parent, 9);
    const child = clone(parent);
    const before = toCanonical(parent);
    playFloor(child, 30);
    expect(toCanonical(parent)).toEqual(before);
    expect(deepDiff(toCanonical(child), before)).not.toBeNull();
  });
});

describe('the canonical snapshot [E1-62]', () => {
  const DATA_MODEL_KEYS = [
    'factories',
    'center',
    'markerInCenter',
    'bag',
    'lid',
    'walls',
    'plColor',
    'plCount',
    'floor',
    'floorMarker',
    'scores',
    'currentPlayer',
    'firstPlayer',
    'roundIndex',
    'tilesLeft',
    'shufflesUsed',
    'isTerminal',
    'exhausted',
  ];

  it('emits every data-model field, in order, and nothing else', () => {
    const s = newGame(2);
    const c = toCanonical(s) as unknown as Record<string, unknown>;
    expect(Object.keys(c)).toEqual(DATA_MODEL_KEYS);
    // Not `toJSON`: the bag is an ordered colour array, because two positions
    // that will deal differently must not compare equal [E1-52].
    expect(Array.isArray(c['bag'])).toBe(true);
    expect((c['bag'] as number[]).length).toBe(80);
    // The two bookkeeping counters are included even though one is implied by
    // the board and the other is implied by nothing.
    expect(c['tilesLeft']).toBe(20);
    expect(c['shufflesUsed']).toBe(1);
    // Structurally cloneable: no class instances, no functions, no PRNG.
    expect(structuredClone(c)).toEqual(c);
  });

  it('is a one-sided inverse over every recorded state', () => {
    for (const v of loadVectors()) {
      for (const snapshot of [v.initial, v.plies[v.plies.length - 1].state]) {
        const round = toCanonical(fromCanonical(snapshot, 0));
        const d = deepDiff(round, snapshot);
        expect(d, `${v.name}: ${d ?? ''}`).toBeNull();
      }
    }
  });

  it('shares nothing with the snapshot it loaded, in either direction', () => {
    const v = gameVectors()[0];
    const snapshot = structuredClone(v.plies[4].state);
    const s = fromCanonical(snapshot, 0);
    playFloor(s, 4);
    expect(snapshot).toEqual(v.plies[4].state);
    const emitted = toCanonical(s);
    emitted.factories[0][0] += 99;
    expect(s.factories[0][0]).not.toBe(emitted.factories[0][0]);
  });

  it('refuses a snapshot whose tilesLeft disagrees with its board [E1-41]', () => {
    const v = gameVectors()[0];
    const snapshot: CanonicalState = {
      ...structuredClone(v.plies[4].state),
      tilesLeft: 99,
    };
    expect(() => fromCanonical(snapshot, 0)).toThrow();
  });
});

describe('the opening position [E1-65]', () => {
  it('is exactly what the spec spells out', () => {
    const s = newGame(4);
    expect(s.bag.length + 20).toBe(NUM_COLORS * TILES_PER_COLOR);
    const bagCounts = [0, 0, 0, 0, 0];
    for (const c of s.bag) bagCounts[c]++;
    for (const f of s.factories) for (let c = 0; c < NUM_COLORS; c++) bagCounts[c] += f[c];
    expect(bagCounts).toEqual([20, 20, 20, 20, 20]);
    expect(s.lid).toEqual([0, 0, 0, 0, 0]);
    expect(s.walls).toEqual([new Array<number>(25).fill(0), new Array<number>(25).fill(0)]);
    expect(s.plCount).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(s.plColor).toEqual([
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
    ]);
    expect(s.floor).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(s.floorMarker).toEqual([false, false]);
    expect(s.markerInCenter).toBe(true);
    expect(s.center).toEqual([0, 0, 0, 0, 0]);
    expect(s.scores).toEqual([0, 0]);
    // Spelled out because none of it is implied: a port opening with
    // `currentPlayer` 1 satisfies every other requirement and diverges on ply
    // 0 of every conformance vector.
    expect(s.currentPlayer).toBe(0);
    expect(s.firstPlayer).toBe(0);
    expect(s.roundIndex).toBe(0);
    expect(s.isTerminal).toBe(false);
    expect(s.exhausted).toBe(false);
    expect(s.tilesLeft).toBe(20);
    expect(s.shufflesUsed).toBe(1);
  });
});
