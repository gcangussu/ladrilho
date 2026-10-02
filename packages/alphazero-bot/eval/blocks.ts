/**
 * The latency corpus ([Z11-38]) read back into states: its messages, and a
 * canonical block ([0010 C10-8]) as the `CanonicalState` it encodes, in
 * [0001 E1-62]'s field order — the inverse of `canonicalWords`. For the
 * master's lane and tests ([0012 T12-14], [T12-25]), which play the corpus
 * through the engine rather than through the crate.
 */

import { readFileSync } from 'node:fs';
import type { CanonicalState } from 'engine';
import { CORPUS } from './paths.js';

/** Every message of the corpus file, in order. */
export function corpusBlocks(path: string = CORPUS): Uint32Array[] {
  const b = readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Uint32Array[] = [];
  for (let at = 0; at < b.length; ) {
    const n = v.getUint32(at, true);
    const w = new Uint32Array(n);
    for (let i = 0; i < n; i++) w[i] = v.getUint32(at + 4 + 4 * i, true);
    out.push(w);
    at += 4 + 4 * n;
  }
  return out;
}

/** A block back to the state it encodes. Throws on words left over. */
export function parseBlock(w: Uint32Array): CanonicalState {
  let at = 0;
  const take = (n: number): number[] => Array.from(w.slice(at, (at += n)));
  const signed = (n: number): number[] => take(n).map((x) => x | 0);
  const factories = Array.from({ length: 5 }, () => take(5));
  const center = take(5);
  const markerInCenter = take(1)[0] === 1;
  const bag = take(take(1)[0]);
  const lid = take(5);
  const walls = [take(25), take(25)];
  const plColor = [signed(5), signed(5)];
  const plCount = [take(5), take(5)];
  const floor = [take(5), take(5)];
  const floorMarker = take(2).map((x) => x === 1);
  const scores = signed(2);
  const [currentPlayer, firstPlayer, roundIndex, tilesLeft, shufflesUsed, isTerminal, exhausted] = take(7);
  if (at !== w.length) throw new Error(`${w.length - at} words past the end of the block`);
  return {
    factories, center, markerInCenter, bag, lid, walls, plColor, plCount, floor, floorMarker, scores,
    currentPlayer, firstPlayer, roundIndex, tilesLeft, shufflesUsed,
    isTerminal: isTerminal === 1, exhausted: exhausted === 1,
  } as unknown as CanonicalState;
}
