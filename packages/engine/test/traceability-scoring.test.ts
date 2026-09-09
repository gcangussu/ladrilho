/**
 * Traceability against *0007 — Scoring explained*, and the check that its
 * amendments actually landed.
 *
 * The first half is [0002 V2-26], [0002 V2-27] and [0002 V2-31] applied to a
 * second spec: every requirement in 0007 is cited by a test or excused in
 * writing, no test cites an identifier that does not exist, and no exemption
 * names one that no longer does. A separate file rather than a second block in
 * `traceability.test.ts`, because the two scanners read different specs with
 * different prefixes and a shared one would have to be parameterised over the
 * thing that actually differs.
 *
 * The second half is the unusual one, and 0007 argues for it: a process promise
 * is normally exempt, and this one is not, because it is a promise about two
 * files in this repository and a test can read them. 0006 promised
 * [0003 U3-82] and never declared it, and a check of this shape would have
 * caught that the day it shipped.
 *
 * This file deliberately contains no `S7` identifiers of its own outside the
 * citations it means as citations; the scanner would read the rest as noise.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = join(HERE, '..', '..', '..', 'spec');
const SPEC = join(SPEC_DIR, '0007-scoring-explained.md');
const PREFIX = 'S7';
/**
 * A citation. The optional `0007 ` is how a test names the requirement from
 * inside a file that is mostly about 0001 — `[0007 S7-29]` and `[S7-29]` are
 * the same citation, and a scanner that saw only one of them would report the
 * other as an orphan.
 */
const IDENTIFIER = new RegExp(`\\[(?:0007 )?${PREFIX}-(\\d+)\\]`, 'g');
/** A requirement is *declared* where the spec bolds its identifier. */
const DECLARATION = new RegExp(`\\*\\*\\[${PREFIX}-(\\d+)\\]\\*\\*`, 'g');
const EXEMPTION_HEADING = '### Traceability exemptions';

function ids(text: string, pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(pattern)) out.add(`${PREFIX}-${match[1]}`);
  return out;
}

/** Every `.ts` file under `test/`, which is the whole harness. */
function testSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.ts')) out.push({ file: path, text: readFileSync(path, 'utf8') });
    }
  };
  walk(HERE);
  return out;
}

/**
 * The exemption rows: identifiers in the first column, reason in the second.
 * A row without a reason is not an exemption, it is an omission.
 */
function exemptions(spec: string): Map<string, string> {
  const start = spec.indexOf(EXEMPTION_HEADING);
  if (start < 0) throw new Error(`the spec has no "${EXEMPTION_HEADING}" section`);
  const rest = spec.slice(start + EXEMPTION_HEADING.length);
  const end = rest.indexOf('\n## ');
  const section = end < 0 ? rest : rest.slice(0, end);
  const out = new Map<string, string>();
  for (const line of section.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const named = ids(cells[1], IDENTIFIER);
    if (named.size === 0) continue; // the header row and the --- separator
    const reason = cells[2];
    for (const id of named) out.set(id, reason);
  }
  return out;
}

const spec = readFileSync(SPEC, 'utf8');
const declared = ids(spec, DECLARATION);
const excused = exemptions(spec);
const sources = testSources();
const cited = new Map<string, string[]>();
for (const { file, text } of sources) {
  for (const id of ids(text, IDENTIFIER)) {
    cited.set(id, [...(cited.get(id) ?? []), file]);
  }
}

describe('[S7-39] traceability against spec 0007', () => {
  it('reads a spec that actually declares requirements', () => {
    expect(declared.size).toBeGreaterThan(30);
    expect(sources.length).toBeGreaterThan(3);
  });

  it('cites or excuses every requirement', () => {
    const orphans = [...declared].filter((id) => !cited.has(id) && !excused.has(id));
    expect(
      orphans.sort(),
      'requirements with no citing test and no exemption — write a test, or add a row to the ' +
        'exemptions table with a reason, which is a spec change and gets read like one',
    ).toEqual([]);
  });

  it('cites no identifier the spec does not declare', () => {
    const ghosts = [...cited.keys()]
      .filter((id) => !declared.has(id))
      .map((id) => `${id} (cited in ${cited.get(id)!.join(', ')})`);
    expect(ghosts.sort(), 'tests citing a requirement that does not exist').toEqual([]);
  });

  it('excuses no identifier the spec does not declare', () => {
    // The case that rots silently: a requirement gets rewritten into something
    // testable and its stale excuse keeps it out of the suite forever.
    const stale = [...excused.keys()].filter((id) => !declared.has(id));
    expect(stale.sort(), 'the exemptions table names requirements that no longer exist').toEqual(
      [],
    );
  });

  it('gives every exemption a written reason', () => {
    const unexplained = [...excused.entries()]
      .filter(([, reason]) => reason.length < 20)
      .map(([id]) => id);
    expect(unexplained.sort(), 'exemptions without a reason').toEqual([]);
    expect(excused.size).toBeGreaterThan(0);
  });
});

/**
 * [S7-38], which asserts [S7-42] and [S7-43]: the amendments 0007 requires of
 * the two specs it amends have landed in those files.
 *
 * Deliberately not a check that the *prose* says something — a test cannot
 * read for meaning. It checks the two things that are decidable and that were
 * the actual failure mode: an identifier promised and never declared, and an
 * interface listed in a document that no longer describes the code.
 */
describe('[S7-38] the amendments landed in the specs they amend', () => {
  const read = (name: string): string => readFileSync(join(SPEC_DIR, name), 'utf8');
  const declares = (text: string, id: string): boolean => text.includes(`**[${id}]**`);

  it('[S7-42] 0001 declares E1-71 and lists applyExplained', () => {
    const engine = read('0001-engine-core.md');
    expect(declares(engine, 'E1-71'), '0001 does not declare [E1-71]').toBe(true);
    // In the `## Interfaces` listing specifically, which is the half a reader
    // goes to when they want to know what the package exports.
    const start = engine.indexOf('\n## Interfaces');
    expect(start, 'the Interfaces section is missing').toBeGreaterThan(0);
    const section = engine.slice(start, engine.indexOf('\n- **[E1-50]', start));
    expect(section.length, 'the Interfaces section ends before it begins').toBeGreaterThan(100);
    expect(section, '0001 lists no applyExplained').toMatch(/function applyExplained\s*\(/);
    expect(section, '0001 lists the private placementRuns').not.toMatch(/placementRuns\s*\(/);
  });

  it('[S7-43] 0003 declares the four requirements the interface side needed', () => {
    const ui = read('0003-web-interface.md');
    for (const id of ['U3-82', 'U3-83', 'U3-84', 'U3-85']) {
      expect(declares(ui, id), `0003 does not declare [${id}]`).toBe(true);
    }
  });

  /**
   * The check that the two above are not vacuous: the same predicate, applied
   * to an identifier neither spec declares and to a listing that does not
   * mention the function, says no.
   */
  it('says no when an identifier is promised and not declared', () => {
    const engine = read('0001-engine-core.md');
    const ui = read('0003-web-interface.md');
    // 0006 promised [0003 U3-82] and declared none of it. The number is taken
    // now; the next free one is not, and a promise about it would read exactly
    // as that one did.
    expect(declares(ui, 'U3-99')).toBe(false);
    expect(declares(engine, 'E1-99')).toBe(false);
    expect('function apply(s: AzulState, action: number): void;').not.toMatch(
      /function applyExplained\s*\(/,
    );
  });
});
