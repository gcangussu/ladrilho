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
  NUM_COLORS,
  NUM_ROWS,
  apply,
  floorOccupied,
  newGame,
  toJSON,
} from 'engine';
import { createSignal } from 'solid-js';

/** What a transition put on the wall and what it cost [U3-42]. */
export interface Transition {
  /** `[2][25]`, flat row-major [0001 E1-2]: the cells this transition set. */
  newlyPlaced: number[][];
  scoreDelta: number[];
  ended: boolean;
}

/** Everything a component may read that derives from the game state [U3-6]. */
export interface ViewModel {
  game: AzulJSON;
  /** `[2]`, from `floorOccupied` — the engine's answer, not our arithmetic [U3-4]. */
  floorOccupied: number[];
  /** The seed this game was dealt from [U3-14]. */
  seed: number;
  /** Set on exactly one ply, `null` on every other [U3-42]. */
  transition: Transition | null;
}

/**
 * Held, never observed, never exported [U3-1]. Exactly one per game [U3-5],
 * produced only by `newGame` [U3-12], and only ever advanced by `apply` — which
 * is what makes [U3-65] true, and what makes there be no undo [U3-17].
 */
let state: AzulState;

/** The seed `state` was dealt from, republished on every ply [U3-14]. */
let currentSeed: number;

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
  };
  previous = next;
  return next;
}

/** Deal a game and return its opening view. The only `newGame` call [U3-5], [U3-12]. */
function deal(seed: number): ViewModel {
  state = newGame(seed);
  currentSeed = seed;
  previous = null;
  return nextView();
}

const [view, setView] = createSignal<ViewModel>(deal(seedFromUrl(location.search) ?? freshSeed()));

/** The published view model — the only state-derived thing a component reads [U3-6]. */
export { view };

/** Replace the view model wholesale; never mutate the one it replaces [U3-21]. */
function publish(): void {
  setView(nextView());
}

/**
 * Deal from `seed`. Deliberately not exported: {@link startNewGame} is the whole
 * entry surface the interface needs, and an exported seeded entry point would
 * hand a component the route to a deal of its choosing that [U3-47] rules out.
 * A test that wants a recorded seed goes through the URL, which is the path that
 * ships.
 */
function startGame(seed: number): void {
  setView(deal(seed));
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
