/**
 * What the driver may touch [C10-3] and how it plays [C10-10], read from its
 * own sources and from a played game.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as engine from 'engine';
import { describe, expect, it } from 'vitest';
import { invent } from '../src/game.js';
import { describe as decode } from '../src/record.js';
import { PACKAGE } from './support/harness.js';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|mjs)$/.test(f) ? [path] : [];
  });
}

describe('neither engine is reached but through its public surface [C10-3]', () => {
  const sources = [...files(join(PACKAGE, 'src')), ...files(join(PACKAGE, 'test')), ...files(join(PACKAGE, 'tools'))];

  it('imports the TypeScript engine by its package root only', () => {
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/g)) {
        const target = m[1] ?? m[2];
        expect(target, relative(PACKAGE, file)).not.toMatch(/^engine\/|(^|\/)packages\/engine|\.\.\/engine\b/);
      }
    }
  });

  it('reaches the engine sources on disk in one place: the mutated copy of [C10-38]', () => {
    const touching = sources
      .filter((file) => /['"]packages['"],\s*['"]engine['"],\s*['"]src['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(PACKAGE, file));
    expect(touching).toEqual(['test/support/mutations.ts']);
  });

  it('never writes under either engine', () => {
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      if (!/writeFileSync|cpSync|rmSync/.test(text)) continue;
      expect(text, relative(PACKAGE, file)).not.toMatch(/(writeFileSync|rmSync)\([^)]*(VECTOR_DIR|engine-rs)/);
    }
  });
});

describe('how a game is played [C10-10]', () => {
  it('plays every ply through applyExplained and never apply', () => {
    const game = readFileSync(join(PACKAGE, 'src', 'game.ts'), 'utf8');
    expect(game).toMatch(/engine\.applyExplained\(/);
    expect(game).not.toMatch(/engine\.apply\(/);
  });

  it('probes one action per record, in 0..=255, never a legal one', () => {
    const played = invent(engine, 8, 0, { steer: 'mix', start: { kind: 'new' }, cap: 400 });
    expect(played.input.probes).toHaveLength(played.records.length);
    played.records.forEach((r, i) => {
      const d = decode(r);
      expect(d.probe).toBe(played.input.probes[i]);
      expect(d.probe).toBeGreaterThanOrEqual(0);
      expect(d.probe).toBeLessThanOrEqual(255);
      expect(d.legal as number[]).not.toContain(d.probe);
      expect(d.probeLegal).toBe(0);
    });
  });

  it('compares a round’s record on every ply that ends a round', () => {
    const played = invent(engine, 8, 1, { steer: 'uniform', start: { kind: 'new' }, cap: 400 });
    const rounds = played.records.map(decode).filter((d) => d.record === 1);
    const last = decode(played.records[played.records.length - 1]);
    expect(rounds.length).toBe((last.roundIndex as number) + 1);
    expect(rounds.at(-1)!['record.bonuses']).toBe(1);
  });
});
