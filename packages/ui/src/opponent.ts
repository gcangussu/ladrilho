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
import type { ExpertChoice } from 'ai-bot';
import baseline from 'ai-bot/gate/baseline.json' with { type: 'json' };

export type { Choice, ExpertChoice, Tier };

/**
 * What can occupy a seat [0008 A8-33]: one of `bot`'s three tiers, or the
 * expert of *0008*, which is not a tier of `bot` but a second package the
 * interface reaches beside it ([0004 B4-1]).
 */
export type Level = Tier | 'expert';

/**
 * Is `expert` offered, given a gate result [0008 A8-33]?
 *
 * A function of the file rather than a constant read from it, so both answers
 * can be tested: the committed baseline passed, so a hard-coded `true` would
 * agree with it today and disagree the day a rerun did not clear the bar.
 */
export function expertAvailable(gate: { passed?: unknown }): boolean {
  return gate.passed === true;
}

/**
 * Is `expert` offered at all [0008 A8-33]?
 *
 * Intent 0006 said it ships only if it wins clearly more often than our
 * hardest setting, and the gate of [0008 A8-30] is what answered that. The
 * committed result decides, so this is read from the file the lane wrote
 * rather than from a flag somebody can set.
 */
export const EXPERT_AVAILABLE: boolean = expertAvailable(baseline);

/** What the main thread sends [W6-14]. */
export interface ToWorker {
  generation: number;
  position: AzulJSON;
  tier: Level;
}

/** What comes back [W6-14], [W6-15]. */
export type FromWorker =
  | { generation: number; ok: true; choice: Choice | ExpertChoice }
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
 * Created lazily [W6-13]: a two-person game never asks, so it never spawns a
 * worker or loads the search. The state module terminates it on every deal,
 * and the next request builds a fresh one.
 *
 * One listener per worker, routing each reply to the request whose generation
 * it carries [W6-42]. An earlier version put a listener per request on the one
 * shared worker, each resolving on the first reply of any kind: a request made
 * while another was outstanding took the other's reply — stale, so dropped —
 * and its own then arrived to nobody, leaving `thinking` set and the computer
 * silent for the rest of the session. The fast suite injected a seam with a
 * resolver per request, which cannot cross its wires, so nothing saw it.
 *
 * A request still outstanding when the worker is terminated is **abandoned**:
 * its promise never settles. Every caller of `terminate` bumps the generation
 * in the same step ([W6-16]), so any reply it could be given would be
 * discarded unread; settling it would manufacture one to throw away, and
 * settling it `ok: false` would dress a cancellation up as the failure [W6-15]
 * throws on. Terminating empties the pending list before dropping the worker,
 * so a reply the old worker sent just before it was terminated, delivered
 * after, finds nobody to settle; and nothing is retained.
 */
export function workerThinker(): Thinker {
  type Pending = { generation: number; resolve: (reply: FromWorker) => void };
  type Live = { worker: Worker; pending: Pending[] };
  let live: Live | null = null;

  const ensure = (): Live => {
    if (live !== null) return live;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const pending: Pending[] = [];
    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      // The oldest request carrying this reply's generation — the worker
      // answers in the order it was asked. A reply nobody is waiting for is
      // dropped here rather than handed to whoever is.
      const at = pending.findIndex((p) => p.generation === event.data.generation);
      if (at < 0) return;
      const [waiting] = pending.splice(at, 1);
      waiting.resolve(event.data);
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      // [W6-15]. Not attributable to one request, so every outstanding one
      // fails under its own generation; the caller drops the stale ones.
      for (const waiting of pending.splice(0)) {
        waiting.resolve({
          generation: waiting.generation,
          ok: false,
          message: event.message || 'the worker failed',
        });
      }
    });
    live = { worker, pending };
    return live;
  };

  return {
    think(request) {
      const { worker, pending } = ensure();
      return new Promise<FromWorker>((resolve) => {
        pending.push({ generation: request.generation, resolve });
        worker.postMessage(request);
      });
    },
    terminate() {
      // Emptied, not merely dropped: the old worker keeps its listener, and a
      // reply it posted before termination may still be delivered after it.
      live?.pending.splice(0);
      live?.worker.terminate();
      live = null;
    },
  };
}

/** Who occupies each seat: `null` is a person, a level is the computer [W6-1]. */
export interface Seating {
  players: [Level | null, Level | null];
}

/** Two people — 0003's game, unchanged. */
export const HOT_SEAT: Seating = { players: [null, null] };

/** Is `seat` played by the computer? */
export function isComputer(seating: Seating, seat: Player): boolean {
  return seating.players[seat] !== null;
}

/** The level at `seat`, or `null` when a person sits there. */
export function tierAt(seating: Seating, seat: Player): Level | null {
  return seating.players[seat];
}

/**
 * What a seat may be set to, in the order the interface offers them [W6-1].
 *
 * `expert` is here only when the gate passed: a setting the interface does not
 * offer is not one a URL may name either, or a link would seat an opponent
 * nobody can choose ([0008 A8-33]).
 */
export const LEVELS: readonly Level[] = EXPERT_AVAILABLE
  ? ['easy', 'steady', 'sharp', 'expert']
  : ['easy', 'steady', 'sharp'];

/** A level name, or `null` for a person; anything else is discarded [W6-4]. */
function parseSeat(raw: string | null): Level | null | undefined {
  if (raw === null || raw === 'human') return null;
  return LEVELS.includes(raw as Level) ? (raw as Level) : undefined;
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
