/**
 * The chooser adapter ([Z11-31]): the trained player as the arena sees it.
 *
 * One `alphazero play` per move, handed `toCanonical(fromJSON(position, 0))`
 * and nothing else — `toJSON`'s bag is counts, so the order the harness holds
 * never reaches the process, and seed 0 is a shuffler nothing below the round
 * boundary ever calls ([Z11-15]). The process holds no state between moves
 * ([Z11-23]), so a game's result does not depend on which process played it.
 *
 * This file is in the ladder hash ([Z11-63]): it decides how the player plays
 * in every milestone and gate.
 */

import { fromJSON, toCanonical, type AzulJSON, type CanonicalState } from 'engine';
import type { Chooser } from 'bot/arena';
import { alphazero } from './crate.js';

/** [0010 C10-8]'s canonical block, in [0001 E1-62]'s field order. */
export function canonicalWords(c: CanonicalState): number[] {
  const b = (x: boolean): number => (x ? 1 : 0);
  const out: number[] = [];
  for (const f of c.factories) out.push(...f);
  out.push(...c.center, b(c.markerInCenter), c.bag.length, ...c.bag, ...c.lid);
  for (const w of c.walls) out.push(...w);
  for (const p of c.plColor) out.push(...p);
  for (const p of c.plCount) out.push(...p);
  for (const p of c.floor) out.push(...p);
  out.push(b(c.floorMarker[0]), b(c.floorMarker[1]), c.scores[0], c.scores[1]);
  out.push(c.currentPlayer, c.firstPlayer, c.roundIndex, c.tilesLeft, c.shufflesUsed);
  out.push(b(c.isTerminal), b(c.exhausted));
  return out;
}

/** [0010 C10-12]'s framing: the word count, then the words, little-endian. */
export function frame(words: readonly number[]): Uint8Array {
  const out = new DataView(new ArrayBuffer(4 * (words.length + 1)));
  out.setUint32(0, words.length, true);
  words.forEach((w, i) => out.setUint32(4 * (i + 1), w >>> 0, true));
  return new Uint8Array(out.buffer);
}

/** What `play` answers ([Z11-23]). */
export interface Answer {
  action: number;
  simulations: number;
  value: number;
  milliseconds: number;
}

export function readAnswer(bytes: Uint8Array): Answer {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength !== 20 || v.getUint32(0, true) !== 4) {
    throw new Error(`play answered ${bytes.byteLength} bytes, not four words`);
  }
  return {
    action: v.getUint32(4, true),
    simulations: v.getUint32(8, true),
    value: v.getFloat32(12, true),
    milliseconds: v.getUint32(16, true),
  };
}

export interface PlayerSpec {
  binary: string;
  checkpoint: string;
  /** The config file the crate reads its settings from ([Z11-60]). */
  config: string;
  search: 'play' | 'milestone';
}

/**
 * The player as a chooser. Its work is `nodes = simulations`, `depth = 0`,
 * neither complete nor curtailed: the search is not depth-bounded and has no
 * clock to be curtailed by ([Z11-18]). Every move's simulation count is
 * handed to `onMove`, which is how a milestone records them ([Z11-34]).
 */
export function alphazeroChooser(spec: PlayerSpec, onMove?: (a: Answer) => void): Chooser {
  return (position: AzulJSON) => {
    const words = canonicalWords(toCanonical(fromJSON(position, 0)));
    const answer = readAnswer(
      alphazero(spec.binary, ['play', spec.checkpoint, '--config', spec.config, '--search', spec.search], frame(words)),
    );
    onMove?.(answer);
    return { action: answer.action, nodes: answer.simulations, depth: 0, complete: false, curtailed: false };
  };
}
