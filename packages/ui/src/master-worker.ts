/**
 * The master worker [W6-46], [W6-47].
 *
 * Reaches `engine` and `alphazero-bot/web` — the payload, megabytes of it —
 * and nothing else: not `bot`, not `ai-bot`, not a component, not the state
 * module. It is built only when a seat is `master`, so a game without one
 * never loads what this carries.
 *
 * Requests are answered one after another, in the order they arrive: the
 * first waits for the module to instantiate, and a second must not overtake
 * it, since the seam routes replies by generation and expects each worker to
 * answer in order ([W6-42]).
 */

import { createMasterSeat } from './masters.js';
import type { FromWorker, ToWorker } from './opponent.js';

const seat = createMasterSeat();
let queue: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  const request = event.data;
  queue = queue.then(async () => {
    const reply: FromWorker =
      request.tier === 'master'
        ? await seat.answer(request)
        : { generation: request.generation, ok: false, message: `the master worker was asked for ${request.tier}` };
    self.postMessage(reply);
  });
});
