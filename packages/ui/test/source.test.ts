/**
 * The source check of spec 0003's *Verification* section: a bounded matcher
 * over an enumerated set of forbidden shapes in `packages/ui/src`.
 *
 * It is not, and cannot be, a judgement about whether code "contains a rule" —
 * a view-side re-implementation of legality that reads only view-model fields
 * would pass every clause here. The property test is the instrument for that,
 * and it catches the copy at the first position where the copy is wrong. What
 * this file does is make the *decidable* half fail the build.
 *
 * Every clause runs against source with comments stripped. That is required for
 * the last clause and right for all of them: a penalty ladder quoted in a doc
 * comment is not a second copy of the rules, and an `apply` named in prose is
 * not a call.
 *
 * Each clause is also run against a source it is supposed to reject, because a
 * matcher that has never matched is a matcher nobody has tested.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
/** The state module and the components: the two sides [U3-78] names. */
const STATE_MODULE = 'game.ts';
const COMPONENTS = `components${sep}`;
/** The worker seam, the only file that may import `bot` [W6-31], [U3-78]. */
const SEAM = 'opponent.ts';
/** What runs inside the worker [W6-12], [U3-78]. */
const WORKER = 'worker.ts';

interface Source {
  /** Path relative to `src`, so a failure reads as `components/App.tsx`. */
  file: string;
  /** The file with comments removed. */
  code: string;
}

/**
 * Strip line and block comments, leaving string and template literals intact.
 *
 * `/` only begins a comment when the next character is `/` or `*`, so a regular
 * expression literal such as `/^\d+$/` passes through untouched unless it
 * contains a comment opener — which none in this package does.
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
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

function sources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) {
        out.push({ file: relative(SRC, path), code: stripComments(readFileSync(path, 'utf8')) });
      }
    }
  };
  walk(SRC);
  return out;
}

/** Files whose stripped code matches, reported as `file: matched text`. */
function matches(files: Source[], pattern: RegExp): string[] {
  return files.flatMap(({ file, code }) =>
    [...code.matchAll(pattern)].map((m) => `${file}: ${m[0].trim()}`),
  );
}

const inComponents = (files: Source[]): Source[] =>
  files.filter((s) => s.file.startsWith(COMPONENTS));
const inStateModule = (files: Source[]): Source[] => files.filter((s) => s.file === STATE_MODULE);
const outsideStateModule = (files: Source[]): Source[] =>
  files.filter((s) => s.file !== STATE_MODULE);

/**
 * One forbidden shape. `find` returns a description of every occurrence, and
 * `offender` is a source that must produce at least one.
 */
interface Clause {
  cites: string;
  what: string;
  find: (files: Source[]) => string[];
  offender: Source;
}

const CLAUSES: Clause[] = [
  {
    cites: '[U3-49]',
    what: 'a module-level numeric table of length 5, 7 or 25',
    // A declaration at column 0 is module level; anything indented is inside
    // something. Every element must be numeric for it to be a table.
    find: (files) => {
      const DECLARATION = /^(?:export\s+)?(?:const|let|var)\s+\w+[^=\n]*=\s*\[([^\]]*)\]/gm;
      return files.flatMap(({ file, code }) =>
        [...code.matchAll(DECLARATION)]
          .map((m) => ({
            file,
            items: m[1]
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          }))
          .filter(({ items }) => items.length > 0 && items.every((i) => /^-?\d+(\.\d+)?$/.test(i)))
          .filter(({ items }) => [5, 7, 25].includes(items.length))
          .map(({ file, items }) => `${file}: [${items.join(', ')}]`),
      );
    },
    offender: { file: 'bad.ts', code: 'const CAPACITIES = [1, 2, 3, 4, 5];\n' },
  },
  {
    cites: '[U3-49]',
    what: 'the incremental penalty ladder',
    find: (files) => matches(files, /-1\s*,\s*-1\s*,\s*-2\s*,\s*-2\s*,\s*-2\s*,\s*-3\s*,\s*-3/g),
    offender: { file: 'bad.ts', code: 'const p = [-1, -1, -2, -2, -2, -3, -3];\n' },
  },
  {
    cites: '[U3-49]',
    what: 'the cumulative penalty ladder',
    find: (files) =>
      matches(files, /0\s*,\s*-1\s*,\s*-2\s*,\s*-4\s*,\s*-6\s*,\s*-8\s*,\s*-11\s*,\s*-14/g),
    offender: { file: 'bad.ts', code: 'const c = [0, -1, -2, -4, -6, -8, -11, -14];\n' },
  },
  {
    cites: '[U3-49]',
    what: 'a remainder against 5 or NUM_COLORS',
    // The escape hatch, since the ban is absolute: a flat [25] wall is walked
    // with nested r/col loops over NUM_ROWS and NUM_COLORS, indexing
    // r * NUM_COLORS + col [0001 E1-2] — never with a remainder.
    find: (files) => matches(files, /%\s*(?:5|NUM_COLORS)\b/g),
    offender: { file: 'bad.ts', code: 'const col = (color + row) % NUM_COLORS;\n' },
  },
  {
    cites: '[U3-51]',
    what: 'the action multipliers 30 and 6 in arithmetic',
    find: (files) =>
      matches(
        files,
        /(?<![\w.])(?:30|6)(?![\w.])\s*[*/%]|[*/%]\s*(?<![\w.])(?:30|6)(?![\w.])/g,
      ),
    offender: { file: 'bad.ts', code: 'const a = source * 30 + color * 6 + dest;\n' },
  },
  {
    cites: '[U3-50]',
    what: 'a copied state with apply called after it',
    find: (files) =>
      files
        .filter(({ code }) => {
          const copy = code.search(/\b(?:structuredClone|fromCanonical|clone)\s*\(/);
          return copy >= 0 && code.search(/\bapply\s*\(/) > copy;
        })
        .map(({ file }) => file),
    offender: { file: 'bad.ts', code: 'const s = clone(state);\napply(s, action);\n' },
  },
  {
    cites: '[U3-18]',
    what: 'apply called outside the state module',
    find: (files) => matches(outsideStateModule(files), /\bapply\s*\(/g),
    offender: { file: `${COMPONENTS}Bad.tsx`, code: 'apply(state, action);\n' },
  },
  {
    cites: '[U3-1]',
    what: 'the held state imported into a component',
    // The binding is not exported at all, so this asserts that stays true.
    find: (files) => {
      const IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*game\.js['"]/g;
      return inComponents(files).flatMap(({ file, code }) =>
        [...code.matchAll(IMPORT)]
          .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]))
          .filter((name) => name === 'state')
          .map((name) => `${file}: ${name}`),
      );
    },
    offender: {
      file: `${COMPONENTS}Bad.tsx`,
      code: "import { state, view } from '../game.js';\n",
    },
  },
  {
    cites: '[U3-40]',
    what: 'a read of tilesLeft in the state module',
    // A component that needs it for [U3-32] simply displays it; only the state
    // module is barred, which is where a transition would be predicted rather
    // than detected.
    find: (files) => matches(inStateModule(files), /\btilesLeft\b/g),
    offender: { file: STATE_MODULE, code: 'if (state.tilesLeft === 0) endRound();\n' },
  },
  {
    cites: '[U3-8]',
    what: 'a dynamic import',
    find: (files) => matches(files, /\bimport\s*\(/g),
    offender: { file: 'bad.ts', code: "const m = await import('./late.js');\n" },
  },
  {
    cites: '[U3-8]',
    what: 'an absolute http(s) URL outside a comment',
    find: (files) => matches(files, /https?:\/\//g),
    offender: { file: 'bad.ts', code: "const logo = 'https://example.com/logo.png';\n" },
  },
];

const src = sources();

describe('the module layout the check runs against', () => {
  /**
   * [W6-31]. `bot` is reachable from exactly one file, so "the interface
   * contains no strategy" is a property of the import graph rather than a
   * promise — the same shape [U3-78] uses for "contains no rule".
   */
  it('[W6-31] keeps bot out of the components and the state module', () => {
    // The ban is on those two, precisely. `worker.ts` imports `bot` because
    // running the search is its job [W6-12], and `opponent.ts` imports its
    // types; what must not happen is a component or the held state reaching
    // strategy directly, because then a move could enter the game without
    // passing `submit` [W6-8].
    for (const source of [...inComponents(src), ...inStateModule(src)]) {
      expect(source.code, `${source.file} imports bot [W6-31]`).not.toMatch(/from\s+'bot'/);
    }
    // The two that may really do, so the clause above is not vacuous.
    expect(src.find((s) => s.file === SEAM)!.code).toMatch(/from\s+'bot'/);
    expect(src.find((s) => s.file === WORKER)!.code).toMatch(/from\s+'bot'/);
  });

  /**
   * [W6-12]. The worker must not be able to reach the held state: if it could,
   * a move could enter the game without passing `submit` ([U3-18], [W6-8]).
   */
  it('[W6-12] keeps the state module out of the worker', () => {
    const worker = src.find((s) => s.file === WORKER);
    expect(worker, `${WORKER} is missing`).toBeDefined();
    expect(worker!.code, 'the worker imports the state module [W6-12]').not.toMatch(
      /from\s+'\.\/game\.js'/,
    );
    expect(worker!.code, 'the worker imports a component [W6-12]').not.toMatch(
      /from\s+'\.\/components\//,
    );
  });

  it('[U3-78] finds the single state module and the components beside it', () => {
    expect(inStateModule(src)).toHaveLength(1);
    expect(inComponents(src).length).toBeGreaterThan(3);
    // Anything outside those two sides has to be accounted for here, or a
    // clause below would quietly stop covering it.
    const other = src.filter((s) => s.file !== STATE_MODULE && !s.file.startsWith(COMPONENTS));
    expect(other.map((s) => s.file).sort()).toEqual([SEAM, 'main.tsx', WORKER].sort());
  });
});

describe('[U3-75] the source check', () => {
  it.each(CLAUSES.map((c) => [`${c.cites} ${c.what}`, c] as const))(
    'rejects %s',
    (_name, clause) => {
      expect(clause.find([clause.offender]).length, 'the matcher never matches').toBeGreaterThan(0);
    },
  );

  it.each(CLAUSES.map((c) => [`${c.cites} ${c.what}`, c] as const))(
    'finds no %s in packages/ui/src',
    (_name, clause) => {
      expect(clause.find(src)).toEqual([]);
    },
  );

  it('strips comments without eating string literals or regular expressions', () => {
    const code = stripComments(
      [
        "const re = /^\\d+$/; // a seed",
        '/* a block */',
        "const url = 'https://example.com';",
        'const c = (a + b) % NUM_COLORS;',
      ].join('\n'),
    );
    expect(code).toContain('/^\\d+$/');
    expect(code).not.toContain('a seed');
    expect(code).not.toContain('a block');
    expect(code).toContain('https://example.com');
    expect(code).toContain('% NUM_COLORS');
  });
});
