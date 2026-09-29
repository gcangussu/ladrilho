/**
 * The settling side of spec 0010: the order of authority [C10-26], the
 * register of rulings [C10-27], and how each ruling's found vector, trace and
 * correction hang together [C10-29], [C10-30], [C10-31], [C10-33], [C10-35] —
 * all checked by [C10-43].
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VECTOR_DIR } from '../src/run.js';
import { cleanScratch, scratchDir } from './support/mutations.js';
import { REPO } from './support/harness.js';
import { checkRegister, parseRulings } from './support/register.js';

afterAll(cleanScratch);

const SPEC = readFileSync(join(REPO, 'spec', '0010-engines-cross-checked.md'), 'utf8');
const TRACES = join(REPO, 'tools', 'vectors', 'traces');

describe('the authorities [C10-26]', () => {
  it('ranks the publisher, then one rulebook pinned by hash, then our own rulings', () => {
    const rows = SPEC.split('\n').filter((l) => /^ {2}\| [123] \|/.test(l));
    expect(rows.map((r) => r.split('|')[1].trim())).toEqual(['1', '2', '3']);
    expect(rows[1]).toMatch(/SHA-256 `[0-9a-f]{64}`/);
    expect(rows[1]).toMatch(/\.pdf`\]\(https:\/\//);
  });
});

describe('the committed register [C10-43]', () => {
  it(`holds together (${parseRulings(SPEC).length} rulings; passes vacuously while there are none)`, () => {
    expect(checkRegister(SPEC, VECTOR_DIR, TRACES)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A fixture register, well-formed, then broken one way at a time.

const RULING = (n: number, file: string, oracle: string, upstream: string): string => `#### Ruling ${n} — a case

- **Position:** \`${file}\`
- **Authority:** 2, page 5, *Wall-tiling*
- **Decision:** what the rules require
- **Referees:** the Rust engine
- **Oracle:** ${oracle}
- **Reported upstream:** ${upstream}
- **0001:** none
`;

function fixtureSpec(rulings: string[]): string {
  return `## Settling\n\n### Rulings\n\n\`\`\`markdown\n#### Ruling 9 — an example in a fence\n\`\`\`\n\n${rulings.join('\n')}\n### Found vectors\n`;
}

interface Fixture {
  spec: string;
  vectors: Record<string, object>;
  traces: Record<string, object>;
}

const RUN_1 = { seed: 7, game: 3, steer: 'uniform', start: 'new', cap: 400 };
const RUN_2 = { seed: 7, game: 9, steer: 'floor', start: 'short:40', cap: 400 };

function good(): Fixture {
  const corrections = ['ruling-2-marker'];
  return {
    spec: fixtureSpec([
      RULING(1, 'found-01-runs.json', 'agrees', '—'),
      RULING(2, 'found-02-marker.json', 'wrong — correction `ruling-2-marker`', '[issue](https://github.com/RemiFabre/ludometer/issues/1)'),
    ]),
    vectors: {
      'game-00.json': { kind: 'game', generator: { policy: 'uniform', pythonSeed: 0, corrections } },
      'found-01-runs.json': {
        kind: 'game',
        note: 'Ruling 1: two runs',
        generator: { policy: 'trace', pythonSeed: 1000001, trace: RUN_1, corrections },
      },
      'found-02-marker.json': {
        kind: 'position',
        note: 'Ruling 2: the marker',
        generator: { policy: 'trace', pythonSeed: 1000002, trace: RUN_2, corrections },
      },
    },
    traces: {
      'found-01-runs.json': { run: RUN_1, start: null },
      'found-02-marker.json': { run: RUN_2, start: { bag: [] } },
    },
  };
}

function problems(f: Fixture): string[] {
  const dir = scratchDir('crosscheck-register-');
  mkdirSync(join(dir, 'vectors'));
  mkdirSync(join(dir, 'traces'));
  for (const [name, v] of Object.entries(f.vectors)) writeFileSync(join(dir, 'vectors', name), JSON.stringify(v));
  for (const [name, t] of Object.entries(f.traces)) writeFileSync(join(dir, 'traces', name), JSON.stringify(t));
  return checkRegister(f.spec, join(dir, 'vectors'), join(dir, 'traces'));
}

type Vec = { kind: string; note: string; generator: Record<string, unknown> };
const vec = (f: Fixture, name: string): Vec => f.vectors[name] as Vec;

const DEFECTS: [string, (f: Fixture) => void, RegExp][] = [
  ['a missing line [C10-27]', (f) => void (f.spec = f.spec.replace('- **Decision:** what the rules require\n', '')), /Ruling 1 has no Decision line/],
  ['a gap in the numbering [C10-27]', (f) => void (f.spec = f.spec.replace('#### Ruling 2', '#### Ruling 3')), /numbered out of sequence/],
  ['a found vector that does not exist [C10-29]', (f) => void delete f.vectors['found-01-runs.json'], /names found-01-runs.json, which does not exist/],
  ['a found vector no ruling names [C10-29]', (f) => void (f.vectors['found-03-extra.json'] = { kind: 'game' }), /found-03-extra.json is named by 0 rulings/],
  ['a note that does not begin with its ruling [C10-30]', (f) => void (vec(f, 'found-01-runs.json').note = 'two runs'), /note does not begin "Ruling 1:"/],
  ['a kind that does not match the start [C10-30]', (f) => void (vec(f, 'found-02-marker.json').kind = 'game'), /kind does not match/],
  ['a missing trace [C10-31]', (f) => void delete f.traces['found-01-runs.json'], /found-01-runs.json: no trace/],
  ['a trace block that is not the trace’s run [C10-31]', (f) => void (vec(f, 'found-01-runs.json').generator.trace = RUN_2), /generator.trace is not its trace's run/],
  ['a policy other than trace [C10-31]', (f) => void (vec(f, 'found-01-runs.json').generator.policy = 'uniform'), /policy is not "trace"/],
  ['a continuation seed out of place [C10-31]', (f) => void (vec(f, 'found-02-marker.json').generator.pythonSeed = 2), /pythonSeed is not 1000002/],
  ['an oracle line that names no correction [C10-32]', (f) => void (f.spec = f.spec.replace('wrong — correction `ruling-2-marker`', 'wrong')), /neither "agrees" nor its own correction/],
  ['a wrong oracle with no upstream link [C10-35]', (f) => void (f.spec = f.spec.replace('[issue](https://github.com/RemiFabre/ludometer/issues/1)', 'not yet')), /no upstream report is linked/],
  [
    'a correction no vector was recorded under [C10-33]',
    (f) => {
      for (const v of Object.values(f.vectors)) (v as Vec).generator.corrections = [];
    },
    /correction ruling-2-marker is in no vector/,
  ],
  ['a correction in force that no ruling names [C10-33]', (f) => void (vec(f, 'game-00.json').generator.corrections = ['ruling-2-marker', 'ruling-5-ghost']), /correction ruling-5-ghost is named by no ruling/],
];

describe('the register check, seen to fail [C10-43]', () => {
  it('finds nothing wrong with a well-formed register of two rulings', () => {
    expect(problems(good())).toEqual([]);
  });

  for (const [name, plant, expected] of DEFECTS) {
    it(`names ${name}`, () => {
      const f = structuredClone(good());
      plant(f);
      const found = problems(f);
      expect(found.some((p) => expected.test(p)), found.join('\n')).toBe(true);
    });
  }
});
