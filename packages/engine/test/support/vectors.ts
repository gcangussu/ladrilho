/**
 * Loading and validating conformance vectors [0002 V2-37].
 *
 * A vector is a recording of the Python oracle playing Azul, produced by
 * `tools/vectors/dump_vectors.py` and committed as JSON — the suite reads
 * these files and never needs Python or a network [0002 V2-8].
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENCODED_SIZE, type CanonicalState, type Color } from '../../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The only directory `dump_vectors.py` is allowed to write [0002 V2-9]. */
export const VECTOR_DIR = join(HERE, '..', 'vectors');

/** The vector format this harness understands [0002 V2-37]. */
export const SCHEMA = 1;

export interface Provenance {
  repo: string;
  commit: string;
  script: string;
  /** Provenance only — never an input to a replay [0002 V2-2]. */
  pythonSeed: number;
  /** The move policy a game was generated with; games only, see [0002 V2-14]. */
  policy?: string;
  /** The oracle commit's date, never the clock [0002 V2-11]. Optional. */
  generatedAt?: string;
}

/**
 * The oracle's observation vector from both seats — `[seat 0, seat 1]`, each
 * `ENCODED_SIZE` long [0002 V2-38].
 *
 * The oracle computes these as float32; the generator widens each to the
 * double that represents it exactly and emits the shortest decimal that reads
 * back as that double, so a `Float32Array` element compares `===` against the
 * parsed number and no tolerance is needed.
 */
export type EncodedPair = number[][];

export interface Ply {
  action: number;
  /** Legal actions in the position *before* the ply, ascending [0002 V2-7]. */
  legal: number[];
  /** The complete canonical state after the ply [0002 V2-4]. */
  state: CanonicalState;
  /** The oracle's encoding of `state`; handcrafted positions only [0002 V2-38]. */
  encoded?: EncodedPair;
}

export interface Vector {
  schema: number;
  /** Load-bearing: the replay start differs by kind [0002 V2-36]. */
  kind: 'game' | 'position';
  generator: Provenance;
  /** Mandatory for handcrafted positions [0002 V2-17]. */
  note?: string;
  /** `"short"` when the fixture holds fewer than 100 tiles [0002 V2-35]. */
  census?: string;
  /** Bag contents after each shuffle; the last element is dealt first [0002 V2-6]. */
  shuffles: Color[][];
  initial: CanonicalState;
  /** The oracle's encoding of `initial`; handcrafted positions only [0002 V2-38]. */
  initialEncoded?: EncodedPair;
  plies: Ply[];
  final: { scores: number[]; outcome: number | null; exhausted: boolean };
  /** File basename, for test titles. Added by the loader, not by the file. */
  name: string;
}

const CANONICAL_KEYS = [
  'factories',
  'center',
  'markerInCenter',
  'bag',
  'lid',
  'walls',
  'plColor',
  'plCount',
  'floor',
  'floorMarker',
  'scores',
  'currentPlayer',
  'firstPlayer',
  'roundIndex',
  'tilesLeft',
  'shufflesUsed',
  'isTerminal',
  'exhausted',
] as const;

function requireCanonical(value: unknown, where: string): CanonicalState {
  if (value === null || typeof value !== 'object') throw new Error(`${where}: not an object`);
  const keys = Object.keys(value as object);
  if (keys.length !== CANONICAL_KEYS.length || keys.some((k, i) => k !== CANONICAL_KEYS[i])) {
    // Key order is part of the format, because it is what makes byte-identical
    // regeneration across two languages possible [0001 E1-62].
    throw new Error(`${where}: canonical keys are ${keys.join(',')}`);
  }
  return value as CanonicalState;
}

/**
 * One recorded pair of observation vectors [0002 V2-38]: two seats, each
 * `ENCODED_SIZE` finite numbers. A malformed pair is a generator bug and is
 * refused here rather than silently compared against nothing.
 */
function requireEncoded(value: unknown, where: string): EncodedPair {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${where}: encoded must hold both seats [V2-38]`);
  }
  for (const seat of value as unknown[]) {
    if (!Array.isArray(seat) || seat.length !== ENCODED_SIZE) {
      throw new Error(`${where}: each seat must hold ${ENCODED_SIZE} values [V2-38]`);
    }
    for (const x of seat as unknown[]) {
      if (typeof x !== 'number' || !Number.isFinite(x)) {
        throw new Error(`${where}: encoded holds a non-finite value [V2-38]`);
      }
    }
  }
  return value as EncodedPair;
}

/**
 * Parses one vector file, refusing anything this harness cannot faithfully
 * replay. A `schema` we do not know is rejected rather than guessed at, and a
 * vector missing `kind` is unreplayable rather than merely undocumented
 * [0002 V2-37].
 */
export function parseVector(name: string, text: string): Vector {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (raw['schema'] !== SCHEMA) {
    throw new Error(`${name}: unknown schema ${String(raw['schema'])}`);
  }
  const kind = raw['kind'];
  if (kind !== 'game' && kind !== 'position') {
    throw new Error(`${name}: kind must be "game" or "position", got ${String(kind)}`);
  }
  const generator = raw['generator'] as Provenance | undefined;
  if (!generator || typeof generator !== 'object') throw new Error(`${name}: no generator`);
  for (const field of ['repo', 'commit', 'script'] as const) {
    if (typeof generator[field] !== 'string') throw new Error(`${name}: generator.${field}`);
  }
  // [0002 V2-12] we have to know which oracle revision we agreed with.
  if (!/^[0-9a-f]{40}$/.test(generator.commit)) {
    throw new Error(`${name}: generator.commit is not a 40-hex revision`);
  }
  if (typeof generator.pythonSeed !== 'number') throw new Error(`${name}: generator.pythonSeed`);
  if (generator.generatedAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(generator.generatedAt)) {
    throw new Error(`${name}: generator.generatedAt is not a date`);
  }
  if (kind === 'position' && typeof raw['note'] !== 'string') {
    throw new Error(`${name}: a handcrafted position must carry a note [V2-17]`);
  }
  if (raw['census'] !== undefined && raw['census'] !== 'short') {
    throw new Error(`${name}: census may only be "short"`);
  }
  if (!Array.isArray(raw['shuffles'])) throw new Error(`${name}: no shuffles`);
  if (!Array.isArray(raw['plies']) || raw['plies'].length === 0) {
    throw new Error(`${name}: no plies`);
  }
  const final = raw['final'] as Vector['final'] | undefined;
  if (!final || !Array.isArray(final.scores) || typeof final.exhausted !== 'boolean') {
    throw new Error(`${name}: no final block`);
  }
  // [0002 V2-38] the recorded encodings are a position's, and only a position's:
  // games do not carry them, and a position missing them would compare nothing.
  const wantsEncoded = kind === 'position';
  if (!wantsEncoded && (raw['initialEncoded'] !== undefined || raw['plies'].some(
    (p) => (p as Record<string, unknown>)['encoded'] !== undefined,
  ))) {
    throw new Error(`${name}: encoded vectors are recorded for positions only [V2-38]`);
  }
  const plies = (raw['plies'] as Record<string, unknown>[]).map((p, i) => {
    if (typeof p['action'] !== 'number') throw new Error(`${name}: ply ${i} action`);
    if (!Array.isArray(p['legal'])) throw new Error(`${name}: ply ${i} legal`);
    const ply: Ply = {
      action: p['action'],
      legal: p['legal'] as number[],
      state: requireCanonical(p['state'], `${name}: ply ${i} state`),
    };
    if (wantsEncoded) ply.encoded = requireEncoded(p['encoded'], `${name}: ply ${i}`);
    return ply;
  });
  const vector: Vector = {
    schema: SCHEMA,
    kind,
    generator,
    shuffles: raw['shuffles'] as Color[][],
    initial: requireCanonical(raw['initial'], `${name}: initial`),
    plies,
    final,
    name,
  };
  if (wantsEncoded) {
    vector.initialEncoded = requireEncoded(raw['initialEncoded'], `${name}: initial`);
  }
  if (typeof raw['note'] === 'string') vector.note = raw['note'];
  if (typeof raw['census'] === 'string') vector.census = raw['census'];
  return vector;
}

let cache: Vector[] | null = null;

/** Every committed vector, in filename order. */
export function loadVectors(): Vector[] {
  if (cache === null) {
    const files = readdirSync(VECTOR_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    cache = files.map((f) => parseVector(f, readFileSync(join(VECTOR_DIR, f), 'utf8')));
  }
  return cache;
}

export function gameVectors(): Vector[] {
  return loadVectors().filter((v) => v.kind === 'game');
}

export function positionVectors(): Vector[] {
  return loadVectors().filter((v) => v.kind === 'position');
}

/**
 * Every state a handcrafted position fixture holds — its `initial` and each
 * `plies[i].state` — paired with the oracle's own encoding of it from both
 * seats [0002 V2-38].
 */
export function encodedStates(): {
  where: string;
  state: CanonicalState;
  encoded: EncodedPair;
}[] {
  const out: { where: string; state: CanonicalState; encoded: EncodedPair }[] = [];
  for (const v of positionVectors()) {
    out.push({ where: `${v.name} initial`, state: v.initial, encoded: v.initialEncoded! });
    v.plies.forEach((p, i) => {
      out.push({ where: `${v.name} ply ${i}`, state: p.state, encoded: p.encoded! });
    });
  }
  return out;
}
