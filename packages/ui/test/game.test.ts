/**
 * The engine seam: the held state, `submit`, and what `publish` derives.
 *
 * The engine module is wrapped so that `newGame` and `applyExplained` can be
 * counted and the state `newGame` returned can be captured. [U3-80] sanctions
 * exactly this, and for the reason it gives: [U3-5], [U3-18] and [U3-65] are
 * properties of a *history*, and no snapshot of a position can show them.
 * Capturing the state is also how [U3-63] is asserted without a back door — the
 * engine mutates in place [0001 E1-51], so the captured reference stays the
 * held state.
 *
 * [U3-1] has no test here and needs none: "no component reads the state" is a
 * statement about source, and [U3-75]'s source check owns it — the state binding
 * is not exported at all, so there is nothing for a component to import.
 */

import type { AzulState } from 'engine';
import { flush } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({
  newGame: vi.fn(),
  applyExplained: vi.fn(),
  states: [] as AzulState[],
}));

vi.mock('engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('engine')>();
  return {
    ...actual,
    newGame: (seed: number) => {
      engine.newGame(seed);
      const state = actual.newGame(seed);
      engine.states.push(state);
      return state;
    },
    applyExplained: (state: AzulState, action: number) => {
      engine.applyExplained(state, action);
      return actual.applyExplained(state, action);
    },
  };
});

const { toJSON } = await import('engine');

type Game = typeof import('../src/game.js');

/** The state the interface is holding: the last one `newGame` handed it. */
function held(): AzulState {
  return engine.states[engine.states.length - 1];
}

/**
 * Load the module afresh at a given URL. `src/game.ts` deals on import, which
 * is [U3-16]'s "a reload deals a fresh game" — so a fresh import is the only
 * honest way to exercise the seed handling of [U3-13] and it goes through the
 * production path rather than a test-only entry point.
 */
async function load(search = ''): Promise<Game> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  engine.states.length = 0;
  engine.newGame.mockClear();
  engine.applyExplained.mockClear();
  return import('../src/game.js');
}

/** Play one ply with whatever the engine says is legal, and commit the write. */
function step(game: Game, pick = 0): number {
  const action = game.view().game.legalActions[pick];
  game.submit(action);
  flush();
  return action;
}

let randomSeed = 0;
beforeEach(() => {
  randomSeed = 0;
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array: ArrayBufferView<ArrayBuffer>) => {
    (array as Uint32Array)[0] = randomSeed;
    return array;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('seeding', () => {
  it('[U3-13] takes an integer seed in range from the URL', async () => {
    const game = await load('?seed=42');
    expect(game.view().seed).toBe(42);
    expect(engine.newGame).toHaveBeenCalledWith(42);
  });

  it('[U3-13] accepts the ends of [0, 2**32)', async () => {
    expect((await load('?seed=0')).view().seed).toBe(0);
    expect((await load('?seed=4294967295')).view().seed).toBe(2 ** 32 - 1);
  });

  it.each([
    ['banana', 'not a number at all — `NaN | 0` is 0'],
    ['', 'present but empty'],
    ['-1', 'negative'],
    ['1.5', 'not an integer'],
    ['0x10', 'Number would take it, we do not'],
    [' 12 ', 'Number would take it, we do not'],
    ['12abc', 'parseInt would take it, we do not'],
    ['4294967296', 'one past the top of the range'],
    ['1e3', 'an integer value, but not a plain decimal seed'],
  ])('[U3-13] discards ?seed=%j and generates one instead (%s)', async (raw) => {
    randomSeed = 777;
    const game = await load(`?seed=${raw}`);
    expect(game.view().seed).toBe(777);
    expect(crypto.getRandomValues).toHaveBeenCalled();
  });

  it('[U3-13] generates a seed from crypto when the URL carries none', async () => {
    randomSeed = 2 ** 32 - 1;
    const game = await load();
    expect(game.view().seed).toBe(2 ** 32 - 1);
    const [buffer] = vi.mocked(crypto.getRandomValues).mock.calls[0];
    expect(buffer).toBeInstanceOf(Uint32Array);
  });

  it('[U3-14] republishes the seed on every ply', async () => {
    const game = await load('?seed=42');
    step(game);
    expect(game.view().seed).toBe(42);
  });

  it('[U3-16] a seed reproduces the deal, and the game restarts from the opening', async () => {
    const first = await load('?seed=42');
    step(first);
    const opening = first.view().game;
    const second = await load('?seed=42');
    expect(second.view().game).toEqual(await openingOf(42));
    expect(second.view().game).not.toEqual(opening);
  });
});

/** The opening position for a seed, dealt by the engine rather than by us. */
async function openingOf(seed: number): Promise<unknown> {
  const actual = await vi.importActual<typeof import('engine')>('engine');
  return toJSON(actual.newGame(seed));
}

describe('one state per game', () => {
  it('[U3-5] [U3-12] calls newGame once and creates the state no other way', async () => {
    const game = await load('?seed=42');
    expect(engine.newGame).toHaveBeenCalledTimes(1);
    step(game);
    step(game);
    expect(engine.newGame).toHaveBeenCalledTimes(1);
  });

  it('[U3-65] only ever advances the held state with applyExplained', async () => {
    // [U3-18], widened: `applyExplained` is the entry point `submit` takes, and
    // it is the *only* one — a ply that also went through `apply` would be a
    // second path into the held state [0007 S7-2].
    const game = await load('?seed=42');
    const state = held();
    const played = [step(game), step(game), step(game)];
    expect(engine.applyExplained.mock.calls.map((c) => c[1])).toEqual(played);
    expect(engine.applyExplained.mock.calls.every((c) => c[0] === state)).toBe(true);
    expect(held()).toBe(state);
  });

  it('[U3-47] a new game takes a fresh seed, never the one in the URL', async () => {
    const game = await load('?seed=42');
    randomSeed = 99;
    game.startNewGame();
    flush();
    expect(game.view().seed).toBe(99);
    expect(engine.newGame).toHaveBeenCalledTimes(2);
    expect(engine.newGame).toHaveBeenLastCalledWith(99);
  });
});

describe('submit', () => {
  it('[U3-18] [U3-31] takes an action and nothing else', async () => {
    const game = await load('?seed=42');
    expect(game.submit.length).toBe(1);
    const action = step(game);
    expect(engine.applyExplained).toHaveBeenCalledExactlyOnceWith(held(), action);
  });

  it('[U3-20] does not guard: the engine throw propagates', async () => {
    const game = await load('?seed=42');
    const illegal = [...Array(180).keys()].find((a) => !game.view().game.legalActions.includes(a));
    expect(() => game.submit(illegal as number)).toThrow();
  });

  it('[U3-20] a rejected action leaves the published view untouched', async () => {
    const game = await load('?seed=42');
    const before = game.view();
    expect(() => game.submit(180)).toThrow();
    flush();
    expect(game.view()).toBe(before);
  });
});

describe('publish', () => {
  it('[U3-63] the published game deep-equals toJSON of the held state, from the opening on', async () => {
    const game = await load('?seed=42');
    expect(game.view().game).toEqual(toJSON(held()));
    for (let ply = 0; ply < 12; ply++) {
      step(game);
      expect(game.view().game).toEqual(toJSON(held()));
    }
  });

  it('[U3-4] publishes floorOccupied from the engine, for both players', async () => {
    const actual = await vi.importActual<typeof import('engine')>('engine');
    const game = await load('?seed=42');
    for (let ply = 0; ply < 12; ply++) {
      step(game);
      expect(game.view().floorOccupied).toEqual([
        actual.floorOccupied(held(), 0),
        actual.floorOccupied(held(), 1),
      ]);
    }
  });

  it('[U3-2] [U3-21] replaces the view model wholesale with plain data, and does not mutate the previous one', async () => {
    const game = await load('?seed=42');
    const before = game.view();
    // structuredClone throws on anything that is not plain, cloneable data [U3-2].
    const snapshot = structuredClone(before);
    step(game);
    expect(game.view()).not.toBe(before);
    expect(before).toEqual(snapshot);
  });
});

describe('round transitions', () => {
  /** Play until `stop` says so, or until the game ends. */
  function playUntil(game: Game, stop: () => boolean, limit = 400): void {
    for (let ply = 0; ply < limit; ply++) {
      if (stop() || game.view().game.isTerminal) return;
      step(game);
    }
    throw new Error('no transition within the ply limit');
  }

  it('[U3-39] [U3-42] reports the transition on the ply that causes it, and only then', async () => {
    const game = await load('?seed=42');
    const opening = game.view().game.round;
    expect(game.view().transition).toBeNull();

    playUntil(game, () => game.view().transition !== null);
    const transition = game.view().transition;
    expect(transition).not.toBeNull();
    expect(game.view().game.round).toBeGreaterThan(opening);

    step(game);
    expect(game.view().transition).toBeNull();
  });

  it('[U3-42] newlyPlaced marks exactly the wall cells this transition set', async () => {
    const game = await load('?seed=42');
    let wallBefore = flatWalls(game.view().game);
    playUntil(game, () => {
      if (game.view().transition !== null) return true;
      wallBefore = flatWalls(game.view().game);
      return false;
    });

    const { newlyPlaced } = game.view().transition!;
    const wallAfter = flatWalls(game.view().game);
    for (const p of [0, 1]) {
      expect(newlyPlaced[p]).toHaveLength(25);
      expect(newlyPlaced[p]).toEqual(wallAfter[p].map((c, i) => (c && !wallBefore[p][i] ? 1 : 0)));
      expect(newlyPlaced[p].some((c) => c === 1)).toBe(true);
    }
  });

  it('[U3-42] scoreDelta is each player’s score change across the transition', async () => {
    const game = await load('?seed=42');
    let scoresBefore = game.view().game.scores;
    playUntil(game, () => {
      if (game.view().transition !== null) return true;
      scoresBefore = game.view().game.scores;
      return false;
    });
    const after = game.view().game.scores;
    expect(game.view().transition!.scoreDelta).toEqual([
      after[0] - scoresBefore[0],
      after[1] - scoresBefore[1],
    ]);
  });

  it('[U3-39] [U3-42] the final ply reports a transition with ended set', async () => {
    const game = await load('?seed=42');
    playUntil(game, () => game.view().game.isTerminal);
    expect(game.view().game.isTerminal).toBe(true);
    expect(game.view().transition).not.toBeNull();
    expect(game.view().transition!.ended).toBe(true);
  });

  it('[U3-41] the retained view model does not survive into the next diff', async () => {
    const game = await load('?seed=42');
    playUntil(game, () => game.view().transition !== null);
    step(game);
    expect(game.view().transition).toBeNull();
    step(game);
    expect(game.view().transition).toBeNull();
  });
});

/** `[2][25]` flat row-major walls, for comparing what a transition placed. */
function flatWalls(game: { players: { wall: number[][] }[] }): number[][] {
  return game.players.map((p) => p.wall.flat());
}
