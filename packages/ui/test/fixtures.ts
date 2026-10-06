/**
 * View models posed directly for the components.
 *
 * The spec sanctions exactly this for the two endings random play cannot reach:
 * [U3-44]'s draw is vanishingly rare and [U3-45]'s exhausted ending is not
 * reachable at all through the interface, so both are driven from a stubbed
 * view handed to the components. A *view* is posed, never a state, which is
 * what keeps this clear of [0001 E1-5] and of [0002 V2-3].
 */

import { type AzulJSON, floorOccupied, newGame, toJSON } from 'engine';
import type { ViewModel } from '../src/game.js';
import { HOT_SEAT } from '../src/opponent.js';

export function openingGame(seed = 42): AzulJSON {
  return toJSON(newGame(seed));
}

export function openingView(seed = 42): ViewModel {
  const state = newGame(seed);
  return {
    game: toJSON(state),
    floorOccupied: [floorOccupied(state, 0), floorOccupied(state, 1)],
    seed,
    transition: null,
    seating: HOT_SEAT,
    thinking: null,
    lastChoice: null,
    scoring: null,
    lastMoves: [null, null],
  };
}

/** An ended game, with whatever the caller needs changed about how it ended. */
export function endedGame(patch: Partial<AzulJSON> = {}): AzulJSON {
  const game = openingGame();
  return {
    ...game,
    isTerminal: true,
    legalActions: [],
    outcome: 1,
    scores: [50, 40],
    players: game.players.map((p, i) => ({ ...p, score: [50, 40][i] })),
    ...patch,
  };
}
