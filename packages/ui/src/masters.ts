/**
 * The master worker's one player [W6-47].
 *
 * One `Master` for the worker's lifetime, created by `createMaster` on the
 * first request and shared by both seats. That is sound where *0008*'s
 * per-seat sessions are not ([W6-40]): `choose` keeps nothing between moves —
 * each is the trained player's search from an empty tree ([0011 Z11-19]) — so
 * one instance pays for instantiation and the parity check once.
 *
 * A module rather than a few lines inside `master-worker.ts`, because jsdom
 * has no `Worker`: this is what lets the fast suite exercise it.
 */

import { createMaster, type Master } from 'alphazero-bot/web';
import type { FromWorker, ToWorker } from './opponent.js';

export interface MasterSeat {
  /** The reply to one `master` request, never a rejection [W6-15]. */
  answer(request: Extract<ToWorker, { tier: 'master' }>): Promise<FromWorker>;
  /** How many times a `Master` was created, for the tests of "at most one". */
  readonly created: number;
}

export function createMasterSeat(create: () => Promise<Master> = createMaster): MasterSeat {
  let master: Promise<Master> | null = null;
  let created = 0;
  return {
    async answer(request) {
      const { generation } = request;
      try {
        if (master === null) {
          created++;
          master = create();
        }
        const choice = (await master).choose(request.position, request.simulations);
        return { generation, ok: true, choice };
      } catch (error) {
        // Caught and reported, never swallowed [W6-15]: a refused checkpoint
        // or a failed search is a defect the main thread throws on.
        return { generation, ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    get created() {
      return created;
    },
  };
}
