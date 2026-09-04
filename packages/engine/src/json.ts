import { COLOR_NAMES, NUM_ROWS } from './constants.js';
import { legalActions } from './actions.js';
import {
  bagCounts,
  completedColors,
  completedCols,
  completedRows,
  floorPenalty,
  outcome,
} from './inspect.js';
import type { AzulJSON, AzulJSONPlayer, AzulState, Player } from './types.js';

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
