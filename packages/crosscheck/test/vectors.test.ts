/**
 * [C10-37]: every committed vector, driven through the tool as game input,
 * agrees across the engines — and the TypeScript side's decoded records equal
 * what the vector recorded. The vectors are the oracle's opinion of every
 * field, so this is what shows the record reads the fields it claims to.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as engine from 'engine';
import type { CanonicalState } from 'engine';
import { afterAll, describe, expect, it } from 'vitest';
import { Checker } from '../src/checker.js';
import { type GameInput, replay } from '../src/game.js';
import { describe as decode } from '../src/record.js';
import { VECTOR_DIR, firstDisagreement } from '../src/run.js';
import { CHECKER } from './support/harness.js';

interface Vector {
  kind: 'game' | 'position';
  shuffles: number[][];
  initial: CanonicalState;
  initialEncoded?: number[][];
  plies: { action: number; legal: number[]; state: CanonicalState; encoded?: number[][] }[];
}

const FILES = readdirSync(VECTOR_DIR).filter((f) => f.endsWith('.json')).sort();

type Decoded = Record<string, number | number[]>;

/** Rebuilds a canonical state from a decoded record's fields. */
function canonical(d: Decoded): CanonicalState {
  const grid = (name: string, rows: number, cols: number): number[][] =>
    Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => d[`${name}[${r}][${c}]`] as number));
  const row = (name: string, n: number): number[] => Array.from({ length: n }, (_, i) => d[`${name}[${i}]`] as number);
  return {
    factories: grid('factories', 5, 5),
    center: row('center', 5),
    markerInCenter: d.markerInCenter === 1,
    bag: d.bag as CanonicalState['bag'],
    lid: row('lid', 5),
    walls: grid('walls', 2, 25),
    plColor: grid('plColor', 2, 5),
    plCount: grid('plCount', 2, 5),
    floor: grid('floor', 2, 5),
    floorMarker: row('floorMarker', 2).map((x) => x === 1),
    scores: row('scores', 2),
    currentPlayer: d.currentPlayer as 0 | 1,
    firstPlayer: d.firstPlayer as 0 | 1,
    roundIndex: d.roundIndex as number,
    tilesLeft: d.tilesLeft as number,
    shufflesUsed: d.shufflesUsed as number,
    isTerminal: d.isTerminal === 1,
    exhausted: d.exhausted === 1,
  };
}

const encoded = (d: Decoded): number[][] => [0, 1].map((p) => Array.from({ length: 182 }, (_, i) => d[`encoded[${p}][${i}]`] as number));

const checker = new Checker(CHECKER);
afterAll(() => checker.close());

describe('the committed vectors through the tool [C10-37]', () => {
  it('finds the vectors', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(37);
  });

  for (const file of FILES) {
    it(file, async () => {
      const v = JSON.parse(readFileSync(join(VECTOR_DIR, file), 'utf8')) as Vector;
      const input: GameInput = {
        start: v.kind === 'game' ? null : v.initial,
        shuffles: v.shuffles,
        actions: v.plies.map((p) => p.action),
        probes: new Array(v.plies.length + 1).fill(255),
      };
      const ts = replay(engine, input);
      const rust = await checker.replay(0, input);
      expect(firstDisagreement(ts, rust)).toBeNull();

      expect(ts).toHaveLength(v.plies.length + 1);
      const records = ts.map(decode);
      expect(canonical(records[0])).toEqual(v.initial);
      v.plies.forEach((ply, i) => {
        expect(records[i].legal, `legal before ply ${i}`).toEqual(ply.legal);
        expect(canonical(records[i + 1]), `state after ply ${i}`).toEqual(ply.state);
      });
      if (v.initialEncoded !== undefined) expect(encoded(records[0])).toEqual(v.initialEncoded);
      v.plies.forEach((ply, i) => {
        if (ply.encoded !== undefined) expect(encoded(records[i + 1]), `encoded after ply ${i}`).toEqual(ply.encoded);
      });
    });
  }
});
