/**
 * The universe draw, and the root it deals from [A8-22].
 *
 * The original guesses what a future round deals with a fixed pseudo-random
 * draw computed from the bag's counts. Because that draw depends on nothing
 * but the current counts, the whole sequence a bag will deal is fixed the
 * moment its counts are, and can be written down as an order. Our engine deals
 * by popping an order from the end ([0001 E1-32]), so handing it that order —
 * at the root, and again through the shuffle seam each time the lid is
 * recycled ([0001 E1-61]) — deals exactly what the original deals, with no
 * change to the engine.
 *
 * Its only inputs are counts [A8-7]: what both players can already see. It is
 * a guess, not a peek, and nothing else inside a search deals a tile.
 */

import {
  NUM_COLORS,
  fromCanonical,
  fromJSON,
  toCanonical,
  type AzulJSON,
  type AzulState,
  type Color,
  type Shuffle,
} from 'engine';
import { DRAW_MULTIPLIER, EXPERT } from './constants.js';

/**
 * One universe draw from `counts`, which it decrements.
 *
 * `t = (DRAW_MULTIPLIER · (universeSeed + Σ b[j] · 2^j)) mod Σ b`, and the
 * colour drawn is the least whose cumulative count exceeds `t` — numpy's
 * `searchsorted(cumsum(b), t, side='right')`. Every intermediate is an integer
 * below 2^38, so a double holds each one exactly.
 */
function draw(counts: number[], total: number): Color {
  let key = 0;
  let weight = 1; // 2^j, by doubling rather than `**` [A8-49]
  for (let j = 0; j < NUM_COLORS; j++) {
    key += counts[j] * weight;
    weight += weight;
  }
  const t = (DRAW_MULTIPLIER * (EXPERT.universeSeed + key)) % total;
  let cumulative = 0;
  let c = 0;
  for (; c < NUM_COLORS - 1; c++) {
    cumulative += counts[c];
    if (cumulative > t) break;
  }
  counts[c]--;
  return c as Color;
}

/**
 * The order in which successive universe draws would empty a bag holding
 * `counts`, laid out so that the engine — which draws from the end — draws it
 * in that order.
 */
export function universeOrder(counts: readonly number[]): Color[] {
  const remaining = counts.slice(0, NUM_COLORS);
  let total = 0;
  for (const n of remaining) total += n;
  const order: Color[] = new Array<Color>(total);
  // Filled from the back: the first draw is the last element, the one `pop`
  // takes first.
  for (let i = total - 1; i >= 0; i--) order[i] = draw(remaining, i + 1);
  return order;
}

/**
 * The shuffle seam of [0001 E1-61], reordering a recycled bag into the
 * universe order of its own counts.
 *
 * A pure function of the bag's contents, so sharing it by reference across
 * `clone` is sound, which is the property [0001 E1-48] asks of a seam.
 */
export const universeShuffle: Shuffle = (bag) => {
  const counts = [0, 0, 0, 0, 0];
  for (const c of bag) counts[c]++;
  const order = universeOrder(counts);
  for (let i = 0; i < order.length; i++) bag[i] = order[i];
};

/**
 * The root every simulation starts from [A8-22]: the position as `AzulJSON`
 * describes it, with the bag laid out in universe order and the lid recycled
 * through {@link universeShuffle}.
 *
 * Built by the engine's own constructors, so the engine alone decides what the
 * position means ([A8-6]).
 */
export function universeRoot(position: AzulJSON): AzulState {
  const canonical = toCanonical(fromJSON(position, 0));
  return fromCanonical({ ...canonical, bag: universeOrder(position.bag) }, 0, universeShuffle);
}
