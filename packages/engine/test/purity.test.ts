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
  fromJSON,
  isLegal,
  legalActions,
  newGame,
  outcome,
  placementValue,
  renderText,
  tileCensus,
  toCanonical,
  toJSON,
  wallCompletedColors,
  wallCompletedCols,
  wallCompletedRows,
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

  /**
   * [E1-68] and [E1-70] are not only "these functions exist" — each says the
   * state-shaped caller **computes its answer by calling** the wall-shaped one,
   * so the rule has one implementation.
   *
   * Nothing else in the suite can see that. Paste a run-counting loop back into
   * `round.ts`, drop the import, and every other test still passes — corpus
   * replay included — because a second copy that is *correct* is invisible to a
   * behavioural test. So this clause reads the source.
   *
   * It asserts the delegation and nothing else. An earlier version also tried
   * to ban run-scanning loops outside `score.ts` by pattern, which was both
   * under-inclusive (a `while`, or an unrolled `&&` chain like
   * `wallCompletedRows`'s own, walks straight past it) and a landmine (it
   * matched any ordinary reverse loop, and would one day fail a gating build
   * for a reason unrelated to [E1-24]). Delegation is the half with teeth: a
   * second implementation that nothing calls is dead code, not a second rule.
   */
  it('[E1-68] [E1-70] keeps one implementation of each wall rule', () => {
    const read = (file: string): string =>
      readFileSync(join(PACKAGE_ROOT, 'src', file), 'utf8');

    expect(read('round.ts'), 'round.ts scores without placementValue [E1-68]').toMatch(
      /placementValue\s*\(/,
    );
    const inspect = read('inspect.ts');
    for (const fn of ['wallCompletedRows', 'wallCompletedCols', 'wallCompletedColors']) {
      expect(inspect, `inspect.ts does not delegate to ${fn} [E1-70]`).toMatch(
        new RegExp(`return\\s+${fn}\\s*\\(`),
      );
    }
  });

  /**
   * [E1-71] widens that check, because delegation alone stopped being enough
   * the moment round scoring grew a second branch [0007 S7-12], [0007 S7-35].
   *
   * The clause above is satisfied by the *unexplained* branch calling
   * `placementValue`. A recording sibling — one that asks for the two runs and
   * combines them itself, so it can report `h` and `v` alongside the points —
   * would leave that assertion green and write [E1-24] down a second time, and
   * the two copies would then be free to disagree. Every behavioural test in
   * the suite would keep passing until they did.
   *
   * Two decidable clauses, and the escape hatch for each named where it is
   * declared:
   *
   * - The **fusion shape** — a comparison against `1` used as the test of a
   *   conditional expression — occurs exactly once in `packages/engine/src`,
   *   inside `placementValue`. Code that legitimately needs to branch on a
   *   count of one writes an `if`, not a ternary; the ban is on the shape the
   *   rule is written in, which is why it can be checked at all.
   * - The **run scans** are called from exactly two places, both in
   *   `score.ts`: `placementValue`, which fuses them, and `placementRuns`,
   *   which does not [0007 S7-11]. A third caller is a sibling.
   *
   * Both are run against a source they must reject, because a matcher that has
   * never matched is a matcher nobody has tested.
   */
  describe('[E1-71] no second implementation of the fusion rule', () => {
    /** Line and block comments removed; the rule quoted in prose is not a copy of it. */
    const stripComments = (text: string): string =>
      text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');

    const FUSION = /(?:[<>]=?|[=!]==?)\s*1\s*\?/g;
    const callsOf = (name: string, code: string): number =>
      (code.match(new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`, 'g')) ?? []).length;

    /**
     * `placementValue`'s own body, excised: it is the one implementation, so
     * the question the clause asks is whether the shape appears anywhere else.
     * The excision is asserted to have found something, below, so a renamed
     * function cannot quietly turn this into a scan of nothing.
     */
    const withoutPlacementValue = (code: string): string => {
      const start = code.indexOf('export function placementValue');
      if (start < 0) return code;
      const end = code.indexOf('\n}', start);
      return code.slice(0, start) + code.slice(end);
    };

    const srcFiles = (): { file: string; code: string }[] =>
      readdirSync(join(PACKAGE_ROOT, 'src'))
        .filter((f) => f.endsWith('.ts'))
        .map((file) => ({
          file,
          code: stripComments(readFileSync(join(PACKAGE_ROOT, 'src', file), 'utf8')),
        }));

    /** What a recording sibling looks like: the runs asked for, then fused again. */
    const SIBLING = {
      file: 'round.ts',
      code: [
        'function scoreAndReport(wall, row, col) {',
        '  const h = horizontalRun(wall, row, col);',
        '  const v = verticalRun(wall, row, col);',
        '  return { h, v, points: h > 1 || v > 1 ? (h > 1 ? h : 0) + (v > 1 ? v : 0) : 1 };',
        '}',
      ].join('\n'),
    };

    const fusions = (files: { file: string; code: string }[]): string[] =>
      files.flatMap(({ file, code }) =>
        [...withoutPlacementValue(code).matchAll(FUSION)].map((m) => `${file}: ${m[0]}`),
      );

    const runCallers = (files: { file: string; code: string }[]): string[] =>
      files.flatMap(({ file, code }) => {
        const calls = callsOf('horizontalRun', code) + callsOf('verticalRun', code);
        return calls === 0 ? [] : [`${file}: ${calls}`];
      });

    it('finds the rule written exactly once, in placementValue', () => {
      const files = srcFiles();
      const score = files.find((f) => f.file === 'score.ts')!.code;
      // The excision really cuts the rule out, so the scan below is a scan of
      // everything else rather than of a function that has been renamed away.
      expect(score).toMatch(FUSION);
      expect(withoutPlacementValue(score)).not.toMatch(FUSION);
      expect(fusions(files)).toEqual([]);
    });

    it('finds the run scans called from placementValue and placementRuns and nowhere else', () => {
      expect(runCallers(srcFiles())).toEqual(['score.ts: 4']);
    });

    it('fails against a sibling that combines the runs itself', () => {
      // The mutation this check exists for, and the reason it is not enough for
      // `round.ts` to merely mention `placementValue` somewhere.
      expect(fusions([SIBLING]).length).toBeGreaterThan(0);
      expect(runCallers([SIBLING])).toEqual(['round.ts: 2']);
      expect(runCallers([...srcFiles(), SIBLING])).toEqual(['score.ts: 4', 'round.ts: 2']);
    });
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
    // `fromJSON` takes an `AzulJSON`, not a state, so the state snapshot above
    // says nothing about whether it leaves its own argument alone. Hold the
    // view and a deep copy of it, and compare both after the roster runs.
    const json = toJSON(s);
    const jsonBefore = structuredClone(json);
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
      placementValue(s.walls[0], 0, 0),
      wallCompletedRows(s.walls[0]),
      wallCompletedCols(s.walls[0]),
      wallCompletedColors(s.walls[1]),
      fromJSON(json, 0),
    ];
    expect(results.length).toBe(20);
    expect(toCanonical(s)).toEqual(before);
    expect(json, 'fromJSON mutated the view it was given').toEqual(jsonBefore);
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
