/**
 * The everyday run [C10-36]: fixed seeds, three steerings, no disagreement —
 * and each steering seen to reach what it steers for, so an option that
 * quietly stopped steering fails rather than passing on uniform play.
 */

import * as engine from 'engine';
import { describe, expect, it } from 'vitest';
import { invent } from '../src/game.js';
import { POLICY_NAMES } from '../src/policies.js';
import { vectorStart } from '../src/run.js';
import { EVERYDAY, runWith } from './support/harness.js';

describe('the everyday run [C10-36]', () => {
  it('agrees over 40 mixed games and reaches a lid recycle [C10-17]', async () => {
    const { report, totals } = await runWith(engine, EVERYDAY.mix);
    expect(report).toBeNull();
    expect(totals.games).toBe(40);
    expect(totals.recycles).toBeGreaterThan(0);
  });

  it('agrees over short-census games and reaches exhaustion and a short deal [C10-16]', async () => {
    const { report, totals } = await runWith(engine, EVERYDAY.short);
    expect(report).toBeNull();
    expect(totals.endedByExhaustion).toBeGreaterThan(0);
    expect(totals.shortDeals).toBeGreaterThan(0);
  });

  it('agrees over floor games, reaches the eighth slot, and caps them [C10-18]', async () => {
    const { report, totals } = await runWith(engine, EVERYDAY.floor);
    expect(report).toBeNull();
    expect(totals.floorsPastSeven).toBeGreaterThan(0);
    // `floor` never completes a line, so every one of these games is capped.
    expect(totals.capped).toBe(20);
    expect(totals.plies).toBe(20 * 400);
  });
});

describe('starts [C10-16]', () => {
  it('loads a committed position vector as the start, unchanged', () => {
    const state = vectorStart('position-05-empty-bag-and-lid');
    const played = invent(engine, 1, 0, {
      steer: 'uniform',
      start: { kind: 'vector', name: 'position-05-empty-bag-and-lid', state },
      cap: 50,
    });
    expect(played.input.start).toEqual(state);
  });

  it('removes between 1 and K tiles from the end of a dealt bag', () => {
    for (let g = 0; g < 20; g++) {
      const played = invent(engine, 5, g, { steer: 'uniform', start: { kind: 'short', max: 10 }, cap: 1 });
      const opening = played.input.shuffles[0];
      const bag = played.input.start!.bag;
      const removed = 80 - bag.length;
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(removed).toBeLessThanOrEqual(10);
      // The dealt bag is what the opening shuffle left after 20 tiles went out.
      expect(bag).toEqual(opening.slice(0, bag.length));
    }
  });

  it('agrees from every committed position vector', async () => {
    for (const name of ['position-01-two-runs', 'position-03-overfull-floor', 'position-05-empty-bag-and-lid']) {
      const { report } = await runWith(engine, {
        games: 3,
        seed: 1,
        steer: 'mix',
        start: { kind: 'vector', name, state: vectorStart(name) },
        startText: `vector:${name}`,
        cap: 200,
      });
      expect(report, name).toBeNull();
    }
  });
});

describe('policies [C10-17]', () => {
  it('offers the seven named policies', () => {
    expect([...POLICY_NAMES].sort()).toEqual(
      ['avoid-marker', 'biggest-pile', 'centre-first', 'floor', 'per-ply', 'prefer-lines', 'uniform'].sort(),
    );
  });

  it('draws every policy under mix', () => {
    const seen = new Set<string>();
    for (let g = 0; g < 100; g++) seen.add(invent(engine, 3, g, { steer: 'mix', start: { kind: 'new' }, cap: 1 }).policy);
    expect([...seen].sort()).toEqual([...POLICY_NAMES].sort());
  });

  it('sends every take to the floor under floor', () => {
    const played = invent(engine, 9, 0, { steer: 'floor', start: { kind: 'new' }, cap: 100 });
    expect(played.input.actions.every((a) => engine.decodeAction(a)[2] === engine.FLOOR)).toBe(true);
  });
});

describe('the counts [C10-19]', () => {
  it('reports every count, from agreeing games only', async () => {
    const { totals, pliesPerSecond } = await runWith(engine, { ...EVERYDAY.mix, games: 5 });
    for (const key of [
      'games', 'plies', 'endedByRow', 'endedByExhaustion', 'capped', 'maxRound',
      'recycles', 'shortDeals', 'floorsSeven', 'floorsPastSeven',
    ]) {
      expect(typeof (totals as unknown as Record<string, number>)[key], key).toBe('number');
    }
    expect(totals.endedByRow + totals.endedByExhaustion + totals.capped).toBe(totals.games);
    expect(pliesPerSecond).toBeGreaterThan(0);
  });
});
