/**
 * [0010 C10-8]'s canonical block, in [0001 E1-62]'s field order: the words
 * the web crate's `choose` decodes ([0012 T12-4]).
 *
 * A copy of `eval/chooser.ts`'s `canonicalWords`, not an import of it
 * ([T12-14]): that module starts processes through `node:worker_threads`, and
 * it is in the ladder hash ([0011 Z11-63]), so moving the function out would
 * restart every run's comparison for a change that plays no differently. The
 * suite holds the two equal over the whole latency corpus.
 */

import type { CanonicalState } from 'engine';

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
