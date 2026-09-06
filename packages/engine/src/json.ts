import { COLOR_NAMES, NUM_COLORS, NUM_ROWS } from './constants.js';
import { legalActions } from './actions.js';
import { fromCanonical } from './canonical.js';
import {
  bagCounts,
  completedColors,
  completedCols,
  completedRows,
  floorPenalty,
  outcome,
} from './inspect.js';
import type {
  AzulJSON,
  AzulJSONPlayer,
  AzulState,
  CanonicalState,
  Color,
  Player,
  Shuffle,
} from './types.js';

function playerView(s: AzulState, p: Player): AzulJSONPlayer {
  return {
    score: s.scores[p],
    wall: Array.from({ length: NUM_ROWS }, (_, r) => s.walls[p].slice(r * 5, r * 5 + 5)),
    patternLines: Array.from({ length: NUM_ROWS }, (_, r) => ({
      capacity: r + 1,
      color: s.plColor[p][r],
      count: s.plCount[p][r],
    })),
    floor: s.floor[p].slice(),
    floorMarker: s.floorMarker[p],
    floorPenalty: floorPenalty(s, p),
    completedRows: completedRows(s, p),
    completedCols: completedCols(s, p),
    completedColors: completedColors(s, p),
  };
}

/**
 * A lossy view for the UI [E1-52]: plain structurally-cloneable data, so a
 * state can cross a worker boundary, with the bag reported as counts because
 * its order is hidden information no player may see.
 *
 * It follows that this cannot tell apart two positions that will deal
 * differently — {@link toCanonical} is the tool for comparing or restoring.
 */
export function toJSON(s: AzulState): AzulJSON {
  return {
    round: s.roundIndex,
    currentPlayer: s.currentPlayer,
    firstPlayer: s.firstPlayer,
    factories: s.factories.map((f) => f.slice()),
    center: s.center.slice(),
    markerInCenter: s.markerInCenter,
    bag: bagCounts(s),
    lid: s.lid.slice(),
    tilesLeft: s.tilesLeft,
    scores: s.scores.slice(),
    isTerminal: s.isTerminal,
    exhausted: s.exhausted,
    outcome: outcome(s),
    legalActions: legalActions(s),
    colorNames: [...COLOR_NAMES],
    players: [playerView(s, 0), playerView(s, 1)],
  };
}

/**
 * Loads a lossy view [E1-69]. The counterpart to {@link toJSON}, and — because
 * `AzulJSON` reports the bag as counts and never its order [E1-52], [E1-55] —
 * a constructor through which a bag order **cannot be expressed**.
 *
 * That is the point of it. A caller holding only an `AzulJSON` has no hidden
 * information to leak, and the barrier is the type rather than a promise: the
 * bot of *0004 — Computer opponent* is built on exactly this ([0004 B4-10]).
 *
 * The bag is filled with `json.bag[c]` tiles of each colour in ascending
 * colour order. The order is arbitrary and deliberately not realistic; it is
 * fixed so this is a function rather than a family of them.
 *
 * A caller that deals from such a state deals a fiction — and the bot does
 * deal one, every time it applies a round-ending ply, because `endRound`
 * refills inside the same ply that scores [E1-21]. What saves it is that it
 * never looks: [0004 B4-6] stops the search *past* the boundary, and
 * [0004 B4-7] stops the evaluation reading what was dealt.
 *
 * `shufflesUsed` starts at 0, because `AzulJSON` does not carry it and nothing
 * about a board implies it. That is a trap worth naming: `shufflesUsed` is the
 * shuffle seam's own index [E1-61], so a caller passing a *recorded* `shuffle`
 * here is handed index 0 at the first lid recycle and replays the wrong entry.
 * Use {@link fromCanonical} for anything that replays.
 *
 * Throws by way of `fromCanonical` when `tilesLeft` disagrees with the board
 * it was given [E1-41].
 */
export function fromJSON(json: AzulJSON, seed: number, shuffle?: Shuffle): AzulState {
  const bag: Color[] = [];
  for (let c = 0; c < NUM_COLORS; c++) {
    for (let n = json.bag[c]; n > 0; n--) bag.push(c as Color);
  }
  const canonical: CanonicalState = {
    factories: json.factories.map((f) => f.slice()),
    center: json.center.slice(),
    markerInCenter: json.markerInCenter,
    bag,
    lid: json.lid.slice(),
    // `AzulJSONPlayer.wall` is 5 rows of 5; the model's is flat [25] [E1-2].
    walls: json.players.map((p) => p.wall.flat()),
    plColor: json.players.map((p) => p.patternLines.map((line) => line.color)),
    plCount: json.players.map((p) => p.patternLines.map((line) => line.count)),
    floor: json.players.map((p) => p.floor.slice()),
    floorMarker: json.players.map((p) => p.floorMarker),
    scores: json.scores.slice(),
    currentPlayer: json.currentPlayer,
    firstPlayer: json.firstPlayer,
    roundIndex: json.round,
    tilesLeft: json.tilesLeft,
    shufflesUsed: 0,
    isTerminal: json.isTerminal,
    exhausted: json.exhausted,
  };
  return fromCanonical(canonical, seed, shuffle);
}
