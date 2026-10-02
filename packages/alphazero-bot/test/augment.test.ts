/**
 * Display permutation's layout and fixture ([Z11-65]), and a run's parent
 * ([Z11-66]). The trainer's own suite checks the permutation against the
 * fixture; this one checks the fixture, and the layout the trainer reads,
 * against the engine as it is now.
 */

import { readFileSync } from 'node:fs';
import { encode, legalActions, newGame } from 'engine';
import { describe, expect, it } from 'vitest';
import { DISPLAYS_FIXTURE, LAYOUT, displayFixture, displayLayout, permuteDisplays } from '../eval/augment.js';
import { startingConfig } from '../eval/config.js';
import { childConfig, parseFrom, parseSet } from '../eval/loop.js';

describe('display permutation [Z11-65]', () => {
  it("keeps train/layout.json and the trainer's fixture what the engine says", () => {
    expect(JSON.parse(readFileSync(LAYOUT, 'utf8'))).toEqual(displayLayout());
    expect(JSON.parse(readFileSync(DISPLAYS_FIXTURE, 'utf8'))).toEqual(displayFixture());
  });

  it('records cases that move which displays are empty, never the identity', () => {
    for (const c of displayFixture()) {
      const flags = (obs: number[]) => obs.slice(151, 156);
      expect(flags(c.permutedObs)).not.toEqual(flags(c.obs));
      expect(new Set(c.perm).size).toBe(5);
    }
  });

  it('permutes a state and nothing else about it', () => {
    const s = newGame(3);
    const p = permuteDisplays(s, [4, 3, 2, 1, 0]);
    expect(p.factories).toEqual([...s.factories].reverse());
    const a = encode(s);
    const b = encode(p);
    for (let i = 0; i < a.length; i++) if (i < 126 || i >= 156) expect(b[i]).toBe(a[i]);
    expect(legalActions(p).length).toBe(legalActions(s).length);
  });
});

describe('a run started from another [Z11-66]', () => {
  it('names its parent as <run>:<generation>', () => {
    expect(parseFrom('first:200')).toEqual({ run: 'first', generation: 200 });
    expect(() => parseFrom('first')).toThrow(/<run>:<generation>/);
    expect(() => parseFrom('first:x')).toThrow(/<run>:<generation>/);
  });

  const origin = { run: 'second', generation: 70, checkpointSha256: 'abc', windowGenerations: [51, 69], latencyRun: 'first' };
  const parent = { ...startingConfig(), playSimulations: 11300, augment: 'displays' as const };

  /**
   * Mutation, seen red: `width` added to the settings `--set` may change.
   * The network, the searches the ladder measures and the latency record's
   * count stay the parent's.
   */
  it('changes only how a run trains and self-plays', () => {
    expect(parseSet('gamesPerGeneration=3000')).toEqual(['gamesPerGeneration', 3000]);
    for (const bad of ['width=512', 'blocks=8', 'playSimulations=20000', 'milestoneSimulations=400', 'cpuct=2', 'seed=1']) {
      expect(() => parseSet(bad)).toThrow(/cannot change/);
    }
    expect(() => parseSet('gamesPerGeneration=0')).toThrow(/positive/);
    expect(() => parseSet('gamesPerGeneration=many')).toThrow(/positive/);
    expect(() => parseSet('gamesPerGeneration')).toThrow(/<setting>=<number>/);
  });

  /** Mutation, seen red: the changes not recorded in `from`. */
  it("is the parent's config with a fresh seed, the change, and a record of it", () => {
    const c = childConfig(parent, origin, 42, undefined, { gamesPerGeneration: 3000 });
    const { seed: _a, gamesPerGeneration: _b, from: _c, ...rest } = c;
    const { seed: _d, gamesPerGeneration: _e, ...parentRest } = parent;
    expect(rest).toEqual(parentRest);
    expect(c.seed).toBe(42);
    expect(c.gamesPerGeneration).toBe(3000);
    expect(c.augment).toBe('displays');
    expect(c.from).toEqual({ ...origin, changes: { gamesPerGeneration: { parent: 500, run: 3000 } } });
    expect(childConfig(parent, origin, 42, undefined, {}).from?.changes).toEqual({});
    // [Z11-68]: the gate setting is the parent's unless given.
    expect(childConfig({ ...parent, gate: 'off' }, origin, 42, undefined, {}).gate).toBe('off');
    expect(childConfig(parent, origin, 42, undefined, {}, 'off').gate).toBe('off');
    expect('gate' in childConfig(parent, origin, 42, undefined, {})).toBe(false);
    // [Z11-73]: and so is the yardstick.
    expect(childConfig({ ...parent, yardstick: 'pool' }, origin, 42, undefined, {}).yardstick).toBe('pool');
    expect(childConfig(parent, origin, 42, undefined, {}, undefined, 'pool').yardstick).toBe('pool');
    expect('yardstick' in childConfig(parent, origin, 42, undefined, {})).toBe(false);
    // [Z11-67]: the aux weights are changes like any other, from an absent 0.
    const aux = childConfig(parent, origin, 42, undefined, { auxMarginWeight: 0.5, auxWallsWeight: 0.5 });
    expect(aux.auxMarginWeight).toBe(0.5);
    expect(aux.from?.changes).toEqual({
      auxMarginWeight: { parent: 0, run: 0.5 },
      auxWallsWeight: { parent: 0, run: 0.5 },
    });
  });
});
