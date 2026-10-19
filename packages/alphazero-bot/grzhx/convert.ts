/**
 * Our position as their engine takes it ([G13-14], [G13-15]).
 *
 * Their encoding is ours: an action is `(source·5 + colour)·6 + destination`
 * on both sides, with the centre as source 5 and the floor as destination 5,
 * and colour `c` sits in wall column `(row + c) mod 5` on both. So action ids
 * and colour indices cross unchanged, and only the shape of a position
 * changes here.
 *
 * Everything is read from `toJSON`'s view, whose bag is counts: nothing here
 * can see the bag's order or the shuffler.
 */

import { NUM_COLORS, type AzulJSON } from 'engine';

/** Their `empty` pattern colour (`engine.hpp`). */
export const THEIR_EMPTY = 5;
/** A floor's places, which their `floor_count` never exceeds (`validate`). */
export const FLOOR_PLACES = 7;
/** `azul_batch_manual_deal`'s tile for a place a short deal leaves empty. */
export const NO_TILE = 255;

/** The arguments of their `Batch.import_public`, by its keyword names. */
export interface ImportArgs {
  sources: number[][];
  walls: number[];
  scores: number[];
  pattern_colors: number[][];
  pattern_counts: number[][];
  floor_tiles: number[][];
  floor_counts: number[];
  bag: number[];
  discard: number[];
  round: number;
  current: number;
  next_start: number;
  token_available: number;
}

/** A wall's 5×5 cells as their bitboard: bit `row·5 + column`. */
function bitboard(wall: number[][]): number {
  let bits = 0;
  wall.forEach((row, r) => row.forEach((cell, c) => {
    if (cell) bits |= 1 << (r * 5 + c);
  }));
  return bits >>> 0;
}

/**
 * [G13-15]: their `import_public` arguments for our position. Their round
 * counts from 1 (their deal increments it from 0); their floor count includes
 * the marker; the next round's first player is the marker's holder, or this
 * round's first player while the marker is still in the centre.
 */
export function importArgs(j: AzulJSON): ImportArgs {
  const holder = j.players.findIndex((p) => p.floorMarker);
  return {
    sources: [...j.factories.map((f) => f.slice()), j.center.slice()],
    walls: j.players.map((p) => bitboard(p.wall)),
    scores: j.scores.slice(),
    pattern_colors: j.players.map((p) => p.patternLines.map((l) => (l.count === 0 ? THEIR_EMPTY : l.color))),
    pattern_counts: j.players.map((p) => p.patternLines.map((l) => l.count)),
    floor_tiles: j.players.map((p) => p.floor.slice()),
    // Their floor has seven places and counts the marker in them; ours lets the
    // marker land on a floor already holding seven tiles. Their engine then
    // stops counting at seven, as here; both charge the same penalty.
    floor_counts: j.players.map((p) => Math.min(FLOOR_PLACES, p.floor.reduce((a, b) => a + b, 0) + (p.floorMarker ? 1 : 0))),
    bag: j.bag.slice(),
    discard: j.lid.slice(),
    round: j.round + 1,
    current: j.currentPlayer,
    next_start: holder >= 0 ? holder : j.firstPlayer,
    token_available: j.markerInCenter ? 1 : 0,
  };
}

/**
 * [G13-14]: the twenty tiles of a deal, factory-major, as their
 * `manual_deal` draws them. `bagBefore` is our bag's colour counts before the
 * deal; `factories` the colour counts it dealt. Their deal checks each tile
 * against the bag in turn and refills from the lid only when the bag is
 * empty, as ours does, so within the factory being filled when the bag ran
 * out, the tiles drawn before the refill — what was left of the old bag —
 * must come first.
 */
export function dealTiles(bagBefore: readonly number[], factories: readonly (readonly number[])[]): number[] {
  const old = bagBefore.slice();
  let oldLeft = old.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  for (const f of factories) {
    const counts = f.slice();
    const size = counts.reduce((a, b) => a + b, 0);
    const tiles: number[] = [];
    // The factory's first min(size, oldLeft) tiles came from the old bag.
    const fromOld = Math.min(size, oldLeft);
    if (fromOld > 0 && fromOld < size) {
      // The refilling factory: its old-bag tiles are exactly what the old bag still held.
      for (let c = 0; c < NUM_COLORS; c++) {
        if (old[c] > counts[c]) throw new Error(`the deal does not follow from the bag: colour ${c} short in the refilling factory`);
        for (let n = 0; n < old[c]; n++) tiles.push(c);
        counts[c] -= old[c];
        old[c] = 0;
      }
      oldLeft = 0;
    } else if (fromOld === size) {
      for (let c = 0; c < NUM_COLORS; c++) {
        if (counts[c] > old[c]) throw new Error(`the deal does not follow from the bag: colour ${c} drawn past the bag`);
        old[c] -= counts[c];
      }
      oldLeft -= size;
    }
    for (let c = 0; c < NUM_COLORS; c++) for (let n = 0; n < counts[c]; n++) tiles.push(c);
    while (tiles.length < 4) tiles.push(NO_TILE);
    out.push(...tiles);
  }
  return out;
}
