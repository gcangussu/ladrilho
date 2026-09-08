/**
 * Traceability [W6-39]: every requirement in *0006 — Opponent in the interface*
 * is cited by a test or excused in writing.
 *
 * Mirrors [U3-76] and shares its three failure modes — a requirement neither
 * cited nor exempt, a citation of an identifier that does not exist, and an
 * exemption naming one that no longer does. The last is the one that rots
 * silently: a requirement rewritten into something testable keeps its stale
 * excuse and stays out of the suite forever.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = join(HERE, '..', '..', '..', 'spec', '0006-opponent-in-the-interface.md');
const PREFIX = 'W6';
const IDENTIFIER = new RegExp(`\\[${PREFIX}-(\\d+)\\]`, 'g');
const DECLARATION = new RegExp(`\\*\\*\\[${PREFIX}-(\\d+)\\]\\*\\*`, 'g');
const EXEMPTION_HEADING = '### Traceability exemptions';
/** This file implements [W6-39]; naming it is not covering it. */
const OWN = 'W6-39';

function ids(text: string, pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(pattern)) out.add(`${PREFIX}-${match[1]}`);
  return out;
}

function sources(): { file: string; text: string }[] {
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
    if (named.size === 0) continue;
    for (const id of named) out.set(id, cells[2]);
  }
  return out;
}

const spec = readFileSync(SPEC, 'utf8');
const declared = ids(spec, DECLARATION);
const excused = exemptions(spec);
const cited = new Map<string, string[]>();
for (const { file, text } of sources()) {
  for (const id of ids(text, IDENTIFIER)) cited.set(id, [...(cited.get(id) ?? []), file]);
}
cited.delete(OWN);

describe('traceability against spec 0006', () => {
  it('reads a spec that actually declares requirements', () => {
    expect(declared.size).toBeGreaterThan(30);
  });

  it('cites or excuses every requirement', () => {
    const orphans = [...declared].filter(
      (id) => id !== OWN && !cited.has(id) && !excused.has(id),
    );
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
    expect(
      [...excused.keys()].filter((id) => !declared.has(id)).sort(),
      'the exemptions table names requirements that no longer exist',
    ).toEqual([]);
  });

  it('declares each requirement once', () => {
    const seen = new Set<string>();
    const repeated = [...spec.matchAll(DECLARATION)]
      .map((m) => `${PREFIX}-${m[1]}`)
      .filter((id) => {
        const again = seen.has(id);
        seen.add(id);
        return again;
      });
    expect([...new Set(repeated)].sort(), 'a requirement identifier is declared twice').toEqual([]);
  });

  it('gives every exemption a written reason', () => {
    const unexplained = [...excused.entries()]
      .filter(([, reason]) => reason.length < 20)
      .map(([id]) => id);
    expect(unexplained.sort(), 'exemptions without a reason').toEqual([]);
    expect(excused.size).toBeGreaterThan(0);
  });
});
