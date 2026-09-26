/**
 * The ply record [C10-8], [C10-9]: what one engine says about one position, as
 * a sequence of 32-bit words, and the comparison of two of them [C10-11].
 *
 * The layout is the comparison. A field not written here is not compared, and
 * the decoder is the one place that knows the layout's names, so a
 * disagreement is always reported by path rather than by word offset.
 */

import type { AzulState, CanonicalState, Player, RoundScoring } from 'engine';
import type { Engine } from './engine.js';

export const DESCRIBED = 0;
export const REJECTED = 1;
export const START_REJECTED = 2;
export const SEAM_MISUSED = 3;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function bits(x: number): number {
  f32[0] = x;
  return u32[0];
}

function float(word: number): number {
  u32[0] = word;
  return f32[0];
}

const b = (x: boolean): number => (x ? 1 : 0);

/** The canonical block, in [0001 E1-62]'s field order. */
export function pushCanonical(out: number[], c: CanonicalState): void {
  for (const f of c.factories) out.push(...f);
  out.push(...c.center, b(c.markerInCenter), c.bag.length, ...c.bag, ...c.lid);
  for (const w of c.walls) out.push(...w);
  for (const p of c.plColor) out.push(...p);
  for (const p of c.plCount) out.push(...p);
  for (const p of c.floor) out.push(...p);
  out.push(b(c.floorMarker[0]), b(c.floorMarker[1]), c.scores[0], c.scores[1]);
  out.push(c.currentPlayer, c.firstPlayer, c.roundIndex, c.tilesLeft, c.shufflesUsed);
  out.push(b(c.isTerminal), b(c.exhausted));
}

function pushScoring(out: number[], r: RoundScoring | null): void {
  if (r === null) {
    out.push(0);
    return;
  }
  out.push(1, r.round);
  for (const p of r.players) {
    out.push(p.placements.length);
    for (const x of p.placements) out.push(x.row, x.col, x.h, x.v, x.points);
    out.push(p.tiling, p.floor.occupied, p.floor.rungs.length, ...p.floor.rungs);
    out.push(b(p.floor.markerHeld), p.floor.penalty, p.scoreBefore, p.scoreAfterRound, p.forgiven);
  }
  if (r.bonuses === null) {
    out.push(0);
    return;
  }
  out.push(1);
  for (const p of r.bonuses) {
    out.push(p.rows, p.cols, p.colors, p.rowPoints, p.colPoints, p.colorPoints, p.total);
    out.push(p.scoreBefore, p.scoreAfter);
  }
}

/** Appends one ply record describing `s` as it stands [C10-8]. */
export function pushRecord(
  out: number[],
  engine: Engine,
  s: AzulState,
  status: number,
  probe: number,
  scoring: RoundScoring | null,
): void {
  out.push(status);
  pushCanonical(out, engine.toCanonical(s));
  const legal = engine.legalActions(s);
  out.push(legal.length, ...legal);
  out.push(probe, b(engine.isLegal(s, probe)));
  const o = engine.outcome(s);
  out.push(o === null ? 2 : o);
  out.push(...engine.tileCensus(s));
  for (const p of [0, 1] as Player[]) {
    out.push(engine.floorPenalty(s, p), engine.completedRows(s, p));
    out.push(engine.completedCols(s, p), engine.completedColors(s, p));
  }
  for (const p of [0, 1] as Player[]) {
    for (const x of engine.encodeFor(s, p)) out.push(bits(x));
  }
  pushScoring(out, scoring);
}

/** The record of a start the engine refused: its status and nothing else. */
export function pushRejectedStart(out: number[]): void {
  out.push(START_REJECTED);
}

/** Words as the wire carries them: unsigned, two's complement for negatives. */
export function toWords(values: readonly number[]): Uint32Array {
  const w = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) w[i] = values[i] >>> 0;
  return w;
}

// ---------------------------------------------------------------------------
// Decoding

/**
 * One named field of a decoded record. Fixed-size arrays are one field per
 * element (`scores[1]`); variable-length lists of plain numbers are one field
 * holding the whole list (`bag`), so a length difference is that field
 * differing. `float` marks the `f32` fields, compared by bits and shown as
 * numbers.
 */
export interface Field {
  path: string;
  value: number | number[];
  /** The word the field starts at; for a list, its length word. */
  at: number;
  float?: true;
}

class Reader {
  at: number;
  readonly fields: Field[] = [];

  constructor(
    private readonly words: Uint32Array,
    start: number,
  ) {
    this.at = start;
  }

  raw(): number {
    if (this.at >= this.words.length) throw new RangeError('record ends early');
    return this.words[this.at++];
  }

  int(path: string): number {
    const at = this.at;
    const v = this.raw() | 0;
    this.fields.push({ path, value: v, at });
    return v;
  }

  ints(path: string, n: number): void {
    for (let i = 0; i < n; i++) this.int(`${path}[${i}]`);
  }

  list(path: string): number {
    const at = this.at;
    const n = this.raw();
    const value: number[] = [];
    for (let i = 0; i < n; i++) value.push(this.raw() | 0);
    this.fields.push({ path, value, at });
    return n;
  }

  floats(path: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const at = this.at;
      this.fields.push({ path: `${path}[${i}]`, value: this.raw(), at, float: true });
    }
  }
}

const SCALARS = [
  'currentPlayer',
  'firstPlayer',
  'roundIndex',
  'tilesLeft',
  'shufflesUsed',
  'isTerminal',
  'exhausted',
] as const;

function readCanonical(r: Reader): void {
  for (let f = 0; f < 5; f++) r.ints(`factories[${f}]`, 5);
  r.ints('center', 5);
  r.int('markerInCenter');
  r.list('bag');
  r.ints('lid', 5);
  for (let p = 0; p < 2; p++) r.ints(`walls[${p}]`, 25);
  for (let p = 0; p < 2; p++) r.ints(`plColor[${p}]`, 5);
  for (let p = 0; p < 2; p++) r.ints(`plCount[${p}]`, 5);
  for (let p = 0; p < 2; p++) r.ints(`floor[${p}]`, 5);
  r.ints('floorMarker', 2);
  r.ints('scores', 2);
  for (const name of SCALARS) r.int(name);
}

function readScoring(r: Reader): void {
  if (r.int('record') === 0) return;
  r.int('record.round');
  for (let p = 0; p < 2; p++) {
    const at = `record.players[${p}]`;
    const n = r.int(`${at}.placements.length`);
    for (let i = 0; i < n; i++) {
      for (const k of ['row', 'col', 'h', 'v', 'points']) r.int(`${at}.placements[${i}].${k}`);
    }
    r.int(`${at}.tiling`);
    r.int(`${at}.floor.occupied`);
    r.list(`${at}.floor.rungs`);
    for (const k of ['floor.markerHeld', 'floor.penalty', 'scoreBefore', 'scoreAfterRound', 'forgiven']) {
      r.int(`${at}.${k}`);
    }
  }
  if (r.int('record.bonuses') === 0) return;
  for (let p = 0; p < 2; p++) {
    const at = `record.bonuses[${p}]`;
    for (const k of ['rows', 'cols', 'colors', 'rowPoints', 'colPoints', 'colorPoints', 'total', 'scoreBefore', 'scoreAfter']) {
      r.int(`${at}.${k}`);
    }
  }
}

/**
 * Decodes one record starting at `start`: its named fields in layout order,
 * and where the next record begins. A record that ends early decodes as far as
 * it goes, with `end` at the end of the words.
 */
export function decodeRecord(words: Uint32Array, start: number): { fields: Field[]; end: number } {
  const r = new Reader(words, start);
  try {
    if (r.int('status') === START_REJECTED) return { fields: r.fields, end: r.at };
    readCanonical(r);
    r.list('legal');
    r.int('probe');
    r.int('probeLegal');
    r.int('outcome');
    r.ints('census', 5);
    for (let p = 0; p < 2; p++) {
      for (const k of ['floorPenalty', 'completedRows', 'completedCols', 'completedColors']) {
        r.int(`inspect[${p}].${k}`);
      }
    }
    for (let p = 0; p < 2; p++) r.floats(`encoded[${p}]`, 182);
    readScoring(r);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    return { fields: r.fields, end: words.length };
  }
  return { fields: r.fields, end: r.at };
}

/** Splits a concatenation of records into one word array per record. */
export function splitRecords(words: Uint32Array, count: number): Uint32Array[] {
  const out: Uint32Array[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const { end } = decodeRecord(words, at);
    out.push(words.subarray(at, end));
    at = end;
  }
  return out;
}

/** A field's value as a report shows it: `f32` bits as the number they hold. */
function shown(f: Field): number | number[] {
  return f.float ? float(f.value as number) : f.value;
}

/** A decoded record as a report shows it: path to value, in layout order. */
export function describe(record: Uint32Array): Record<string, number | number[]> {
  const out: Record<string, number | number[]> = {};
  for (const f of decodeRecord(record, 0).fields) out[f.path] = shown(f);
  return out;
}

export interface Difference {
  path: string;
  typescript: number | number[] | null;
  rust: number | number[] | null;
}

function same(a: Field, b: Field): boolean {
  if (typeof a.value === 'number' || typeof b.value === 'number') return a.value === b.value;
  return a.value.length === b.value.length && a.value.every((x, i) => x === (b.value as number[])[i]);
}

/**
 * Every field in which two records differ [C10-11]. Where the two stop having
 * the same shape — a list or a count of different lengths, a record present on
 * one side only, one side ending early — that field is the last one reported:
 * past it the layouts no longer line up, and naming what follows would be
 * naming noise.
 */
export function compareRecords(ts: Uint32Array, rust: Uint32Array): Difference[] {
  const a = decodeRecord(ts, 0).fields;
  const b = decodeRecord(rust, 0).fields;
  const out: Difference[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined || x.path !== y.path) {
      out.push({
        path: (x ?? y).path,
        typescript: x === undefined ? null : shown(x),
        rust: y === undefined ? null : shown(y),
      });
      break;
    }
    if (same(x, y)) continue;
    out.push({ path: x.path, typescript: shown(x), rust: shown(y) });
    const shapeChanged =
      (Array.isArray(x.value) && Array.isArray(y.value) && x.value.length !== y.value.length) ||
      /(^status$|^record$|\.length$|^record\.bonuses$)/.test(x.path);
    if (shapeChanged) break;
  }
  if (out.length === 0 && ts.length !== rust.length) {
    out.push({ path: '(record length)', typescript: ts.length, rust: rust.length });
  }
  return out;
}

export function equalWords(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
