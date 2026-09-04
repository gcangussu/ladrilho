/**
 * The package-level promises: no runtime dependencies, no ambient anything,
 * and a UI view that can cross a worker boundary.
 *
 * [E1-50] is deliberately not exempt from traceability despite looking like a
 * build concern — a test can read the manifest and can run a full game with
 * the host's globals replaced by throwing stubs [0002 V2-31].
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FLOOR,
  NUM_COLORS,
  TILES_PER_COLOR,
  apply,
  clone,
  completedColors,
  completedCols,
  completedRows,
  encode,
  encodeFor,
  floorOccupied,
  floorPenalty,
  fromCanonical,
  isLegal,
  legalActions,
  newGame,
  outcome,
  renderText,
  tileCensus,
  toCanonical,
  toJSON,
} from '../src/index.js';
import { gameVectors } from './support/vectors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');

describe('the package is self-contained [E1-50]', () => {
  it('declares no runtime dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest['dependencies']).toBeUndefined();
    expect(manifest['peerDependencies']).toBeUndefined();
    expect(manifest['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside itself — no node builtins, no packages', () => {
    // It has to run unchanged in a browser, in a worker, and under Vitest in
    // Node, so every import in `src` must be a relative one.
    const files = readdirSync(join(PACKAGE_ROOT, 'src')).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(join(PACKAGE_ROOT, 'src', file), 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        expect(match[1], `${file} imports ${match[1]}`).toMatch(/^\.\.?\//);
      }
      expect(source, `${file} uses require()`).not.toMatch(/\brequire\s*\(/);
    }
  });

  it('plays a whole game with the DOM, fetch, timers and the clock removed', () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    const boom = (name: string) => (): never => {
      throw new Error(`the engine touched ${name} [E1-50]`);
    };
    const names = ['document', 'window', 'fetch', 'XMLHttpRequest', 'setTimeout', 'setInterval'];
    const realNow = Date.now;
    const realRandom = Math.random;
    for (const name of names) {
      saved[name] = globals[name];
      globals[name] = boom(name);
    }
    Date.now = boom('Date.now');
    Math.random = boom('Math.random');
    try {
      const s = newGame(99);
      let plies = 0;
      while (!s.isTerminal && plies < 400) {
        const legal = legalActions(s);
        apply(s, legal[plies % legal.length]);
        plies++;
      }
      expect(s.isTerminal).toBe(true);
      expect(toJSON(s)).toBeTruthy();
      expect(encode(s).length).toBe(182);
      expect(renderText(s).length).toBeGreaterThan(0);
    } finally {
      for (const name of names) globals[name] = saved[name];
      Date.now = realNow;
      Math.random = realRandom;
    }
  });
});

describe('everything but apply and recount leaves its arguments alone [E1-51]', () => {
  it('mutates nothing and reads nothing outside its arguments', () => {
    const v = gameVectors()[0];
    const s = fromCanonical(v.plies[30].state, 0);
    const before = toCanonical(s);
    const results = [
      legalActions(s),
      isLegal(s, 0),
      outcome(s),
      floorPenalty(s, 0),
      floorOccupied(s, 1),
      completedRows(s, 0),
      completedCols(s, 1),
      completedColors(s, 0),
      tileCensus(s),
      toJSON(s),
      toCanonical(s),
      renderText(s),
      encode(s),
      encodeFor(s, 1),
      clone(s),
    ];
    expect(results.length).toBe(15);
    expect(toCanonical(s)).toEqual(before);
  });

  it('keeps no module-level state that two games could share', () => {
    // Interleaving two games must give the same result as playing each alone.
    const solo = [newGame(31), newGame(32)];
    for (const s of solo) {
      for (let i = 0; i < 40; i++) apply(s, legalActions(s).find((a) => a % 6 === FLOOR)!);
    }
    const together = [newGame(31), newGame(32)];
    for (let i = 0; i < 40; i++) {
      for (const s of together) apply(s, legalActions(s).find((a) => a % 6 === FLOOR)!);
    }
    expect(toCanonical(together[0])).toEqual(toCanonical(solo[0]));
    expect(toCanonical(together[1])).toEqual(toCanonical(solo[1]));
  });
});

describe('toJSON is a lossy view for the UI [E1-52]', () => {
  it('is structurally cloneable and reports the bag as counts, never its order', () => {
    const v = gameVectors()[0];
    const s = fromCanonical(v.plies[20].state, 0);
    const json = toJSON(s);
    expect(structuredClone(json)).toEqual(json);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);

    // Counts, not an order: five numbers summing to the bag's size.
    expect(json.bag.length).toBe(NUM_COLORS);
    expect(json.bag.reduce((a, b) => a + b, 0)).toBe(s.bag.length);
    for (const n of json.bag) expect(Number.isInteger(n)).toBe(true);

    // And therefore it cannot tell two positions apart that will deal
    // differently — which is why state comparison is defined against
    // `toCanonical` instead.
    const reversed = { ...structuredClone(toCanonical(s)) };
    reversed.bag = reversed.bag.slice().reverse();
    const other = fromCanonical(reversed, 0);
    expect(toJSON(other)).toEqual(json);
    expect(toCanonical(other)).not.toEqual(toCanonical(s));
  });

  it('holds no class instances and no functions anywhere', () => {
    const json = toJSON(newGame(1)) as unknown;
    const walk = (value: unknown, path: string): void => {
      if (value === null) return;
      if (typeof value === 'function') throw new Error(`${path} is a function`);
      if (typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      expect(Object.getPrototypeOf(value), path).toBe(Object.prototype);
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    };
    walk(json, 'toJSON');
    expect(TILES_PER_COLOR).toBe(20);
  });
});
