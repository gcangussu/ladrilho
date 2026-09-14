/**
 * The expert's sessions, one per seat [W6-40].
 *
 * *0008*'s player keeps its search tree for the length of a game, so a move is
 * a function of the game so far rather than of the position alone
 * ([0008 A8-26]). That state has to live somewhere, and this is the somewhere:
 * one session per seat, created when that seat first asks, and never outliving
 * the worker that holds it.
 *
 * A module rather than a few lines inside `worker.ts`, because jsdom has no
 * `Worker`: this is what lets the fast suite exercise the lifetime instead of
 * leaving it to the browser lane [W6-41].
 */

import type { AzulJSON } from 'engine';
import { chooseMove, type Choice } from 'bot';
import { createExpert, type Expert, type ExpertChoice } from 'ai-bot';
import type { ToWorker } from './opponent.js';

export interface ExpertSeats {
  /** The choice for whichever seat is to move, from that seat's own session. */
  choose(position: AzulJSON): ExpertChoice;
  /** How many sessions exist, for the tests that hold [W6-40] to "at most one". */
  readonly sessions: number;
}

/**
 * Which player answers a request [W6-1], [W6-40].
 *
 * The worker's only decision, and a function so the fast suite can make it:
 * jsdom has no `Worker`, and routing `expert` to a tier would otherwise be
 * invisible — the game would still finish, and the browser lane would not
 * notice either.
 */
export function chooseFor(request: ToWorker, seats: ExpertSeats): Choice | ExpertChoice {
  return request.tier === 'expert'
    ? seats.choose(request.position)
    : chooseMove(request.position, { tier: request.tier });
}

/**
 * Sessions for one worker's lifetime.
 *
 * Keyed by the seat to move, which is what a session binds to on its first
 * position ([0008 A8-26]): asking seat 1's session about seat 0's position
 * throws there, and this is the structure that makes that unreachable.
 *
 * Nothing here ends a session, because nothing needs to: [W6-13] terminates
 * the worker on a new game and on a seating change, and these die with it.
 */
export function createExpertSeats(create: () => Expert = createExpert): ExpertSeats {
  const seats = new Map<number, Expert>();
  return {
    choose(position) {
      const seat = position.currentPlayer;
      let session = seats.get(seat);
      if (session === undefined) {
        session = create();
        seats.set(seat, session);
      }
      return session.choose(position);
    },
    get sessions() {
      return seats.size;
    },
  };
}
