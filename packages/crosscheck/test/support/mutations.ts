/**
 * The mutations of [C10-38], applied to a copy of the TypeScript engine's
 * sources in a scratch directory — never to the tree — with each anchor
 * asserted to match exactly once before the copy is written.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import type { Engine } from '../../src/engine.js';
import { REPO } from './harness.js';

export interface Mutation {
  name: string;
  file: string;
  anchor: string;
  replacement: string;
  expect: RegExp;
}

export const MUTATIONS: Mutation[] = [
  {
    name: 'a tile joining both runs is counted once, not in each run [E1-24]',
    file: 'score.ts',
    anchor: 'return h > 1 || v > 1 ? (h > 1 ? h : 0) + (v > 1 ? v : 0) : 1;',
    replacement: 'return h > 1 || v > 1 ? (h > 1 ? h : 0) + (v > 1 ? v : 0) - (h > 1 && v > 1 ? 1 : 0) : 1;',
    expect: /^(scores|record)/,
  },
  {
    name: "the round's score is not clamped at zero [E1-28]",
    file: 'round.ts',
    anchor: 's.scores[p] = Math.max(0, charged);',
    replacement: 's.scores[p] = charged;',
    expect: /^(scores|record)/,
  },
  {
    name: "a lid recycle keeps the lid's tiles in the lid as well [E1-33]",
    file: 'round.ts',
    anchor: '          lid[c] = 0;\n',
    replacement: '',
    expect: /^(lid|census)/,
  },
];

const scratch: string[] = [];

/** A scratch directory, removed by {@link cleanScratch}. */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** Removes every scratch directory made so far. Call from `afterAll`. */
export function cleanScratch(): void {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A mutated copy of the engine, imported from a scratch directory. */
export async function mutatedEngine(m: Mutation): Promise<Engine> {
  const dir = scratchDir('crosscheck-mutation-');
  cpSync(join(REPO, 'packages', 'engine', 'src'), dir, { recursive: true });
  const path = join(dir, m.file);
  const source = readFileSync(path, 'utf8');
  const hits = source.split(m.anchor).length - 1;
  // The anchor must match exactly once, or the mutation did not land.
  expect(hits, `anchor for "${m.name}" in ${m.file}`).toBe(1);
  writeFileSync(path, source.replace(m.anchor, m.replacement));
  return (await import(pathToFileURL(join(dir, 'index.ts')).href)) as Engine;
}

