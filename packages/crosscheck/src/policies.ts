/**
 * The move policies of [C10-17]. Each prefers some takes and falls back to a
 * uniform choice where it has no preference ([0002 V2-14]), and each is named
 * as the vector generator names its own where both have one.
 */

import type { AzulState } from 'engine';
import type { Engine } from './engine.js';
import type { Stream } from './rng.js';

export type Policy = (engine: Engine, s: AzulState, legal: readonly number[], rng: Stream) => number;

/** Uniform among the preferred actions, or among all of them if none is. */
function prefer(
  legal: readonly number[],
  rng: Stream,
  wanted: (action: number) => boolean,
): number {
  const chosen = legal.filter(wanted);
  return rng.pick(chosen.length > 0 ? chosen : legal);
}

const uniform: Policy = (_e, _s, legal, rng) => rng.pick(legal);

const biggestPile: Policy = (engine, s, legal, rng) => {
  const size = (a: number): number => {
    const [src, color] = engine.decodeAction(a);
    return (src === engine.CENTER ? s.center : s.factories[src])[color];
  };
  const most = Math.max(...legal.map(size));
  return prefer(legal, rng, (a) => size(a) === most);
};

const centreFirst: Policy = (engine, _s, legal, rng) =>
  prefer(legal, rng, (a) => engine.decodeAction(a)[0] === engine.CENTER);

/** A take from the centre while the marker is there takes the marker too. */
const avoidMarker: Policy = (engine, s, legal, rng) =>
  prefer(legal, rng, (a) => !(s.markerInCenter && engine.decodeAction(a)[0] === engine.CENTER));

const preferLines: Policy = (engine, _s, legal, rng) =>
  prefer(legal, rng, (a) => engine.decodeAction(a)[2] !== engine.FLOOR);

/**
 * Everything to the floor, as fast as possible, and the marker only onto a
 * floor already holding seven: the one route to an eighth slot
 * ([0002 V2-16], [0001 E1-27]). Filling fast is the point — a floor filled one
 * tile at a time is still short of seven when the factories run out and the
 * last centre take forces the marker onto it.
 */
const floor: Policy = (engine, s, legal, rng) => {
  const toFloor = legal.filter((a) => engine.decodeAction(a)[2] === engine.FLOOR);
  if (toFloor.length === 0) return rng.pick(legal);
  const full = engine.floorOccupied(s, s.currentPlayer) >= 7;
  const takesMarker = (a: number): boolean => s.markerInCenter && engine.decodeAction(a)[0] === engine.CENTER;
  const wanted = toFloor.filter((a) => takesMarker(a) === full);
  if (wanted.length === 0 || full) return rng.pick(wanted.length > 0 ? wanted : toFloor);
  const size = (a: number): number => {
    const [src, color] = engine.decodeAction(a);
    return (src === engine.CENTER ? s.center : s.factories[src])[color];
  };
  const most = Math.max(...wanted.map(size));
  return prefer(wanted, rng, (a) => size(a) === most);
};

const SINGLE: Record<string, Policy> = {
  uniform,
  'biggest-pile': biggestPile,
  'centre-first': centreFirst,
  'avoid-marker': avoidMarker,
  'prefer-lines': preferLines,
  floor,
};

const perPly: Policy = (engine, s, legal, rng) =>
  SINGLE[rng.pick(Object.keys(SINGLE))](engine, s, legal, rng);

export const POLICIES: Readonly<Record<string, Policy>> = { ...SINGLE, 'per-ply': perPly };

export const POLICY_NAMES: readonly string[] = Object.keys(POLICIES);
