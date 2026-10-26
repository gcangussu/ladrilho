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
import { STOP_PATIENCE, childConfig, parseFrom, parseSet } from '../eval/loop.js';

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
    // [Z11-75]: and so are the playout cap's two settings.
    expect(parseSet('fullSearchFraction=0.25')).toEqual(['fullSearchFraction', 0.25]);
    const cap = childConfig(parent, origin, 42, undefined, { cheapSimulations: 200, fullSearchFraction: 0.25 });
    expect([cap.cheapSimulations, cap.fullSearchFraction]).toEqual([200, 0.25]);
    expect(cap.from?.changes).toEqual({
      cheapSimulations: { parent: 0, run: 200 },
      fullSearchFraction: { parent: 0, run: 0.25 },
    });
  });

  /**
   * [Z11-81]: `thirteenth` is `--set lookaheadDeals=8 --set lookaheadAlpha=0.9`,
   * recorded as changes from an absent 0; one without the other, or either
   * out of range, is refused before a run exists. Mutation, seen red: the
   * check that the two go together dropped from `childConfig`.
   */
  it('takes the lookahead keys together, or not at all', () => {
    expect(parseSet('lookaheadDeals=8')).toEqual(['lookaheadDeals', 8]);
    expect(parseSet('lookaheadAlpha=0.9')).toEqual(['lookaheadAlpha', 0.9]);
    const c = childConfig(parent, origin, 42, undefined, { lookaheadDeals: 8, lookaheadAlpha: 0.9 });
    expect([c.lookaheadDeals, c.lookaheadAlpha]).toEqual([8, 0.9]);
    expect(c.from?.changes).toEqual({
      lookaheadDeals: { parent: 0, run: 8 },
      lookaheadAlpha: { parent: 0, run: 0.9 },
    });
    expect('lookaheadDeals' in childConfig(parent, origin, 42, undefined, {})).toBe(false);
    // A child of a run with the lookahead keeps it, and may change one key.
    const child = childConfig(c, origin, 43, undefined, { lookaheadAlpha: 0.5 });
    expect([child.lookaheadDeals, child.lookaheadAlpha]).toEqual([8, 0.5]);
    for (const bad of [{ lookaheadDeals: 8 }, { lookaheadAlpha: 0.9 }, { lookaheadDeals: 8.5, lookaheadAlpha: 0.9 },
      { lookaheadDeals: 65, lookaheadAlpha: 0.9 }, { lookaheadDeals: 8, lookaheadAlpha: 1.5 }]) {
      expect(() => childConfig(parent, origin, 42, undefined, bad)).toThrow(/lookahead/);
    }
  });

  /**
   * [Z11-87]: run `sixteenth` is `--set improvedCScale=0.1`, recorded as one
   * change from an absent 0; the visit constant alone, or either out of range,
   * is refused before a run exists. Mutation, seen red: the check dropped
   * from `childConfig`.
   */
  it('takes the improved target keys, the scale first', () => {
    expect(parseSet('improvedCScale=0.1')).toEqual(['improvedCScale', 0.1]);
    const c = childConfig(parent, origin, 42, undefined, { improvedCScale: 0.1 });
    expect(c.improvedCScale).toBe(0.1);
    expect('improvedCVisit' in c).toBe(false);
    expect(c.from?.changes).toEqual({ improvedCScale: { parent: 0, run: 0.1 } });
    expect(childConfig(parent, origin, 42, undefined, { improvedCScale: 0.1, improvedCVisit: 20 }).improvedCVisit).toBe(20);
    for (const bad of [{ improvedCVisit: 50 }, { improvedCScale: 11 }, { improvedCScale: 0.1, improvedCVisit: 20000 }]) {
      expect(() => childConfig(parent, origin, 42, undefined, bad)).toThrow(/improved/);
    }
  });

  /**
   * [Z11-90]: a run on the anchors decides by patience, its parent's or
   * [STOP_PATIENCE]; a run on another yardstick by [Z11-33]'s rule. Patience is
   * how a run is measured, not what it trains, so it is no change in
   * `from.changes`. Mutation, seen red: `patienceFor` ignoring the parent's.
   */
  it('writes the patience on the anchors, inherited first', () => {
    const fresh = childConfig(parent, origin, 42, undefined, {}, undefined, 'anchors');
    expect(fresh.stopPatience).toBe(STOP_PATIENCE);
    expect(STOP_PATIENCE).toBe(5);
    expect(fresh.from?.changes).toEqual({});
    expect(childConfig({ ...parent, stopPatience: 3 }, origin, 42, undefined, {}, undefined, 'anchors').stopPatience).toBe(3);
    expect('stopPatience' in childConfig(parent, origin, 42, undefined, {}, undefined, 'pool')).toBe(false);
  });

  /**
   * [Z11-89]: a Gumbel run is `--set gumbelConsidered=16`, one change from an
   * absent 0; the scale alone, a count outside 2..=64, or a Gumbel run with a
   * lookahead is refused before a run exists. Mutation, seen red: the check
   * dropped from `childConfig`.
   */
  it('takes the Gumbel keys, the count first, and no lookahead', () => {
    const c = childConfig(parent, origin, 42, undefined, { gumbelConsidered: 16 });
    expect(c.gumbelConsidered).toBe(16);
    expect(c.from?.changes).toEqual({ gumbelConsidered: { parent: 0, run: 16 } });
    for (const bad of [{ gumbelScale: 1 }, { gumbelConsidered: 1 }, { gumbelConsidered: 8.5 }, { gumbelConsidered: 65 },
      { gumbelConsidered: 16, gumbelScale: 11 }, { gumbelConsidered: 16, lookaheadDeals: 8, lookaheadAlpha: 0.9 }]) {
      expect(() => childConfig(parent, origin, 42, undefined, bad)).toThrow(/umbel/);
    }
  });
});
