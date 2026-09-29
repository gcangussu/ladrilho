/**
 * The ply record [C10-8], [C10-9] and its comparison [C10-11]: every field in
 * the layout is compared, and a difference in it is named by its own path
 * [C10-40].
 */

import * as engine from 'engine';
import { describe, expect, it } from 'vitest';
import { invent } from '../src/game.js';
import { type Field, compareRecords, decodeRecord } from '../src/record.js';

/** Records of real games: some mid-round, some ending a round, one ending the game. */
function sample(): Uint32Array[] {
  const out: Uint32Array[] = [];
  for (const [g, steer] of [[0, 'uniform'], [1, 'floor'], [2, 'biggest-pile']] as const) {
    const played = invent(engine, 4, g, { steer, start: { kind: 'new' }, cap: 400 });
    out.push(...played.records);
  }
  return out;
}

const RECORDS = sample();

/** A path with its indices removed: `record.players[0].floor.rungs` → `record.players[].floor.rungs`. */
const shape = (path: string): string => path.replace(/\[\d+\]/g, '[]');

/** The spec's field list, [C10-8] and [C10-9], written out here rather than read from the decoder. */
const SPEC_SHAPES = [
  'status',
  'factories[][]', 'center[]', 'markerInCenter', 'bag', 'lid[]', 'walls[][]', 'plColor[][]',
  'plCount[][]', 'floor[][]', 'floorMarker[]', 'scores[]',
  'currentPlayer', 'firstPlayer', 'roundIndex', 'tilesLeft', 'shufflesUsed', 'isTerminal', 'exhausted',
  'legal', 'probe', 'probeLegal', 'outcome', 'census[]',
  'inspect[].floorPenalty', 'inspect[].completedRows', 'inspect[].completedCols', 'inspect[].completedColors',
  'encoded[][]',
  'record', 'record.round',
  'record.players[].placements.length',
  ...['row', 'col', 'h', 'v', 'points'].map((k) => `record.players[].placements[].${k}`),
  'record.players[].tiling', 'record.players[].floor.occupied', 'record.players[].floor.rungs',
  'record.players[].floor.markerHeld', 'record.players[].floor.penalty',
  'record.players[].scoreBefore', 'record.players[].scoreAfterRound', 'record.players[].forgiven',
  'record.bonuses',
  ...['rows', 'cols', 'colors', 'rowPoints', 'colPoints', 'colorPoints', 'total', 'scoreBefore', 'scoreAfter'].map(
    (k) => `record.bonuses[].${k}`,
  ),
];

describe('the layout [C10-8], [C10-9]', () => {
  it('names exactly the fields the spec lists, and the sample reaches all of them', () => {
    const seen = new Set<string>();
    for (const r of RECORDS) for (const f of decodeRecord(r, 0).fields) seen.add(shape(f.path));
    expect([...seen].sort()).toEqual([...new Set(SPEC_SHAPES)].sort());
  });

  it('has the fixed widths of the table', () => {
    const r = RECORDS[5];
    const count = (prefix: string): number =>
      decodeRecord(r, 0).fields.filter((f) => shape(f.path) === prefix).length;
    expect(count('factories[][]')).toBe(25);
    expect(count('walls[][]')).toBe(50);
    expect(count('plColor[][]')).toBe(10);
    expect(count('encoded[][]')).toBe(364);
    expect(count('census[]')).toBe(5);
  });

  it('decodes each record exactly to its end', () => {
    for (const r of RECORDS) expect(decodeRecord(r, 0).end).toBe(r.length);
  });
});

/** A copy of `words` with `f` altered: an element of a list, or the word itself. */
function altered(words: Uint32Array, f: Field): Uint32Array | null {
  const copy = words.slice();
  if (Array.isArray(f.value)) {
    if (f.value.length === 0) return null;
    copy[f.at + 1] ^= 1;
  } else copy[f.at] = (copy[f.at] + 1) >>> 0;
  return copy;
}

describe('every field is compared [C10-40]', () => {
  it('names exactly the altered field, for every field of a set of records reaching them all', () => {
    // Every field needs one record that holds it — a round's record, the
    // bonuses, a non-empty bag and rung list — not every record of the sample.
    const chosen: Uint32Array[] = [];
    const reached = new Set<string>();
    for (const r of RECORDS) {
      const shapes = decodeRecord(r, 0).fields.map((f) => shape(f.path));
      if (shapes.some((s) => !reached.has(s))) {
        chosen.push(r);
        for (const s of shapes) reached.add(s);
      }
    }
    const covered = new Set<string>();
    const wrong: string[] = [];
    for (const r of chosen) {
      for (const f of decodeRecord(r, 0).fields) {
        const other = altered(r, f);
        if (other === null) continue;
        const diff = compareRecords(r, other);
        // [C10-11]: the first difference named is the altered field, by path.
        if (diff[0]?.path !== f.path) wrong.push(`${f.path} reported as ${diff[0]?.path ?? 'nothing'}`);
        covered.add(shape(f.path));
      }
    }
    expect(wrong).toEqual([]);
    expect([...covered].sort()).toEqual([...new Set(SPEC_SHAPES)].sort());
  });

  it('names every differing field at once, with both values [C10-11]', () => {
    const r = RECORDS[10];
    const fields = decodeRecord(r, 0).fields;
    const scores = fields.find((f) => f.path === 'scores[1]')!;
    const lid = fields.find((f) => f.path === 'lid[2]')!;
    const other = r.slice();
    other[scores.at] += 3;
    other[lid.at] += 1;
    const diff = compareRecords(r, other);
    expect(diff.map((d) => d.path)).toEqual(['lid[2]', 'scores[1]']);
    expect(diff[1]).toEqual({ path: 'scores[1]', typescript: scores.value, rust: (scores.value as number) + 3 });
  });

  it('stops at a length that differs rather than misaligning the rest [C10-11]', () => {
    const r = RECORDS[10];
    const bag = decodeRecord(r, 0).fields.find((f) => f.path === 'bag')!;
    const other = new Uint32Array([...r.slice(0, bag.at), (r[bag.at] + 1) >>> 0, 0, ...r.slice(bag.at + 1)]);
    const diff = compareRecords(r, other);
    expect(diff.map((d) => d.path)).toEqual(['bag']);
  });

  it('shows encoded floats as numbers and compares their bits', () => {
    const r = RECORDS[3];
    const f = decodeRecord(r, 0).fields.find((x) => x.path === 'encoded[0][120]')!;
    const was = new Float32Array(new Uint32Array([f.value as number]).buffer)[0];
    const other = r.slice();
    other[f.at] = new Uint32Array(new Float32Array([was + 0.5]).buffer)[0];
    const diff = compareRecords(r, other);
    expect(diff).toEqual([{ path: 'encoded[0][120]', typescript: was, rust: was + 0.5 }]);
  });
});
