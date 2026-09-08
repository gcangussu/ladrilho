/**
 * The engine seam [U3-78]: the held state, `submit` and `publish`, in one
 * module. Nothing else may import the state binding — and nothing can, because
 * it is not exported.
 *
 * The shape of this file is set by one fact about the engine: `apply` mutates
 * the state in place [0001 E1-51], so the object's identity never changes and a
 * reactive graph watching it would never see a thing. So the state is *held*
 * and never observed, a plain view model is *observed* and never held, and
 * `publish` is the only bridge between them [U3-1].
 */

import {
  type AzulJSON,
  type AzulState,
  type Player,
  NUM_COLORS,
  NUM_ROWS,
  apply,
  floorOccupied,
  newGame,
  toJSON,
} from 'engine';
import { createSignal } from 'solid-js';
import {
  HOT_SEAT,
  isComputer,
  seatingFromUrl,
  tierAt,
  workerThinker,
  type Choice,
  type Seating,
  type Thinker,
  type ToWorker,
} from './opponent.js';

/** What a transition put on the wall and what it cost [U3-42]. */
export interface Transition {
  /** `[2][25]`, flat row-major [0001 E1-2]: the cells this transition set. */
  newlyPlaced: number[][];
  scoreDelta: number[];
  ended: boolean;
}

/** A search is in flight for this seat [W6-19]. */
export type Thinking = { seat: Player } | null;

/** Everything a component may read that derives from the game state [U3-6]. */
export interface ViewModel {
  game: AzulJSON;
  /** `[2]`, from `floorOccupied` — the engine's answer, not our arithmetic [U3-4]. */
  floorOccupied: number[];
  /** The seed this game was dealt from [U3-14]. */
  seed: number;
  /** Set on exactly one ply, `null` on every other [U3-42]. */
  transition: Transition | null;
  /** Who occupies each seat this game [W6-2]. */
  seating: Seating;
  /**
   * Non-null exactly while a request is outstanding [W6-19], [W6-33]. Nothing
   * else may be used to infer that a search is running.
   */
  thinking: Thinking;
  /**
   * The last search's own report. Published for diagnostics only and MUST NOT
   * be rendered [W6-24], [W6-25] — intent 0003 rules out explaining a move, and
   * [0003 U3-30] already rules out judging one before it is made.
   */
  lastChoice: Choice | null;
}

/**
 * Held, never observed, never exported [U3-1]. Exactly one per game [U3-5],
 * produced only by `newGame` [U3-12], and only ever advanced by `apply` — which
 * is what makes [U3-65] true, and what makes there be no undo [U3-17].
 */
let state: AzulState;

/** The seed `state` was dealt from, republished on every ply [U3-14]. */
let currentSeed: number;

/** Who occupies each seat this game [W6-2]. Changing it deals a new one [W6-3]. */
let seating: Seating = HOT_SEAT;

/**
 * Bumped whenever a game is dealt or the seating changes [W6-16].
 *
 * A worker reply carrying a stale generation is discarded without submitting —
 * the search that produced it was asked about a position from a game that no
 * longer exists, and playing its answer would advance the *new* game by a move
 * chosen for the old one.
 */
let generation = 0;

/** The seat a request is outstanding for, or `null` [W6-19], [W6-32]. */
let thinking: Thinking = null;

/** The last `Choice`, for [W6-25] only. Never rendered [W6-24]. */
let lastChoice: Choice | null = null;

/**
 * The worker seam [W6-18]. Created lazily and replaced only by a test — a
 * two-person game never builds one, so it never spawns a worker [W6-13].
 */
let thinker: Thinker | null = null;

/**
 * Substitute the seam [W6-18]. For the fast suite, which has no `Worker`.
 *
 * Replacing a seam **abandons whatever the old one was thinking about**: the
 * generation is bumped so a late reply from it is discarded [W6-16], and the
 * outstanding flag is cleared [W6-13].
 *
 * It deliberately does **not** restart the loop. An earlier version did, and it
 * hid a real defect: the opening ask was missing entirely, so every fast-suite
 * test passed — each one injected a seam, and injecting kicked the loop — while
 * a page loaded with the computer on seat 0 sat still forever. Only the browser
 * lane, which injects nothing, ever saw it. The deferred ask below the signal
 * is what starts a game now, and this function is back to doing one thing.
 */
export function useThinker(replacement: Thinker | null): void {
  thinker?.terminate();
  thinker = replacement;
  generation++;
  thinking = null;
}

function seam(): Thinker {
  if (thinker === null) thinker = workerThinker();
  return thinker;
}

/**
 * The view model published on the previous ply, kept for exactly one ply and
 * read only to compute the transition diff [U3-41].
 *
 * Every ply's view model lands here, not only the pre-transition ones: [U3-40]
 * forbids anticipating a transition, so there is no moment at which we could
 * know in advance that *this* is the one worth keeping. Each publish replaces
 * it, which is the "exactly one ply" the requirement asks for.
 */
let previous: ViewModel | null = null;

/**
 * A seed that the `Rng` constructor's `seed | 0` reduction maps injectively,
 * which `[0, 2**32)` is and `Math.random()` is not [U3-13].
 */
function freshSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/**
 * The `seed` URL parameter, or `null` when it is absent or does not name an
 * integer in `[0, 2**32)` [U3-13].
 *
 * Only a plain run of decimal digits is accepted. `parseInt` would take
 * `"12abc"`; `Number` would take `" 12 "` and `"0x10"`; both hand `NaN` to a
 * reduction that turns it into 0. Every malformed seed dealing the same game is
 * exactly the failure this rejects.
 */
function seedFromUrl(search: string): number | null {
  const raw = new URLSearchParams(search).get('seed');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const seed = Number(raw);
  return seed < 2 ** 32 ? seed : null;
}

/** Flatten `AzulJSONPlayer.wall`'s 5×5 to the flat row-major `[25]` of [0001 E1-2]. */
function flatWall(wall: number[][]): number[] {
  const flat: number[] = [];
  for (let r = 0; r < NUM_ROWS; r++) {
    for (let col = 0; col < NUM_COLORS; col++) flat.push(wall[r][col]);
  }
  return flat;
}

/**
 * Has a round transition happened between these two published games [U3-39]?
 *
 * Both clauses are needed. A row completion ends the game before the round
 * index moves [0001 E1-36], raising `isTerminal` alone; exhaustion raises both
 * [0001 E1-37]; an ordinary round raises `round` alone [0001 E1-35].
 */
function transitioned(before: AzulJSON, after: AzulJSON): boolean {
  return after.round > before.round || (after.isTerminal && !before.isTerminal);
}

/** What the transition placed, and what each player's score did [U3-42]. */
function diff(before: AzulJSON, after: AzulJSON): Transition {
  return {
    newlyPlaced: after.players.map((player, p) => {
      const was = flatWall(before.players[p].wall);
      return flatWall(player.wall).map((cell, i) => (cell && !was[i] ? 1 : 0));
    }),
    scoreDelta: after.players.map((player, p) => player.score - before.players[p].score),
    ended: after.isTerminal,
  };
}

/**
 * The view model for the state as it now stands, retained on the way out for
 * the next ply's diff [U3-41].
 *
 * Derived from the held state and from `previous`, never from a signal read:
 * reading `view()` back after a `setView` returns the value from the ply before
 * last in Solid v2, and a view model built from that would describe a state it
 * was not derived from — the failure [U3-63] catches [U3-21].
 *
 * Load-bearing and unwritten anywhere else: **every view model this module
 * produces is published**. Call this without publishing the result and
 * `previous` advances past a view nobody saw, after which the next transition
 * diff is computed against a view model that was never on screen — silently.
 */
function nextView(): ViewModel {
  const game = toJSON(state);
  const prior = previous;
  const next: ViewModel = {
    game,
    floorOccupied: [floorOccupied(state, 0), floorOccupied(state, 1)],
    seed: currentSeed,
    transition: prior !== null && transitioned(prior.game, game) ? diff(prior.game, game) : null,
    seating,
    thinking,
    lastChoice,
  };
  previous = next;
  return next;
}

/** Deal a game and return its opening view. The only `newGame` call [U3-5], [U3-12]. */
function deal(seed: number): ViewModel {
  state = newGame(seed);
  currentSeed = seed;
  previous = null;
  // A new game abandons whatever the worker was thinking about [W6-16].
  generation++;
  thinking = null;
  lastChoice = null;
  return nextView();
}

seating = seatingFromUrl(location.search) ?? HOT_SEAT;
const [view, setView] = createSignal<ViewModel>(deal(seedFromUrl(location.search) ?? freshSeed()));

/**
 * The opening position may already be the computer's to play [W6-6], and
 * nothing else would notice: `deal` publishes no ply, so the loop that runs
 * after every publish never starts.
 *
 * Deferred by a task rather than called here, for two reasons. The board paints
 * before the first search is asked for, so a page opened on
 * `?seating=sharp-human` shows a board and then says it is thinking, rather
 * than showing nothing until it does. And it leaves a turn in which
 * {@link useThinker} can substitute the seam — without that the fast suite
 * would reach for a real `Worker` on import, and jsdom has none.
 *
 * This was a real bug, caught by the browser lane and by nothing else: the
 * fast suite injects a seam, and injecting one kicks the loop, so every test
 * there passed while a page loaded with the computer on seat 0 sat still
 * forever.
 */
setTimeout(() => {
  const request = pendingRequest();
  if (request === null) return;
  // One publish, carrying `thinking`, and only when there is something to say.
  setView(nextView());
  dispatch(request);
}, 0);

/** The published view model — the only state-derived thing a component reads [U3-6]. */
export { view };

/**
 * Replace the view model wholesale; never mutate the one it replaces [U3-21].
 *
 * **Exactly one `setView` per ply**, which is [U3-42] and is easy to lose. Solid
 * v2 stages writes, so a second `setView` in the same task discards the first —
 * and because {@link nextView} advances `previous`, that second view model
 * computes its transition against the position it was just built from and comes
 * out `null`. A publish followed by a separate "now say it is thinking" publish
 * therefore drops the round transition entirely: the tiles that arrived on the
 * wall and each player's score change ([U3-43]) never render.
 *
 * That was a real regression and it was invisible — the transition tests are
 * hot-seat, so nothing exercised a publish with the computer next to move.
 * Hence the shape here: decide who moves next and mark `thinking` *before* the
 * single publish, then send the request.
 */
function publish(): void {
  const request = pendingRequest();
  setView(nextView());
  if (request !== null) dispatch(request);
}

/**
 * Decide whether the seat to move is a tier, and mark `thinking` if it is
 * [W6-6], [W6-19]. Returns the request to send, or `null`. Publishes nothing.
 *
 * Guarded on `thinking`, so a second request cannot be issued while one is
 * outstanding [W6-7] — which also makes [W6-9] terminate: two tiers alternate
 * through here one ply at a time, each publish waking the next request. The
 * guard is load-bearing in a second, less obvious way: the opening ask is
 * deferred by a task, so a `startNewGame` in between would otherwise race it
 * and issue two requests carrying the same generation, which [W6-16] cannot
 * filter apart.
 */
function pendingRequest(): ToWorker | null {
  if (state.isTerminal || thinking !== null) return null;
  const seat = state.currentPlayer;
  const tier = tierAt(seating, seat);
  if (tier === null) return null;
  thinking = { seat };
  return { generation, position: toJSON(state), tier };
}

/**
 * Send a prepared request and act on the reply.
 *
 * The search itself never runs here [W6-10]; this only asks.
 */
function dispatch(request: ToWorker): void {
  void seam()
    .think(request)
    .then((reply) => {
      // A reply from a game that no longer exists is dropped, not played
      // [W6-16]. `thinking` is left alone: whatever superseded this request
      // already reset it.
      if (reply.generation !== generation) return;
      thinking = null;
      if (!reply.ok) {
        // [W6-15]. The throw propagates rather than a fallback move being
        // invented — same discipline as [U3-20], one boundary further out.
        setView(nextView());
        throw new Error(`the opponent failed to choose a move: ${reply.message}`);
      }
      lastChoice = reply.choice;
      // A curtailed search still played a legal move [W6-17]; it is a shortened
      // search, not an error.
      submit(reply.choice.action);
    });
}

/**
 * Deal from `seed`. Deliberately not exported: {@link startNewGame} is the whole
 * entry surface the interface needs, and an exported seeded entry point would
 * hand a component the route to a deal of its choosing that [U3-47] rules out.
 * A test that wants a recorded seed goes through the URL, which is the path that
 * ships.
 */
function startGame(seed: number): void {
  // `deal` resets the held state and builds the opening view; the request is
  // decided against that state *before* the view is published, so a new game
  // is one `setView` like every ply is [U3-42].
  const opening = deal(seed);
  const request = pendingRequest();
  setView(request === null ? opening : nextView());
  if (request !== null) dispatch(request);
}

/**
 * The new-game control's entry point [U3-47]: always a freshly generated seed,
 * never the one in the URL, so a URL that pins a deal pins the deal it was
 * loaded with rather than every game played afterwards.
 */
export function startNewGame(): void {
  startGame(freshSeed());
}

/**
 * Change who sits where, and deal [W6-3].
 *
 * Deliberately not applied to a game in progress. [0003 U3-65] says the
 * position only ever moves forward from a `newGame`, and a game half-played by
 * a person and half by a program is one whose seed no longer describes a match
 * — which is exactly what [0003 U3-14] shows the seed for.
 */
export function startWithSeating(next: Seating): void {
  seating = next;
  startGame(freshSeed());
}

/** Whether a seat is played by the computer — for the components [W6-22]. */
export function computerSeat(seat: Player): boolean {
  return isComputer(seating, seat);
}

/**
 * Advance the game [U3-18]. Takes an action and nothing else, and learns
 * nothing about who chose it, so a move from a person and a move from a program
 * are the same call [U3-31].
 *
 * There is deliberately no legality guard: an illegal action reaches `apply`
 * and the engine's throw propagates [U3-20]. Swallowing it would hide a view
 * that has drifted from the rules, which is the one defect this package is
 * arranged to prevent.
 */
export function submit(action: number): void {
  apply(state, action);
  publish();
}
