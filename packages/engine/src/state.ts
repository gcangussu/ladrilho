import { NUM_COLORS, NUM_FACTORIES, NUM_ROWS, TILES_PER_COLOR } from './constants.js';
import { Rng } from './rng.js';
import { refill, runShuffle } from './round.js';
import type { AzulState, Color, Shuffle } from './types.js';

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

/**
 * The opening position [E1-65]: a full bag shuffled once, empty everything
 * else, player 0 to move and holding neither marker nor advantage, then the
 * first refill — which leaves `tilesLeft` at 20 and `shufflesUsed` at 1.
 *
 * `shuffle` replaces the seeded default [E1-61]; when it is supplied the seed
 * is unused, but one is still required so a state never lacks a randomness
 * source.
 */
export function newGame(seed: number, shuffle?: Shuffle): AzulState {
  const bag: Color[] = [];
  for (let c = 0; c < NUM_COLORS; c++) {
    for (let i = 0; i < TILES_PER_COLOR; i++) bag.push(c as Color);
  }
  const s: AzulState = {
    factories: Array.from({ length: NUM_FACTORIES }, () => zeros(NUM_COLORS)),
    center: zeros(NUM_COLORS),
    markerInCenter: true,
    bag,
    lid: zeros(NUM_COLORS),
    walls: [zeros(25), zeros(25)],
    plColor: [new Array<number>(NUM_ROWS).fill(-1), new Array<number>(NUM_ROWS).fill(-1)],
    plCount: [zeros(NUM_ROWS), zeros(NUM_ROWS)],
    floor: [zeros(NUM_COLORS), zeros(NUM_COLORS)],
    floorMarker: [false, false],
    scores: [0, 0],
    currentPlayer: 0,
    firstPlayer: 0,
    roundIndex: 0,
    tilesLeft: 0,
    shufflesUsed: 0,
    isTerminal: false,
    exhausted: false,
    rng: new Rng(seed),
    shuffle: shuffle ?? null,
  };
  runShuffle(s);
  refill(s);
  return s;
}

/**
 * A copy sharing no mutable container with its source, and continuing the
 * parent's generator stream exactly [E1-48]. The shuffle seam is shared by
 * reference on purpose: it is a pure function of `(bag, index)` and holds no
 * cursor that the two states could fight over [E1-61].
 */
export function clone(s: AzulState): AzulState {
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
    rng: s.rng.copy(),
    shuffle: s.shuffle,
  };
}
