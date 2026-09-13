/**
 * The worker [W6-11], [W6-12], [W6-15], [W6-40].
 *
 * Imports `bot`, `ai-bot` and `engine` and nothing else — no component, and
 * above all not the state module, which is what keeps `submit` the only route
 * into the game ([0003 U3-18], [W6-8]). This file is the whole of the client
 * that ever runs a search, and it runs none of it on the main thread [W6-10].
 *
 * The expert's sessions live here for the worker's lifetime [W6-40]: a new
 * game or a seating change terminates the worker ([W6-13]), which is what ends
 * them. The per-seat logic is in `experts.ts` so the fast suite can reach it
 * without a `Worker`.
 */

import { chooseMove } from 'bot';
import { createExpertSeats } from './experts.js';
import type { FromWorker, ToWorker } from './opponent.js';

const experts = createExpertSeats();

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const { generation, position, tier } = event.data;
  try {
    const choice = tier === 'expert' ? experts.choose(position) : chooseMove(position, { tier });
    const reply: FromWorker = { generation, ok: true, choice };
    self.postMessage(reply);
  } catch (error) {
    // Caught and reported, never swallowed [W6-15]. The main thread throws on
    // this: a bot that cannot choose a move is a defect, and a client that
    // quietly plays something else hides it where nobody would look. A throw
    // from `createExpert` or `choose` is caught the same way.
    const reply: FromWorker = {
      generation,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(reply);
  }
});
