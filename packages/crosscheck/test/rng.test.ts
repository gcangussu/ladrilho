/**
 * The tool's randomness: its own generator pinned by known answers [C10-42],
 * games that depend on their seed and index alone [C10-6], and the shuffle
 * seam [C10-7].
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as engine from 'engine';
import type { Color } from 'engine';
import { describe, expect, it } from 'vitest';
import { ToolError, invent, inventingSeam } from '../src/game.js';
import { Stream, splitmix32 } from '../src/rng.js';
import { PACKAGE } from './support/harness.js';

const outputs = (s: Stream, n: number): number[] => Array.from({ length: n }, () => s.next());

describe('the generator is pinned [C10-42]', () => {
  it('is xoshiro128**: the reference sequence from state (1, 2, 3, 4)', () => {
    expect(outputs(Stream.fromState(1, 2, 3, 4), 6)).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492,
    ]);
  });

  it('seeds by splitmix32, as an independent implementation computes it', () => {
    // Computed by a separate Python implementation of both algorithms.
    expect(splitmix32(0)[0]).toBe(1684164658);
    expect(splitmix32(1)[0]).toBe(1580013426);
    expect(outputs(new Stream(1, 0), 6)).toEqual([
      1859756884, 2932928853, 1348689063, 1383533138, 2461559207, 1092278282,
    ]);
    expect(outputs(new Stream(20260926, 7), 6)).toEqual([
      3403101238, 3954858839, 3871243530, 3310925594, 3026071456, 2381106197,
    ]);
  });

  it('shuffles a known bag to a known order, Fisher–Yates descending [C10-7]', () => {
    const bag = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    new Stream(7, 3).shuffle(bag);
    expect(bag).toEqual(KNOWN_SHUFFLE);
  });
});

// Computed by the same separate Python implementation: its `below` and a
// descending Fisher–Yates over it.
const KNOWN_SHUFFLE = [5, 2, 4, 3, 1, 9, 0, 6, 8, 7];

describe('the tool uses neither engine’s randomness [C10-5]', () => {
  it('never imports the engine’s Rng, and never constructs without a shuffle', () => {
    const dir = join(PACKAGE, 'src');
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/import[^;]*\bRng\b[^;]*from 'engine'/);
      expect(text, file).not.toMatch(/\bengine\.Rng\b/);
      // A constructor given no shuffle falls back to the engine's own seed.
      expect(text, file).not.toMatch(/\bnewGame\(\s*[^,()]*\)/);
      expect(text, file).not.toMatch(/\bfromCanonical\(\s*[^,()]*,\s*[^,()]*\)/);
    }
  });
});

describe('a game depends on its seed and index alone [C10-6]', () => {
  const opts = { steer: 'mix', start: { kind: 'new' as const }, cap: 400 };

  it('is the same game however many games ran before it', () => {
    const alone = invent(engine, 11, 7, opts);
    for (let g = 0; g < 7; g++) invent(engine, 11, g, opts);
    const after = invent(engine, 11, 7, opts);
    expect(after.input).toEqual(alone.input);
    expect(after.policy).toBe(alone.policy);
  });

  it('is a different game for a different index or seed', () => {
    const a = invent(engine, 11, 7, opts).input.shuffles[0];
    expect(invent(engine, 11, 8, opts).input.shuffles[0]).not.toEqual(a);
    expect(invent(engine, 12, 7, opts).input.shuffles[0]).not.toEqual(a);
  });
});

describe('the shuffle seam [C10-7]', () => {
  const bag = (): Color[] => [0, 0, 1, 1, 2, 2, 3, 3, 4, 4] as Color[];

  it('shuffles and records at the next index, and writes a recorded one back', () => {
    const shuffles: number[][] = [];
    const seam = inventingSeam(new Stream(1, 1), shuffles);
    const first = bag();
    seam(first, 0);
    expect(shuffles).toEqual([first]);
    const again = bag();
    seam(again, 0);
    expect(again).toEqual(first);
    expect(shuffles).toHaveLength(1);
  });

  it('is a tool error when an index is skipped', () => {
    const seam = inventingSeam(new Stream(1, 1), []);
    expect(() => seam(bag(), 1)).toThrow(ToolError);
  });
});
