/**
 * The source check of [A8-43]: a bounded matcher over an enumerated set of
 * forbidden shapes in `packages/ai-bot/src`.
 *
 * The same instrument as [0004 B4-51], with the same limits, and it claims no
 * more than it matches. Every pattern below names the forms it catches, and
 * each is run against a source it exists to reject — a matcher that has never
 * matched is a matcher nobody has tested. What it cannot see is named where it
 * matters: an aliased `Math` is caught only in the two spellings listed, and a
 * rule re-implemented from permitted fields is not caught at all, which is what
 * the fixture checks against the original are for.
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

const FILES = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .sort()
  .map((file) => ({ file, code: stripComments(readFileSync(join(SRC, file), 'utf8')) }));

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
    // Every `new` at module level: typed arrays, Map, Set, arrays, anything.
    name: '[A8-3] a module-level constructed object',
    pattern: /^(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*new\s/m,
    rejects: 'export const W = new Float32Array(8);\n',
  },
  {
    // An array or object literal is mutable unless frozen.
    name: '[A8-3] a module-level unfrozen literal',
    pattern: /^(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*[[{]/m,
    rejects: 'const SEEN = [];\n',
  },
  // [A8-1]: nothing under src imports bot or ui.
  {
    name: '[A8-1] an import of bot or ui',
    pattern: /from\s+['"](?:bot|ui)(?:\/[^'"]*)?['"]|from\s+['"](?:\.\.\/)+(?:bot|ui)\//,
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
    expect(FILES.length).toBeGreaterThan(3);
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

  it('[A8-1] imports nothing but the engine and itself', () => {
    for (const { file, code } of FILES) {
      for (const match of code.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1];
        expect(specifier === 'engine' || specifier.startsWith('./'), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });
});
