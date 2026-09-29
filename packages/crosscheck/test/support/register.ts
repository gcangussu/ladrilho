/**
 * The register check of [C10-43]: the *Rulings* of spec 0010 against the
 * committed vectors and traces. Returns every problem as a sentence, so the
 * suite can assert both that the real register has none and that a fixture
 * register with one defect of each kind has exactly the ones planted.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const LINES = ['Position', 'Authority', 'Decision', 'Referees', 'Oracle', 'Reported upstream', '0001'] as const;

export interface Ruling {
  number: number;
  lines: Partial<Record<(typeof LINES)[number], string>>;
}

/** The entries under *Rulings*, fenced examples excluded. */
export function parseRulings(spec: string): Ruling[] {
  const start = spec.indexOf('### Rulings');
  const end = spec.indexOf('### Found vectors');
  if (start < 0 || end < start) throw new Error('the spec has no Rulings section before Found vectors');
  const section = spec.slice(start, end).replace(/```[\s\S]*?```/g, '');
  const out: Ruling[] = [];
  for (const block of section.split(/^#### /m).slice(1)) {
    const heading = /^(?:~~)?Ruling (\d+) — /.exec(block);
    if (heading === null) continue;
    const lines: Ruling['lines'] = {};
    for (const name of LINES) {
      const m = new RegExp(`^- \\*\\*${name}:\\*\\* (.+)$`, 'm').exec(block);
      if (m) lines[name] = m[1].trim();
    }
    out.push({ number: Number(heading[1]), lines });
  }
  return out;
}

interface VectorFacts {
  kind?: string;
  note?: string;
  generator?: { policy?: string; pythonSeed?: number; trace?: unknown; corrections?: string[] };
}

export function checkRegister(spec: string, vectorDir: string, traceDir: string): string[] {
  const problems: string[] = [];
  const rulings = parseRulings(spec);
  const files = readdirSync(vectorDir).filter((f) => f.endsWith('.json')).sort();
  const read = (dir: string, f: string): VectorFacts & { run?: unknown; start?: unknown } =>
    JSON.parse(readFileSync(join(dir, f), 'utf8'));

  rulings.forEach((r, i) => {
    if (r.number !== i + 1) problems.push(`Ruling ${r.number} is numbered out of sequence; expected ${i + 1}`);
    for (const name of LINES) {
      if (r.lines[name] === undefined) problems.push(`Ruling ${r.number} has no ${name} line`);
    }
  });

  const named = new Map<string, number[]>();
  for (const r of rulings) {
    const vector = /^`(found-(\d+)-[a-z0-9-]+\.json)`$/.exec(r.lines.Position ?? '');
    if (vector === null) {
      problems.push(`Ruling ${r.number} names no found vector`);
      continue;
    }
    const [, file, nn] = vector;
    named.set(file, [...(named.get(file) ?? []), r.number]);
    if (!files.includes(file)) {
      problems.push(`Ruling ${r.number} names ${file}, which does not exist`);
      continue;
    }
    const v = read(vectorDir, file);
    if (!(v.note ?? '').startsWith(`Ruling ${r.number}:`)) {
      problems.push(`${file}: its note does not begin "Ruling ${r.number}:"`);
    }
    if (!existsSync(join(traceDir, file))) {
      problems.push(`${file}: no trace of that name`);
    } else {
      const trace = read(traceDir, file);
      if (!isDeepStrictEqual(v.generator?.trace, trace.run)) problems.push(`${file}: generator.trace is not its trace's run`);
      if (v.kind !== (trace.start === null ? 'game' : 'position')) problems.push(`${file}: kind does not match its start`);
    }
    if (v.generator?.policy !== 'trace') problems.push(`${file}: generator.policy is not "trace"`);
    if (v.generator?.pythonSeed !== 1000000 + Number(nn)) problems.push(`${file}: generator.pythonSeed is not ${1000000 + Number(nn)}`);
  }
  for (const f of files.filter((f) => f.startsWith('found-'))) {
    const by = named.get(f) ?? [];
    if (by.length !== 1) problems.push(`${f} is named by ${by.length} rulings, not one`);
  }

  const correctionsNamed = new Set<string>();
  for (const r of rulings) {
    const oracle = r.lines.Oracle ?? '';
    if (oracle === 'agrees') continue;
    const c = /^wrong — correction `(ruling-(\d+)-[a-z0-9-]+)`$/.exec(oracle);
    if (c === null || Number(c[2]) !== r.number) {
      problems.push(`Ruling ${r.number}: the oracle line is neither "agrees" nor its own correction`);
      continue;
    }
    correctionsNamed.add(c[1]);
    if (!/https?:\/\//.test(r.lines['Reported upstream'] ?? '')) {
      problems.push(`Ruling ${r.number}: the oracle was wrong and no upstream report is linked`);
    }
  }
  const correctionsUsed = new Set<string>();
  for (const f of files) for (const c of read(vectorDir, f).generator?.corrections ?? []) correctionsUsed.add(c);
  for (const c of correctionsNamed) if (!correctionsUsed.has(c)) problems.push(`correction ${c} is in no vector's generator.corrections`);
  for (const c of correctionsUsed) if (!correctionsNamed.has(c)) problems.push(`correction ${c} is named by no ruling`);
  return problems;
}
