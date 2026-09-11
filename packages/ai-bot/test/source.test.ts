/**
 * The source check of [A8-43]: a bounded matcher over an enumerated set of
 * forbidden shapes in `packages/ai-bot/src`.
 *
 * The same instrument as [0004 B4-51], with the same limits, and it claims no
 * more than it matches. Every pattern below names the forms it catches, and
 * each is run against a source it exists to reject — a matcher that has never
 * matched is a matcher nobody has tested.
 *
 * What it cannot see, named so nobody reads more into a green run:
 * - an aliased `Math` other than the two spellings its clause lists;
 * - module-level state held in a closure — a `const` bound to the result of an
 *   arrow or function called later, rather than at load; an IIFE is caught,
 *   a factory called from another module's top level is caught by the call
 *   clause there;
 * - anything `stripComments` misreads: it knows strings and comments but not
 *   regular-expression literals, so a `/'/` in src would derail it (there is
 *   none today);
 * - a property hung on an exported function (`f.cache = new Map()` at column
 *   0 is not a declaration, and the runtime check below passes any function
 *   without looking at its own keys);
 * - a rule re-implemented from permitted fields, which is what the fixture
 *   checks against the original are for.
 *
 * The runtime check at the end complements the static clauses for exports:
 * whatever the spelling, an exported value that is not a primitive, a function
 * or deeply frozen fails it. It says nothing about unexported bindings.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

/**
 * Strip line and block comments, leaving string and template literals intact.
 * Required, not cosmetic: this package's comments name the very things the
 * clauses forbid, because saying why `exp` is hand-written means writing `exp`.
 */
function stripComments(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * A long base64 literal: the generated weights ([A8-15]), which are data, not
 * code.
 *
 * Blanked before the clauses run. 600 KB of base64 contains `Date` and `fetch`
 * and every other short word sooner or later, sometimes with `+` or `/` either
 * side of it, which is a word boundary — so left in, a clause would eventually
 * fail on a payload that means nothing, and the fix would be to weaken the
 * clause. The literal is checked for what it must be instead: base64 and
 * nothing else.
 */
const BASE64_PAYLOAD = /'[A-Za-z0-9+/=]{1000,}'/g;

function scannable(text: string): string {
  return stripComments(text).replace(BASE64_PAYLOAD, "''");
}

const FILES = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((file) => ({ file, code: scannable(readFileSync(join(SRC, file), 'utf8')) }));

/** A clause: what it forbids, why, and a source it exists to reject. */
interface Clause {
  name: string;
  pattern: RegExp;
  rejects: string;
}

/** ECMA-262's implementation-approximated `Math` functions, every one [A8-49]. */
const APPROXIMATED = [
  'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'atan2', 'cbrt', 'cos', 'cosh',
  'exp', 'expm1', 'hypot', 'log', 'log1p', 'log10', 'log2', 'pow', 'sin', 'sinh',
  'tan', 'tanh',
];

const CLAUSES: Clause[] = [
  // [A8-2]: nothing ambient.
  { name: '[A8-2] Math.random', pattern: /Math\s*\.\s*random/, rejects: 'const x = Math.random();' },
  { name: '[A8-2] an Rng', pattern: /\bRng\b/, rejects: "import { Rng } from 'engine';" },
  { name: '[A8-2] Date', pattern: /\bDate\b/, rejects: 'const t = Date.now();' },
  { name: '[A8-2] performance', pattern: /\bperformance\b/, rejects: 'performance.now()' },
  { name: '[A8-2] the DOM', pattern: /\b(?:document|window|navigator)\b/, rejects: 'window.x = 1;' },
  { name: '[A8-2] the network', pattern: /\b(?:fetch|XMLHttpRequest|WebSocket)\b/, rejects: 'fetch(url)' },
  {
    name: '[A8-2] storage',
    pattern: /\b(?:localStorage|sessionStorage|indexedDB|caches)\b/,
    rejects: 'localStorage.setItem(k, v)',
  },
  { name: '[A8-2] the filesystem', pattern: /\bnode:|\brequire\s*\(/, rejects: "import fs from 'node:fs';" },
  // [A8-4]: `choose` schedules nothing.
  {
    name: '[A8-4] scheduled work',
    pattern: /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|Promise|async|await)\b/,
    rejects: 'queueMicrotask(() => step());',
  },
  // [A8-49]: arithmetic that repeats on every machine.
  {
    name: '[A8-49] an implementation-approximated Math function',
    pattern: new RegExp(`Math\\s*\\.\\s*(?:${APPROXIMATED.join('|')})\\b`),
    rejects: 'const y = Math.exp(x);',
  },
  { name: '[A8-49] the ** operator', pattern: /\*\*(?!\/)/, rejects: 'const y = 2 ** j;' },
  {
    // The two spellings of an alias this can see. `const m = Math` or a
    // destructuring would otherwise walk every name above past the clause.
    name: '[A8-49] an alias of Math',
    pattern: /=\s*Math\s*[;,\n)]|\}\s*=\s*Math\b/,
    rejects: 'const { exp } = Math;',
  },
  // [A8-3], [A8-15]: no module-level mutable state. A top-level binding is one
  // at column zero.
  { name: '[A8-3] a module-level let', pattern: /^(?:export\s+)?let\s/m, rejects: 'let cache = 0;\n' },
  { name: '[A8-3] a module-level var', pattern: /^(?:export\s+)?var\s/m, rejects: 'var cache = 0;\n' },
  {
    // A column-0 `const` initialised by `new`: typed arrays, Map, Set, Array.
    name: '[A8-3] a module-level constructed object',
    pattern: /^(?:export\s+)?const\s+[\w$]+\s*(?::[^=]+)?=\s*new\s/m,
    rejects: 'export const W = new Float32Array(8);\n',
  },
  {
    // A column-0 `const` initialised by calling anything but `Object.freeze`:
    // `Float32Array.from(x)`, `decode(BLOB)`, `new Map()` behind a factory.
    // An arrow function is not a call and passes, as `universeShuffle` does.
    name: '[A8-3] a module-level call other than Object.freeze',
    pattern: /^(?:export\s+)?const\s+[\w$]+\s*(?::[^=]+)?=\s*(?!Object\.freeze\s*\()[\w$.]+\s*(?:<[^>]*>)?\(/m,
    rejects: 'export const LEAK = Float32Array.from([1, 2]);\n',
  },
  {
    // A column-0 `const` initialised by a parenthesised function, which is how
    // an IIFE starts. Also rejects a merely parenthesised arrow, harmlessly.
    name: '[A8-3] a module-level IIFE',
    pattern: /^(?:export\s+)?const\s+[\w$]+\s*(?::[^=]+)?=\s*\(\s*(?:function\b|async\b|\()/m,
    rejects: 'export const tick = (() => { let n = 0; return () => n++; })();\n',
  },
  {
    // An array or object literal is mutable unless frozen.
    name: '[A8-3] a module-level unfrozen literal',
    pattern: /^(?:export\s+)?const\s+[\w$]+\s*(?::[^=]+)?=\s*[[{]/m,
    rejects: 'const SEEN = [];\n',
  },
  // [A8-1]: nothing under src imports bot or ui — `from '…'`, a side-effect
  // `import '…'`, or a dynamic `import('…')`.
  {
    name: '[A8-1] an import of bot or ui',
    pattern:
      /(?:\bfrom|\bimport)\s*\(?\s*['"](?:bot|ui)(?:\/[^'"]*)?['"]|(?:\bfrom|\bimport)\s*\(?\s*['"](?:\.\.\/)+(?:bot|ui)\//,
    rejects: "import { chooseMove } from 'bot';",
  },
  // [A8-6]: no rule lives here.
  {
    name: '[A8-6] the floor penalty ladder',
    pattern: /-\s*1\s*,\s*-\s*1\s*,\s*-\s*2/,
    rejects: 'const p = [-1, -1, -2, -2, -2, -3, -3];',
  },
  {
    // As a list, signed or not. The original's own spelling is a dict
    // (`score_round`'s `discard_mapping`), which this does not see.
    name: '[A8-6] the cumulative penalty ladder',
    pattern: /0\s*,\s*-?\s*1\s*,\s*-?\s*2\s*,\s*-?\s*4/,
    rejects: 'const cumulative = [0, 1, 2, 4, 6, 8, 11, 14];',
  },
  {
    name: '[A8-6] % by the board dimensions',
    pattern: /%\s*(?:5\b|NUM_COLORS\b|NUM_ROWS\b)/,
    rejects: 'const col = (colour + row) % 5;',
  },
];

describe('the source check [A8-43]', () => {
  it('[A8-43] reads the sources it is meant to', () => {
    expect(FILES.map((f) => f.file)).toContain('board.ts');
    expect(FILES.map((f) => f.file)).toContain('weights.ts');
    expect(FILES.length).toBeGreaterThan(3);
  });

  it('[A8-43] blanks the weights payload, and only the payload', () => {
    const raw = readFileSync(join(SRC, 'weights.ts'), 'utf8');
    expect(raw.length).toBeGreaterThan(100_000);
    const scanned = FILES.find((f) => f.file === 'weights.ts')!.code;
    // What is left is the table and the exports, all of it still scanned.
    expect(scanned.length).toBeLessThan(20_000);
    expect(scanned).toMatch(/export const TENSORS = Object\.freeze\(\[/);
    expect(scanned).toMatch(/WEIGHTS_BASE64 =\n?\s*''/);
    // The payload really is base64 and nothing else, which is what lets it be
    // blanked rather than read.
    const payload = raw.match(BASE64_PAYLOAD);
    expect(payload).toHaveLength(1);
    expect(payload![0].slice(1, -1)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // And a clause still catches a violation written outside the payload.
    expect(scannable("const S = 'AAAA';\nlet x = 1;\n")).toMatch(/^(?:export\s+)?let\s/m);
  });

  for (const clause of CLAUSES) {
    it(`${clause.name} appears nowhere in src`, () => {
      for (const { file, code } of FILES) {
        expect(code, `${file} matches ${clause.pattern}`).not.toMatch(clause.pattern);
      }
    });

    it(`${clause.name}: the clause rejects a source that holds it`, () => {
      expect(stripComments(clause.rejects)).toMatch(clause.pattern);
    });
  }

  it('[A8-43] strips comments, so a clause is not passing on prose', () => {
    const stripped = stripComments('const y = f(x); // Math.exp would be wrong here\n/* ** */');
    expect(stripped).not.toMatch(/Math\s*\.\s*exp/);
    expect(stripped).not.toMatch(/\*\*/);
    // And strings survive, so a clause still sees a specifier.
    expect(stripComments("import x from 'bot';")).toMatch(/'bot'/);
  });

  it('[A8-43] the call clause lets the shapes src uses through', () => {
    const call = CLAUSES.find((c) => c.name.includes('call other than'))!.pattern;
    const iife = CLAUSES.find((c) => c.name.includes('IIFE'))!.pattern;
    for (const allowed of [
      'export const universeShuffle: Shuffle = (bag) => {\n',
      'export const EXPERT = Object.freeze({\n',
      'export const BOARD_SIZE = BOARD_ROWS * BOARD_COLS;\n',
    ]) {
      expect(allowed).not.toMatch(call);
      expect(allowed).not.toMatch(iife);
    }
    for (const rejected of ['const T = decode(S);\n', 'const M = makeMap<number>();\n']) {
      expect(rejected).toMatch(call);
    }
  });

  it('[A8-1] the import clause sees all three spellings', () => {
    const clause = CLAUSES.find((c) => c.name.includes('import of bot'))!.pattern;
    for (const spelling of [
      "import { chooseMove } from 'bot';",
      "import 'bot';",
      "const m = await import('bot');",
      "export { x } from 'ui/src/opponent.js';",
      "import x from '../../bot/src/index.js';",
    ]) {
      expect(stripComments(spelling), spelling).toMatch(clause);
    }
  });

  /** Every module specifier, in the three spellings the clause above names. */
  const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g;

  it('[A8-1] imports nothing but the engine and itself', () => {
    for (const { file, code } of FILES) {
      for (const match of code.matchAll(SPECIFIER)) {
        const specifier = match[1];
        expect(specifier === 'engine' || specifier.startsWith('./'), `${file} imports ${specifier}`).toBe(true);
      }
    }
    // And the scan sees the spellings it claims to.
    const seen = (text: string): string[] => [...text.matchAll(SPECIFIER)].map((m) => m[1]);
    expect(seen(`import 'bot';\nimport("ui");\nimport type { X } from 'engine';`)).toEqual([
      'bot',
      'ui',
      'engine',
    ]);
  });
});

/** Is `value` a primitive, a function, or frozen all the way down? */
function immutable(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return true;
  if (typeof value === 'function') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  // A non-empty typed array cannot be frozen, so it always fails here.
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) =>
    immutable((value as Record<PropertyKey, unknown>)[key], seen),
  );
}

describe('what src exports is immutable [A8-3], [A8-15]', () => {
  it('[A8-3] every exported value of every module is a primitive, a function, or deeply frozen', async () => {
    for (const { file } of FILES) {
      const module = (await import(join(SRC, file))) as Record<string, unknown>;
      for (const [name, value] of Object.entries(module)) {
        expect(immutable(value), `${file} exports ${name}, which can be written to`).toBe(true);
      }
    }
  });

  it('[A8-3] rejects the exports it exists to reject', () => {
    expect(immutable(new Float32Array([1, 2]))).toBe(false);
    expect(immutable(Object.freeze({ shapes: [[23, 6]] }))).toBe(false);
    expect(immutable(Object.freeze({ shapes: Object.freeze([Object.freeze([23, 6])]) }))).toBe(true);
    expect(immutable(new Map())).toBe(false);
    expect(immutable('a string')).toBe(true);
  });
});
