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
import { parseFrom } from '../eval/loop.js';

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
});
