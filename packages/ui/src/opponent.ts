/**
 * The worker seam [W6-11] through [W6-18]: the only thing in the client that
 * can ask for a move.
 *
 * `bot` is imported here and nowhere else. The state module and every component
 * are barred from it by [W6-31], so "the interface contains no strategy" is a
 * property of the import graph rather than a promise — the same shape
 * [0003 U3-78] uses to make "the interface contains no rule" checkable.
 *
 * What crosses the boundary is `AzulJSON` and a `Choice`, both plain data
 * [W6-14]. That is also the information barrier: `postMessage` structurally
 * clones, `toJSON` reports the bag as counts and never its order
 * ([0001 E1-52]), so there is no bag order on this side of the wire for the bot
 * to be given. Intent 0003's "no private information" is enforced by the
 * boundary rather than trusted to the search.
 */

import type { AzulJSON, Player } from 'engine';
import type { Choice, Tier } from 'bot';

export type { Choice, Tier };

/** What the main thread sends [W6-14]. */
export interface ToWorker {
  generation: number;
  position: AzulJSON;
  tier: Tier;
}

/** What comes back [W6-14], [W6-15]. */
export type FromWorker =
  | { generation: number; ok: true; choice: Choice }
  | { generation: number; ok: false; message: string };

/**
 * The seam [W6-18]. Injectable so the fast suite can substitute a chooser that
 * answers immediately — load-bearing rather than convenient, because jsdom has
 * no `Worker` and without it every requirement in *0006* would fall to the slow
 * browser lane of [0003 U3-73].
 */
export interface Thinker {
  think(request: ToWorker): Promise<FromWorker>;
  /** Releases whatever backs it [W6-13]. Idempotent. */
  terminate(): void;
}

/**
 * The real seam: a dedicated module worker [W6-11].
 *
 * Constructed from a URL relative to this module's own source, which is the one
 * run-time load [0003 U3-8] permits as amended — not a network request for
 * data, and not a dynamic `import()`; the bundler resolves it at build time and
 * emits a chunk beside the client.
 *
 * Created lazily [W6-13]: a two-person game never touches this file, so it
 * never spawns a worker or loads the search.
 */
export function workerThinker(): Thinker {
  let worker: Worker | null = null;

  const ensure = (): Worker => {
    if (worker === null) {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    }
    return worker;
  };

  return {
    think(request) {
      const live = ensure();
      return new Promise<FromWorker>((resolve) => {
        const onMessage = (event: MessageEvent<FromWorker>): void => {
          // Only this request's reply. A stale generation is discarded by the
          // caller [W6-16]; this listener is removed either way.
          live.removeEventListener('message', onMessage);
          live.removeEventListener('error', onError);
          resolve(event.data);
        };
        const onError = (event: ErrorEvent): void => {
          live.removeEventListener('message', onMessage);
          live.removeEventListener('error', onError);
          resolve({
            generation: request.generation,
            ok: false,
            message: event.message || 'the worker failed',
          });
        };
        live.addEventListener('message', onMessage);
        live.addEventListener('error', onError);
        live.postMessage(request);
      });
    },
    terminate() {
      worker?.terminate();
      worker = null;
    },
  };
}

/** Who occupies each seat: `null` is a person, a tier is the computer [W6-1]. */
export interface Seating {
  players: [Tier | null, Tier | null];
}

/** Two people — 0003's game, unchanged. */
export const HOT_SEAT: Seating = { players: [null, null] };

/** Is `seat` played by the computer? */
export function isComputer(seating: Seating, seat: Player): boolean {
  return seating.players[seat] !== null;
}

/** The tier at `seat`, or `null` when a person sits there. */
export function tierAt(seating: Seating, seat: Player): Tier | null {
  return seating.players[seat];
}

const TIERS: readonly Tier[] = ['easy', 'steady', 'sharp'];

/** A tier name, or `null` for a person; anything else is discarded [W6-4]. */
function parseSeat(raw: string | null): Tier | null | undefined {
  if (raw === null || raw === 'human') return null;
  return TIERS.includes(raw as Tier) ? (raw as Tier) : undefined;
}

/**
 * The `seating` URL parameter [W6-4], as `<seat0>-<seat1>`, or `null` when it
 * is absent or malformed.
 *
 * Discarded rather than partially honoured, exactly as [0003 U3-13] discards a
 * malformed seed: a URL that half-describes a match reproduces neither the one
 * it names nor the one it was copied from.
 */
export function seatingFromUrl(search: string): Seating | null {
  const raw = new URLSearchParams(search).get('seating');
  if (raw === null) return null;
  const halves = raw.split('-');
  if (halves.length !== 2) return null;
  const first = parseSeat(halves[0]);
  const second = parseSeat(halves[1]);
  if (first === undefined || second === undefined) return null;
  return { players: [first, second] };
}

/** The inverse of {@link seatingFromUrl}, so a game can be linked to [W6-4]. */
export function seatingToUrl(seating: Seating): string {
  return seating.players.map((tier) => tier ?? 'human').join('-');
}
