/**
 * The worker [W6-11], [W6-12], [W6-15].
 *
 * Imports `bot` and `engine` and nothing else — no component, and above all not
 * the state module, which is what keeps `submit` the only route into the game
 * ([0003 U3-18], [W6-8]). This file is the whole of the client that ever runs a
 * search, and it runs none of it on the main thread [W6-10].
 */

import { chooseMove } from 'bot';
import type { FromWorker, ToWorker } from './opponent.js';

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const { generation, position, tier } = event.data;
  try {
    const choice = chooseMove(position, { tier });
    const reply: FromWorker = { generation, ok: true, choice };
    self.postMessage(reply);
  } catch (error) {
    // Caught and reported, never swallowed [W6-15]. The main thread throws on
    // this: a bot that cannot choose a move is a defect, and a client that
    // quietly plays something else hides it where nobody would look.
    const reply: FromWorker = {
      generation,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(reply);
  }
});
