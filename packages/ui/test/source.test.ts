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
/** The expert's per-seat sessions, which the worker owns [W6-40]. */
const EXPERTS = 'experts.ts';

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

function sources(match = /\.tsx?$/): Source[] {
  const out: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (match.test(entry)) {
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
 * every source in `offenders` must produce at least one.
 *
 * Plural because a clause can have more than one way of being broken, and a
 * matcher proven against one of them is not proven against the others: the
 * `apply` clauses below each cover two entry points, and a regex that had
 * quietly stopped matching the second would look exactly like a passing test.
 */
interface Clause {
  cites: string;
  what: string;
  find: (files: Source[]) => string[];
  offenders: Source[];
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
    offenders: [{ file: 'bad.ts', code: 'const CAPACITIES = [1, 2, 3, 4, 5];\n' }],
  },
  {
    cites: '[U3-49]',
    what: 'the incremental penalty ladder',
    find: (files) => matches(files, /-1\s*,\s*-1\s*,\s*-2\s*,\s*-2\s*,\s*-2\s*,\s*-3\s*,\s*-3/g),
    offenders: [{ file: 'bad.ts', code: 'const p = [-1, -1, -2, -2, -2, -3, -3];\n' }],
  },
  {
    cites: '[U3-49]',
    what: 'the cumulative penalty ladder',
    find: (files) =>
      matches(files, /0\s*,\s*-1\s*,\s*-2\s*,\s*-4\s*,\s*-6\s*,\s*-8\s*,\s*-11\s*,\s*-14/g),
    offenders: [{ file: 'bad.ts', code: 'const c = [0, -1, -2, -4, -6, -8, -11, -14];\n' }],
  },
  {
    cites: '[U3-49]',
    what: 'a remainder against 5 or NUM_COLORS',
    // The escape hatch, since the ban is absolute: a flat [25] wall is walked
    // with nested r/col loops over NUM_ROWS and NUM_COLORS, indexing
    // r * NUM_COLORS + col [0001 E1-2] — never with a remainder.
    find: (files) => matches(files, /%\s*(?:5|NUM_COLORS)\b/g),
    offenders: [{ file: 'bad.ts', code: 'const col = (color + row) % NUM_COLORS;\n' }],
  },
  {
    cites: '[U3-51]',
    what: 'the action multipliers 30 and 6 in arithmetic',
    find: (files) =>
      matches(
        files,
        /(?<![\w.])(?:30|6)(?![\w.])\s*[*/%]|[*/%]\s*(?<![\w.])(?:30|6)(?![\w.])/g,
      ),
    offenders: [{ file: 'bad.ts', code: 'const a = source * 30 + color * 6 + dest;\n' }],
  },
  {
    cites: '[U3-50]',
    what: 'a copied state with apply called after it',
    find: (files) =>
      files
        .filter(({ code }) => {
          const copy = code.search(/\b(?:structuredClone|fromCanonical|clone)\s*\(/);
          // [U3-75] as amended: `/\bapply\s*\(/` does not match
          // `applyExplained(`, so an unwidened clause would silently stop
          // covering the entry point `submit` actually takes [0007 S7-1].
          return copy >= 0 && code.search(/\bapply(?:Explained)?\s*\(/) > copy;
        })
        .map(({ file }) => file),
    offenders: [
      { file: 'bad.ts', code: 'const s = clone(state);\napply(s, action);\n' },
      { file: 'bad.ts', code: 'const s = clone(state);\napplyExplained(s, action);\n' },
    ],
  },
  {
    cites: '[U3-18]',
    what: 'apply or applyExplained called outside the state module',
    find: (files) => matches(outsideStateModule(files), /\bapply(?:Explained)?\s*\(/g),
    offenders: [
      { file: `${COMPONENTS}Bad.tsx`, code: 'apply(state, action);\n' },
      { file: `${COMPONENTS}Bad.tsx`, code: 'applyExplained(state, action);\n' },
    ],
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
    offenders: [{
      file: `${COMPONENTS}Bad.tsx`,
      code: "import { state, view } from '../game.js';\n",
    }],
  },
  {
    cites: '[U3-40]',
    what: 'a read of tilesLeft in the state module',
    // A component that needs it for [U3-32] simply displays it; only the state
    // module is barred, which is where a transition would be predicted rather
    // than detected.
    find: (files) => matches(inStateModule(files), /\btilesLeft\b/g),
    offenders: [{ file: STATE_MODULE, code: 'if (state.tilesLeft === 0) endRound();\n' }],
  },
  {
    cites: '[U3-8]',
    what: 'a dynamic import',
    find: (files) => matches(files, /\bimport\s*\(/g),
    offenders: [{ file: 'bad.ts', code: "const m = await import('./late.js');\n" }],
  },
  {
    cites: '[U3-8]',
    what: 'an absolute http(s) URL outside a comment',
    find: (files) => matches(files, /https?:\/\//g),
    offenders: [{ file: 'bad.ts', code: "const logo = 'https://example.com/logo.png';\n" }],
  },
];

const src = sources();
const styles = sources(/\.css$/);

/**
 * The stylesheet, for the one clause that means the same thing there [U3-75].
 *
 * The rest of the check reads TypeScript and would be wrong about CSS — the
 * action-multiplier clause matches `6 * var(--tile-gap)`, where the 6 is six
 * gaps between seven tiles. But an absolute URL means exactly what it means in
 * a string literal, and a stylesheet is the likeliest place in the package to
 * write one: `background: url(https://…)`, `@import`, `@font-face`. None of
 * those goes through `fetch`, so [U3-72]'s throwing stubs never see them —
 * the browser's own loader fetches them — and "no network request at runtime"
 * ([U3-8]) is too load-bearing a claim to leave that corner unwatched.
 *
 * `stripComments` is written for `//` and `/* … *\/`; CSS has only the second,
 * so it is a superset and safe here.
 */
describe('the stylesheet, for the clause that carries over', () => {
  it('[U3-8] [U3-75] loads no asset from an absolute URL', () => {
    expect(styles.length, 'no stylesheet was found to check').toBeGreaterThan(0);
    expect(matches(styles, /https?:\/\//g)).toEqual([]);
  });

  // The clause above is a matcher, and a matcher is worth nothing until it has
  // been seen to reject something. These are the three shapes it is for.
  it('[U3-75] rejects the ways a stylesheet reaches the network', () => {
    for (const code of [
      '.a { background: url(https://example.com/tile.png); }',
      "@import url('https://fonts.example.com/x.css');",
      "@font-face { src: url(https://example.com/f.woff2); }",
    ]) {
      expect(matches([{ file: 'bad.css', code }], /https?:\/\//g), code).not.toEqual([]);
    }
  });
});

describe('the module layout the check runs against', () => {
  /**
   * [W6-31]. `bot` is reachable from exactly one file, so "the interface
   * contains no strategy" is a property of the import graph rather than a
   * promise — the same shape [U3-78] uses for "contains no rule".
   */
  it('[W6-31] keeps bot and ai-bot out of the components and the state module', () => {
    // The ban is on those two, precisely. `worker.ts` imports `bot` because
    // running the search is its job [W6-12], `experts.ts` imports `ai-bot`
    // because holding the expert's sessions is its job [W6-40], and
    // `opponent.ts` imports their types; what must not happen is a component
    // or the held state reaching strategy directly, because then a move could
    // enter the game without passing `submit` [W6-8].
    for (const source of [...inComponents(src), ...inStateModule(src)]) {
      for (const player of ['bot', 'ai-bot']) {
        expect(source.code, `${source.file} imports ${player} [W6-31]`).not.toMatch(
          new RegExp(`from\\s+'${player}'`),
        );
      }
    }
    // The ones that may really do, so the clause above is not vacuous.
    expect(src.find((s) => s.file === SEAM)!.code).toMatch(/from\s+'bot'/);
    expect(src.find((s) => s.file === WORKER)!.code).toMatch(/from\s+'bot'/);
    expect(src.find((s) => s.file === EXPERTS)!.code).toMatch(/from\s+'ai-bot'/);
    // `opponent.ts` reaches `ai-bot` for its types and for the committed gate
    // result, which is what decides whether `expert` is offered at all
    // ([0008 A8-33]).
    expect(src.find((s) => s.file === SEAM)!.code).toMatch(/'ai-bot(?:\/[^']*)?'/);
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
    expect(other.map((s) => s.file).sort()).toEqual([SEAM, EXPERTS, 'main.tsx', WORKER].sort());
  });
});

describe('[U3-75] the source check', () => {
  it.each(CLAUSES.map((c) => [`${c.cites} ${c.what}`, c] as const))(
    'rejects %s',
    (_name, clause) => {
      for (const offender of clause.offenders) {
        expect(
          clause.find([offender]).length,
          `the matcher does not match ${offender.code.trim()}`,
        ).toBeGreaterThan(0);
      }
      expect(clause.offenders.length).toBeGreaterThan(0);
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
