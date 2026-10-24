/**
 * The anchors ([Z11-84], [Z11-85]): fixed ratings, fresh seeds, and the
 * replay that holds every anchored record to its own series.
 */

import { describe, expect, it } from 'vitest';
import {
  BEYOND,
  SEED_STEP,
  allocateBase,
  checkRecord,
  fitAnchors,
  hashBase,
  overlaps,
  rateAgainst,
  seedsFrom,
  type AnchorPairing,
  type AnchorsFile,
} from '../eval/anchors.js';
import { entriesOf, type LogEntry } from '../eval/decision.js';
import { expected } from '../eval/elo.js';
import { milestone, results } from './support/entries.js';

const file: AnchorsFile = {
  simulations: 200,
  gamesPerMember: 800,
  pin: { run: 'c', generation: 1, rating: 856 },
  members: [
    { run: 'a', generation: 1, checkpoint: 'milestones/a/1/checkpoint.bin', rating: 750, se: 5, added: 'init' },
    { run: 'b', generation: 1, checkpoint: 'milestones/b/1/checkpoint.bin', rating: 824, se: 5, added: 'init' },
    { run: 'c', generation: 1, checkpoint: 'milestones/c/1/checkpoint.bin', rating: 856, se: 0, added: 'init' },
  ],
  pairings: [],
  date: '',
  seconds: 0,
};

/** 800 games against each anchor, scoring `score` against each. */
function series(scores: [number, number, number]): Record<string, { games: number; wins: number; draws: number }> {
  return { 'a/1': { games: 800, wins: scores[0], draws: 0 }, 'b/1': { games: 800, wins: scores[1], draws: 0 }, 'c/1': { games: 800, wins: scores[2], draws: 0 } };
}

describe('fresh seeds [Z11-85]', () => {
  it('says when two seed runs share a seed', () => {
    expect(overlaps({ base: 1000, n: 10 }, { base: 1000 + 9 * SEED_STEP, n: 5 })).toBe(true);
    expect(overlaps({ base: 1000, n: 10 }, { base: 1000 + 10 * SEED_STEP, n: 5 })).toBe(false);
    expect(overlaps({ base: 1000 + 4 * SEED_STEP, n: 3 }, { base: 1000, n: 5 })).toBe(true);
    expect(overlaps({ base: 1000 + 5 * SEED_STEP, n: 3 }, { base: 1000, n: 5 })).toBe(false);
    expect(overlaps({ base: 1001, n: 10 }, { base: 1000, n: 10 })).toBe(false);
    for (const base of [hashBase('x/1'), hashBase('y/2')]) {
      expect(seedsFrom(base, 800).every((s) => s < 2 ** 31 && s >= 3e8)).toBe(true);
    }
  });

  // Mutation, seen red ([Z11-48]), in a copy with its anchor confirmed:
  // `allocateBase` returning the hash's base without checking it fails this case.
  it('allocates a base past any run already spoken for, even the hash\'s own', () => {
    const first = hashBase('run/10');
    const used = [{ base: first - 3 * SEED_STEP, n: 800 }, { base: first + 1, n: 800 }];
    const base = allocateBase('run/10', 800, used);
    expect(used.some((u) => overlaps({ base, n: 800 }, u))).toBe(false);
    expect(base).toBe(first + 2);
    expect(allocateBase('run/10', 800, [])).toBe(first);
  });
});

describe('a record against the anchors [Z11-85]', () => {
  const record = rateAgainst(file, series([520, 420, 380]), 400_000_000);

  it('is rated against the file\'s ratings, and replays', () => {
    expect(record.anchors.map((a) => a.rating)).toEqual([750, 824, 856]);
    expect(record.rating).toBeGreaterThan(750);
    expect(record.rating).toBeLessThan(856);
    expect(() => checkRecord(file, record, series([520, 420, 380]), [])).not.toThrow();
  });

  // Mutation, seen red ([Z11-48]), in a copy with its anchor confirmed:
  // `checkRecord` without its comparison of each anchor's rating with the file's fails this case.
  it('refuses a record whose anchors\' ratings are not the file\'s', () => {
    const moved = { ...record, anchors: record.anchors.map((a, i) => (i === 0 ? { ...a, rating: 760 } : a)) };
    expect(() => checkRecord(file, moved, series([520, 420, 380]), [])).toThrow(/not the file's/);
  });

  it('refuses a rating that does not follow from its series', () => {
    expect(() => checkRecord(file, { ...record, rating: record.rating + 1 }, series([520, 420, 380]), [])).toThrow(/does not follow/);
    expect(() => checkRecord(file, record, series([521, 420, 380]), [])).toThrow(/does not follow/);
  });

  // Mutation, seen red ([Z11-48]), in a copy with its anchor confirmed:
  // `checkRecord` without its seed check fails this case.
  it('refuses seeds used before', () => {
    const earlier = [{ base: 400_000_000 + 799 * SEED_STEP, n: 1 }];
    expect(() => checkRecord(file, record, series([520, 420, 380]), earlier)).toThrow(/used before/);
    const later = [{ base: 400_000_000 + 800 * SEED_STEP, n: 800 }];
    expect(() => checkRecord(file, record, series([520, 420, 380]), later)).not.toThrow();
  });

  // Mutation, seen red ([Z11-48]), in a copy with its anchor confirmed:
  // `rateAgainst` measuring `beyond` from the weakest anchor fails this case.
  it('flags a rating more than 150 above the strongest anchor', () => {
    expect(rateAgainst(file, series([520, 420, 380]), 1).beyond).toBe(false);
    const strong = rateAgainst(file, series([790, 780, 770]), 1);
    expect(strong.rating).toBeGreaterThan(856 + BEYOND);
    expect(strong.beyond).toBe(true);
    const between = rateAgainst(file, series([600, 560, 520]), 1);
    expect(between.rating).toBeGreaterThan(750 + BEYOND);
    expect(between.rating).toBeLessThan(856 + BEYOND);
    expect(between.beyond).toBe(false);
  });
});

describe('the anchors\' own fit [Z11-84]', () => {
  it('holds the pin at its rating and recovers the others from their games', () => {
    const truth = [740, 812, 856];
    const members = [{ run: 'a', generation: 1 }, { run: 'b', generation: 1 }, { run: 'c', generation: 1 }];
    const pairings: AnchorPairing[] = [];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        pairings.push({ a: `${members[i].run}/1`, b: `${members[j].run}/1`, games: 4000, score: 4000 * expected(truth[i], truth[j]), seedBase: 0 });
      }
    }
    const fit = fitAnchors(members, pairings, { run: 'c', generation: 1, rating: 856 });
    expect(fit[2]).toEqual({ rating: 856, se: 0 });
    expect(fit[0].rating).toBeCloseTo(740, 1);
    expect(fit[1].rating).toBeCloseTo(812, 1);
    expect(() => fitAnchors(members, pairings, { run: 'z', generation: 1, rating: 0 })).toThrow(/not a member/);
  });

  // Mutation, seen red ([Z11-48]), in a copy with its anchor confirmed:
  // `entriesOf` keeping `rating` entries fails this case.
  it('rates a checkpoint without touching its run\'s course', () => {
    const r = results(0.55);
    const rating = { kind: 'rating', run: 'a', date: '', generation: 30, anchored: {}, results: {}, seconds: 0, reason: '' } as LogEntry;
    const log: LogEntry[] = [milestone('a', r, 'stop'), rating];
    expect(entriesOf(log, 'a').map((e) => e.kind)).toEqual(['milestone']);
  });
});
