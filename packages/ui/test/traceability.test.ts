/**
 * Traceability [U3-76].
 *
 * Every requirement in *0003 — Web interface* is either cited by a test — by
 * identifier, in a test name or an adjacent comment — or listed with a reason in
 * that spec's *Traceability exemptions* table. Nothing may be quietly untested:
 * a requirement is covered, or it is excused in writing.
 *
 * Three failures matter, and the third is the one that rots silently: a
 * requirement neither cited nor exempt, a citation of an identifier that does
 * not exist, and an exemption naming an identifier that no longer does —
 * because a requirement rewritten into something testable keeps its stale
 * excuse and stays out of the suite forever.
 *
 * This file cites its own requirement above and no other. The scanner reads
 * every identifier in the suite as a citation, so naming a requirement here
 * would be enough to "cover" it — the one exception being the requirement this
 * file is the implementation of.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = join(HERE, '..', '..', '..', 'spec', '0003-web-interface.md');
const PREFIX = 'U3';
const IDENTIFIER = new RegExp(`\\[${PREFIX}-(\\d+)\\]`, 'g');
/** A requirement is *declared* where the spec bolds its identifier. */
const DECLARATION = new RegExp(`\\*\\*\\[${PREFIX}-(\\d+)\\]\\*\\*`, 'g');
const EXEMPTION_HEADING = '### Traceability exemptions';

function ids(text: string, pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(pattern)) out.add(`${PREFIX}-${match[1]}`);
  return out;
}

/** Every test source, which is the whole harness. */
function testSources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) out.push({ file: path, text: readFileSync(path, 'utf8') });
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
    // `| requirements | reason |` splits to ['', requirements, reason, ''].
    if (cells.length < 4) continue;
    const named = ids(cells[1], IDENTIFIER);
    if (named.size === 0) continue; // the header row and the --- separator
    for (const id of named) out.set(id, cells[2]);
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

/**
 * Every identifier the spec declares, in order and with repeats — which is what
 * `declared` cannot show, being a set.
 */
function declarations(text: string): string[] {
  return [...text.matchAll(DECLARATION)].map((match) => `${PREFIX}-${match[1]}`);
}

describe('traceability against spec 0003', () => {
  it('reads a spec that actually declares requirements', () => {
    expect(declared.size).toBeGreaterThan(50);
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
    const stale = [...excused.keys()].filter((id) => !declared.has(id));
    expect(stale.sort(), 'the exemptions table names requirements that no longer exist').toEqual(
      [],
    );
  });

  /**
   * Identifiers are append-only, so a number reused for a second requirement is
   * two requirements wearing one name — and this file collapses them into a
   * single set key, after which either one's citation covers both and deleting
   * either test still reports full coverage. The hole is invisible to every
   * check above precisely because they all work in identifiers.
   */
  it('declares each requirement once', () => {
    const seen = new Set<string>();
    // `Set.add` returns the set, which is truthy for a first sighting and for a
    // repeat alike; `has` before `add` is the distinction being drawn.
    const repeated = declarations(spec).filter((id) => {
      const again = seen.has(id);
      seen.add(id);
      return again;
    });
    expect(
      [...new Set(repeated)].sort(),
      'a requirement identifier is declared twice; identifiers are append-only, so the second ' +
        'one takes the next free number',
    ).toEqual([]);
  });

  it('gives every exemption a written reason', () => {
    const unexplained = [...excused.entries()]
      .filter(([, reason]) => reason.length < 20)
      .map(([id]) => id);
    expect(unexplained.sort(), 'exemptions without a reason').toEqual([]);
    expect(excused.size).toBeGreaterThan(0);
  });
});
