/**
 * The traceability scanner, shared by every spec this package implements.
 *
 * A requirement is either cited by a test — by identifier, in a test name or an
 * adjacent comment — or listed with a reason in its spec's *Traceability
 * exemptions* table. Nothing may be quietly untested: it is covered, or it is
 * excused in writing.
 *
 * Three failures matter, and the third rots silently: a requirement neither
 * cited nor exempt; a citation of an identifier that does not exist; and an
 * exemption naming an identifier that no longer does — because a requirement
 * rewritten into something testable keeps its stale excuse and stays out of the
 * suite forever.
 *
 * A caller names the requirement its own file implements, so the scanner can
 * exclude it. Every identifier anywhere in the suite counts as a citation, so a
 * file that names the requirement it *is* would cover it merely by existing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

export interface TraceabilitySpec {
  /** Absolute path to the spec markdown. */
  specFile: string;
  /** The spec's identifier prefix, e.g. `B4`. */
  prefix: string;
  /** The requirement the calling test file implements, e.g. `B4-59`. */
  ownRequirement: string;
  /** Absolute directories holding the citing sources. */
  sourceDirs: string[];
  /** Sanity floor: a spec this small is one the scanner failed to read. */
  minimumRequirements: number;
}

const EXEMPTION_HEADING = '### Traceability exemptions';

function ids(text: string, pattern: RegExp, prefix: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(pattern)) out.add(`${prefix}-${match[1]}`);
  return out;
}

function sources(dirs: string[]): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) out.push({ file: path, text: readFileSync(path, 'utf8') });
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}

/**
 * The exemption rows: identifiers in the first column, reason in the second.
 * A row without a reason is not an exemption, it is an omission.
 */
function exemptions(spec: string, prefix: string, identifier: RegExp): Map<string, string> {
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
    const named = ids(cells[1], identifier, prefix);
    if (named.size === 0) continue; // the header row and the --- separator
    for (const id of named) out.set(id, cells[2]);
  }
  return out;
}

/** Declares the whole check as `it` blocks. Call inside a `describe`. */
export function checkTraceability(config: TraceabilitySpec): void {
  const { prefix, ownRequirement, minimumRequirements } = config;
  const identifier = new RegExp(`\\[${prefix}-(\\d+)\\]`, 'g');
  /** A requirement is *declared* where the spec bolds its identifier. */
  const declaration = new RegExp(`\\*\\*\\[${prefix}-(\\d+)\\]\\*\\*`, 'g');

  const spec = readFileSync(config.specFile, 'utf8');
  const declared = ids(spec, declaration, prefix);
  const excused = exemptions(spec, prefix, identifier);
  const files = sources(config.sourceDirs);

  const cited = new Map<string, string[]>();
  for (const { file, text } of files) {
    for (const id of ids(text, identifier, prefix)) {
      cited.set(id, [...(cited.get(id) ?? []), file]);
    }
  }
  // The file implementing the check names its own requirement; that is not
  // coverage, it is the implementation.
  cited.delete(ownRequirement);

  it('reads a spec that actually declares requirements', () => {
    expect(declared.size).toBeGreaterThan(minimumRequirements);
    expect(files.length).toBeGreaterThan(2);
  });

  it('cites or excuses every requirement', () => {
    const orphans = [...declared].filter(
      (id) => id !== ownRequirement && !cited.has(id) && !excused.has(id),
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
    const stale = [...excused.keys()].filter((id) => !declared.has(id));
    expect(stale.sort(), 'the exemptions table names requirements that no longer exist').toEqual(
      [],
    );
  });

  /**
   * Identifiers are append-only, so a number reused for a second requirement is
   * two requirements wearing one name — after which either one's citation
   * covers both and deleting either test still reports full coverage. The hole
   * is invisible to every check above precisely because they work in
   * identifiers.
   */
  it('declares each requirement once', () => {
    const seen = new Set<string>();
    const repeated = [...spec.matchAll(declaration)]
      .map((match) => `${prefix}-${match[1]}`)
      .filter((id) => {
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
}
