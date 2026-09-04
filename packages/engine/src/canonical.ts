import { recount } from './inspect.js';
import { Rng } from './rng.js';
import type { AzulState, CanonicalState, Shuffle } from './types.js';

/**
 * The lossless snapshot [E1-62]: every data-model field and nothing else, with
 * the bag in order and keys emitted in the order the data model declares them,
 * which is what lets two languages regenerate byte-identical fixtures.
 *
 * `tilesLeft` and `shufflesUsed` are included even though the board implies
 * the first and nothing implies the second — comparing them catches drifted
 * bookkeeping at the ply it drifts rather than several plies later.
 */
export function toCanonical(s: AzulState): CanonicalState {
  return {
    factories: s.factories.map((f) => f.slice()),
    center: s.center.slice(),
    markerInCenter: s.markerInCenter,
    bag: s.bag.slice(),
    lid: s.lid.slice(),
    walls: s.walls.map((w) => w.slice()),
    plColor: s.plColor.map((x) => x.slice()),
    plCount: s.plCount.map((x) => x.slice()),
    floor: s.floor.map((f) => f.slice()),
    floorMarker: s.floorMarker.slice(),
    scores: s.scores.slice(),
    currentPlayer: s.currentPlayer,
    firstPlayer: s.firstPlayer,
    roundIndex: s.roundIndex,
    tilesLeft: s.tilesLeft,
    shufflesUsed: s.shufflesUsed,
    isTerminal: s.isTerminal,
    exhausted: s.exhausted,
  };
}

/**
 * Loads a snapshot [E1-62]. A **one-sided** inverse of {@link toCanonical}:
 * `toCanonical(fromCanonical(c, …))` deep-equals `c`, but the other direction
 * cannot hold, because a snapshot deliberately omits the generator's internal
 * state — hence the seed, and hence `clone` rather than this pair being the
 * operation that preserves a stream exactly [E1-48].
 *
 * A handcrafted position usually has a nearly-empty bag, so it takes the same
 * shuffle seam `newGame` does [E1-61]; loading itself never shuffles, so a
 * replay's `shuffles[0]` is the first lid recycle *after* the load.
 *
 * Throws on a snapshot whose `tilesLeft` disagrees with its own board rather
 * than loading a position the engine could never have reached [E1-41].
 */
export function fromCanonical(
  c: CanonicalState,
  seed: number,
  shuffle?: Shuffle,
): AzulState {
  const s: AzulState = {
    factories: c.factories.map((f) => f.slice()),
    center: c.center.slice(),
    markerInCenter: c.markerInCenter,
    bag: c.bag.slice(),
    lid: c.lid.slice(),
    walls: c.walls.map((w) => w.slice()),
    plColor: c.plColor.map((x) => x.slice()),
    plCount: c.plCount.map((x) => x.slice()),
    floor: c.floor.map((f) => f.slice()),
    floorMarker: c.floorMarker.slice(),
    scores: c.scores.slice(),
    currentPlayer: c.currentPlayer,
    firstPlayer: c.firstPlayer,
    roundIndex: c.roundIndex,
    tilesLeft: 0, // derived from the board by the recount below
    shufflesUsed: c.shufflesUsed,
    isTerminal: c.isTerminal,
    exhausted: c.exhausted,
    rng: new Rng(seed),
    shuffle: shuffle ?? null,
  };
  // Derive rather than copy, so this is also the one place a future cache gets
  // rebuilt [E1-62], and then hold the snapshot to what the board actually says.
  recount(s);
  if (s.tilesLeft !== c.tilesLeft) {
    throw new Error(
      `canonical tilesLeft ${c.tilesLeft} disagrees with board ${s.tilesLeft}`,
    );
  }
  return s;
}
