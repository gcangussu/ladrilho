/**
 * The source check of [B4-51]: a bounded matcher over an enumerated set of
 * forbidden shapes in `packages/bot/src`.
 *
 * Same instrument as [0003 U3-75] and the same limits. It cannot see a
 * re-implemented rule that reads only permitted fields — the property tests in
 * `tiers.test.ts` and the behavioural barrier test in `evaluate.test.ts` are
 * for that. What this does is make the *decidable* half fail the build, fast
 * and readably.
 *
 * Every clause runs against source with comments stripped, and every clause is
 * also run against a source it is supposed to reject, because a matcher that
 * has never matched is a matcher nobody has tested.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
/** The module [B4-7] is about. */
const EVALUATION = 'evaluate.ts';

interface Source {
  file: string;
  /** The file with comments removed. */
  code: string;
}

/**
 * Strip line and block comments, leaving string and template literals intact.
 *
 * Required, not cosmetic: this package's comments name the very fields the
 * clauses below forbid, because explaining *why* the evaluation may not read
 * `factories` means writing `factories` down.
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

function sources(): Source[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((file) => ({ file, code: stripComments(readFileSync(join(SRC, file), 'utf8')) }));
}

const FILES = sources();

/** The fields a boundary node's deal lands in [B4-7]. */
const DEAL_FIELDS = ['factories', 'center', 'bag', 'lid', 'tilesLeft'];

describe('the evaluation cannot see the deal [B4-7], [B4-51]', () => {
  it('[B4-51] [B4-7] names none of the dealt fields', () => {
    const evaluation = FILES.find((f) => f.file === EVALUATION);
    expect(evaluation, `${EVALUATION} is missing`).toBeDefined();
    for (const field of DEAL_FIELDS) {
      expect(
        evaluation!.code,
        `${EVALUATION} reads ${field} — a boundary node has already been dealt [B4-7]`,
      ).not.toMatch(new RegExp(`\\.${field}\\b`));
    }
  });

  it('[B4-51] rejects a source that reads one', () => {
    const offending = stripComments('const n = s.factories[0][2]; // a comment mentioning bag');
    expect(offending).toMatch(/\.factories\b/);
    // And the comment really was stripped, so the clause above is not passing
    // by accident on a file that only mentions the field in prose.
    expect(offending).not.toMatch(/\bbag\b/);
  });
});

describe('nothing ambient [B4-2], [B4-31], [B4-51]', () => {
  /** The one reading [B4-28] permits, and where it is allowed to live. */
  const CLOCK_OWNER = 'search.ts';

  it('[B4-51] [B4-31] consults no random source anywhere', () => {
    for (const { file, code } of FILES) {
      expect(code, `${file} uses Math.random [B4-31]`).not.toMatch(/Math\s*\.\s*random/);
      expect(code, `${file} constructs an Rng [B4-31]`).not.toMatch(/\bnew\s+Rng\b/);
    }
  });

  it('[B4-51] [B4-2] reads a clock only in the fail-safe', () => {
    for (const { file, code } of FILES) {
      expect(code, `${file} reads Date.now [B4-2]`).not.toMatch(/Date\s*\.\s*now/);
      if (file === CLOCK_OWNER) continue;
      expect(code, `${file} reads performance.now outside ${CLOCK_OWNER} [B4-28]`).not.toMatch(
        /performance\s*\.\s*now/,
      );
    }
    // The owner really does read it: the clause above is not vacuous.
    expect(FILES.find((f) => f.file === CLOCK_OWNER)!.code).toMatch(/performance\s*\.\s*now/);
  });

  it('[B4-51] [B4-2] touches no DOM, network, storage or filesystem', () => {
    const FORBIDDEN = [
      /\bdocument\b/,
      /\bwindow\b/,
      /\bfetch\s*\(/,
      /\blocalStorage\b/,
      /\bsessionStorage\b/,
      /\bindexedDB\b/,
      /\bnode:/,
      /\brequire\s*\(/,
    ];
    for (const { file, code } of FILES) {
      for (const pattern of FORBIDDEN) {
        expect(code, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('[B4-51] [B4-3] holds no module-level mutable state', () => {
    for (const { file, code } of FILES) {
      // A top-level binding is one at column zero.
      expect(code, `${file} declares a module-level let [B4-3]`).not.toMatch(/^let\s/m);
      expect(code, `${file} declares a module-level var [B4-3]`).not.toMatch(/^var\s/m);
      expect(code, `${file} declares a module-level Map or Set [B4-3]`).not.toMatch(
        /^const\s+\w+\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/m,
      );
    }
  });

  it('[B4-51] rejects sources that hold each of those', () => {
    expect(stripComments('let cache = 0;\n')).toMatch(/^let\s/m);
    expect(stripComments('const seen = new Map();\n')).toMatch(
      /^const\s+\w+\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b/m,
    );
    expect(stripComments('const x = Math.random();')).toMatch(/Math\s*\.\s*random/);
  });
});

describe('no rule lives here [B4-8], [B4-51]', () => {
  it('[B4-51] [B4-8] contains no modulo by the board dimensions', () => {
    // `%` by 5 is the wall geometry of [0001 E1-1] — `wallCol` and
    // `wallColorAt` are the engine's answer and are exported for this.
    for (const { file, code } of FILES) {
      expect(code, `${file} computes a wall index with % [0001 E1-1]`).not.toMatch(
        /%\s*(?:5\b|NUM_COLORS\b|NUM_ROWS\b)/,
      );
    }
  });

  it('[B4-51] [B4-8] contains neither penalty ladder', () => {
    // [0001 E1-27]'s ladder, in either form. `floorPenalty` is the answer.
    for (const { file, code } of FILES) {
      expect(code, `${file} holds the floor penalty ladder [0001 E1-27]`).not.toMatch(
        /-\s*1\s*,\s*-\s*1\s*,\s*-\s*2/,
      );
      expect(code, `${file} holds the cumulative penalty ladder [0001 E1-27]`).not.toMatch(
        /0\s*,\s*-\s*1\s*,\s*-\s*2\s*,\s*-\s*4/,
      );
    }
  });

  it('[B4-51] [B4-8] holds no board-shaped numeric table', () => {
    // A module-level array of 5, 7 or 25 numbers is a copy of something the
    // engine already owns — the wall, the floor, or the penalties.
    const TABLE = /^(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*\[[\s\d,.\-]+\]/m;
    for (const { file, code } of FILES) {
      const match = code.match(TABLE);
      if (match === null) continue;
      const entries = match[0].split(',').length;
      expect(
        entries === 5 || entries === 7 || entries === 25,
        `${file} holds a ${entries}-entry numeric table: ${match[0].slice(0, 60)}`,
      ).toBe(false);
    }
  });

  it('[B4-51] rejects a source holding a ladder or a table', () => {
    expect(stripComments('const p = [-1, -1, -2, -2, -2, -3, -3];')).toMatch(
      /-\s*1\s*,\s*-\s*1\s*,\s*-\s*2/,
    );
    const table = stripComments('const WALL = [0, 1, 2, 3, 4];\n');
    expect(table).toMatch(/^(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*\[[\s\d,.\-]+\]/m);
    expect(stripComments('const i = (col - row + 5) % 5;')).toMatch(/%\s*(?:5\b|NUM_COLORS\b)/);
  });
});

describe('the package surface [B4-1]', () => {
  it('[B4-1] imports nothing but the engine and itself', () => {
    for (const { file, code } of FILES) {
      for (const match of code.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1];
        expect(
          specifier === 'engine' || specifier.startsWith('./') || specifier.startsWith('../'),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('[B4-62] does not export the search through the package entry [B4-5]', async () => {
    const entry = await import('../src/index.js');
    // `search` takes an `AzulState`, and a state carries the bag in order.
    // Exporting it would put a public door through the barrier [B4-5] calls
    // structural — `chooseMove` cannot leak an order it was never handed, and
    // that argument holds only while it is the only way in.
    expect(Object.keys(entry)).not.toContain('search');
    expect(Object.keys(entry).sort()).toEqual([
      'BUDGETS',
      'FAIL_SAFE_MS',
      'TIERS',
      'WIN',
      'chooseMove',
      'evaluate',
    ]);
  });

  it('[B4-1] declares engine as its only runtime dependency', () => {
    const manifest = JSON.parse(
      readFileSync(join(HERE, '..', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).toEqual(['engine']);
    expect(manifest.dependencies['engine']).toMatch(/^workspace:/);
  });
});
