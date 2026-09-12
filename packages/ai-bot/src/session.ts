/**
 * The session [A8-26] through [A8-29]: the node table for one seat of one
 * game.
 *
 * The original keeps its search tree for the length of a game — `pit.py`
 * builds one `MCTS` per player and `Arena.playGame` discards it when the game
 * ends — so a move is a function of the game so far, not of the position
 * alone. That is kept here, which is why the state lives in an explicit
 * session owned by whoever plays the game, and why a fresh session's first
 * choice is still a pure function of the position [A8-27].
 *
 * `choose` is synchronous and schedules nothing [A8-4]. Keeping the page alive
 * is the worker's job, exactly as it is for `bot`.
 */

import { toJSON, type AzulJSON } from 'engine';
import { encodeBoard } from './board.js';
import { EXPERT } from './constants.js';
import { createNetwork, type Network } from './network.js';
import { rootChoice, simulate, type Evaluator, type NodeTable } from './search.js';
import { universeRoot } from './universe.js';

export interface ExpertOptions {
  /** Simulations per `choose`. Defaults to 100. For the fast suite only [A8-40]. */
  simulations?: number;
}

/** What a session returns [A8-29]. Plain, structurally cloneable data. */
export interface ExpertChoice {
  /** Always a member of `position.legalActions` [A8-42]. Our encoding. */
  action: number;
  /** The root's running value for the seat to move, in [-1, 1]. Not points. */
  value: number;
  /** Simulations run by this call. */
  simulations: number;
  /** The chosen action's visit count at the root, this session's history included. */
  rootVisits: number;
}

export interface Expert {
  choose(position: AzulJSON): ExpertChoice;
}

/**
 * A session with its node table in reach, which is what [A8-38] compares: the
 * root's visit counts, not only the action they chose.
 *
 * Not part of the package's surface — `createExpert` returns an {@link Expert}
 * — because the table is the search's own bookkeeping and nothing outside may
 * write to it.
 */
export interface Session extends Expert {
  readonly table: NodeTable;
}

/**
 * A session over an explicit evaluator, which is the seam [A8-38] replaces
 * with a lookup of the reference search's recorded outputs.
 *
 * Not exported from the package entry: the network is not a choice a caller
 * makes, it is what this package *is*.
 */
export function createSession(evaluator: Evaluator, options?: ExpertOptions): Session {
  const simulations = options?.simulations ?? EXPERT.simulations;
  if (!Number.isInteger(simulations) || simulations <= 0) {
    throw new TypeError(`simulations must be a positive integer, not ${String(options?.simulations)}`);
  }
  const table: NodeTable = new Map();
  // The seat this session serves, bound by the first position it is asked
  // about [A8-26]. One session answering both seats of a
  // computer-against-computer game is the easy mistake, and this catches it;
  // a session carried into a second game cannot be seen from a position, and
  // preventing that is the owner's job.
  let seat: number | null = null;

  return {
    table,
    choose(position) {
      if (position.isTerminal) throw new Error('the game is over: there is nothing to choose');
      if (position.legalActions.length === 0) throw new Error('no legal actions in this position');
      if (seat === null) seat = position.currentPlayer;
      else if (seat !== position.currentPlayer) {
        throw new Error(
          `this session serves seat ${seat}; it was asked about seat ${position.currentPlayer}`,
        );
      }

      const root = universeRoot(position);
      const board = encodeBoard(toJSON(root));
      // `forced` only at the node the simulation starts from: the original
      // recurses without passing it [A8-19].
      for (let i = 0; i < simulations; i++) simulate(table, evaluator, root, i, true);
      const { action, value, rootVisits } = rootChoice(table, board);
      return { action, value, simulations, rootVisits };
    },
  };
}

/**
 * The checkpoint's network as an evaluator.
 *
 * `normalised: false` is the whole of the wiring that makes the search
 * normalise what the network returns ([A8-50]), so it is named here rather
 * than written inline: declared `true`, the port would play unnormalised
 * priors and every replay check would still pass, because [A8-38] supplies its
 * own already-normalised priors.
 */
export function networkEvaluator(network: Network): Evaluator {
  return { evaluate: (board, legal) => network.evaluate(board, legal), normalised: false };
}

/** A session playing the checkpoint's network [A8-26]. */
export function createExpert(options?: ExpertOptions): Expert {
  return createSession(networkEvaluator(createNetwork()), options);
}
