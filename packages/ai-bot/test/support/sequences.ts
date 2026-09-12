/**
 * The recorded searches [A8-34], loaded: one sequence per seat per game, each
 * call's root visit counts, and every node its search evaluated.
 *
 * A node is stored as the board the original held, the actions it called
 * legal, the raw policy its network returned, the normalised prior the search
 * stored, and the value. [A8-38] feeds those back to our search in place of a
 * network; [A8-53] checks our normalisation against the recorded pair.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AzulJSON } from 'engine';
import { boardKey } from '../../src/search.js';
import { fixtures, manifest } from './fixtures.js';

const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** The conditions that cut a sequence: the tree carries them into every later call. */
export const CUTTING = ['floor-overflow', 'no-centre-take', 'score-wrap'];

export interface RecordedCall {
  /** Index into the counts files, across every sequence. */
  index: number;
  ply: number;
  /** The reference search's first-index maximum, by their action. */
  chosen: number;
  /** The as-shipped search's, which [A8-39] measures against. */
  shippedChosen: number;
  qs: number;
  qsType: string;
  deviations: string[];
  nodesAdded: number;
  /** The position our recorded game held at this ply. */
  position: AzulJSON;
  /** Root visit counts by their action, reference and as-shipped. */
  reference: Uint16Array;
  shipped: Uint16Array;
}

export interface RecordedNode {
  board: Int8Array;
  legal: number[];
  /** Full 180, zero where illegal: what the network returned. */
  raw: Float32Array;
  /** Full 180, as the search stored it after normalising. */
  normalised: Float32Array;
  value: Float32Array;
}

export interface Sequence {
  game: string;
  seat: number;
  /** `network` is the checkpoint; `uniform` is the stub that makes exact ties. */
  kind: string;
  /**
   * The first call whose counts moved when `Qs` was held in float64, or
   * `null` when holding it in float64 changed nothing anywhere [A8-50].
   */
  witness: number | null;
  calls: RecordedCall[];
  nodes: RecordedNode[];
  /** Board key to node, which is the lookup [A8-38] replaces the network with. */
  lookup: Map<string, RecordedNode>;
  /** Calls before the first cutting deviation. */
  compared: number;
}

export function sequences(): Sequence[] {
  const data = manifest();
  const positions = fixtures();
  const boards = readFileSync(join(DIRECTORY, 'seq-boards.i8'));
  const legal = readFileSync(join(DIRECTORY, 'seq-legal.u8'));
  const raw = readFileSync(join(DIRECTORY, 'seq-raw.f32'));
  const normalised = readFileSync(join(DIRECTORY, 'seq-normalised.f32'));
  const values = readFileSync(join(DIRECTORY, 'seq-values.f32'));
  const reference = readFileSync(join(DIRECTORY, 'seq-counts-reference.u16'));
  const shipped = readFileSync(join(DIRECTORY, 'seq-counts-shipped.u16'));

  // The variable-length arrays are walked once: each node starts with how many
  // legal actions it has, and its two policy arrays are that long.
  const nodes: RecordedNode[] = [];
  let cursor = 0;
  let floats = 0;
  for (let i = 0; legal.length > cursor; i++) {
    const count = legal[cursor];
    const indices = [...legal.subarray(cursor + 1, cursor + 1 + count)];
    cursor += 1 + count;
    const rawFull = new Float32Array(180);
    const normalisedFull = new Float32Array(180);
    for (let k = 0; k < count; k++) {
      rawFull[indices[k]] = raw.readFloatLE((floats + k) * 4);
      normalisedFull[indices[k]] = normalised.readFloatLE((floats + k) * 4);
    }
    floats += count;
    nodes.push({
      board: new Int8Array(boards.buffer, boards.byteOffset + i * 138, 138),
      legal: indices,
      raw: rawFull,
      normalised: normalisedFull,
      value: new Float32Array([values.readFloatLE(i * 8), values.readFloatLE(i * 8 + 4)]),
    });
  }

  return data.sequences.map((sequence) => {
    const own = nodes.slice(sequence.nodesFrom, sequence.nodesTo);
    const lookup = new Map<string, RecordedNode>();
    for (const node of own) lookup.set(boardKey(node.board), node);
    const calls: RecordedCall[] = sequence.calls.map((call) => {
      const position = positions.find((p) => p.game === sequence.game && p.ply === call.ply);
      if (position === undefined) {
        throw new Error(`${sequence.game} ply ${call.ply} is recorded as a call but not a position`);
      }
      const at = call.index * 360;
      return {
        ...call,
        position: position.position,
        reference: new Uint16Array(reference.buffer.slice(reference.byteOffset + at, reference.byteOffset + at + 360)),
        shipped: new Uint16Array(shipped.buffer.slice(shipped.byteOffset + at, shipped.byteOffset + at + 360)),
      };
    });
    const cut = calls.findIndex((call) => call.deviations.some((name) => CUTTING.includes(name)));
    return {
      game: sequence.game,
      seat: sequence.seat,
      kind: sequence.kind,
      witness: sequence.witness,
      calls,
      nodes: own,
      lookup,
      compared: cut < 0 ? calls.length : cut,
    };
  });
}
