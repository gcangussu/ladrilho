/**
 * The computer opponent in the interface: *0006 — Opponent in the interface*.
 *
 * Nearly every test runs against the injected seam of [W6-18] rather than a
 * real worker, because jsdom has no `Worker`. That is not a shortcut — without
 * the seam every requirement in 0006 would fall to the slow browser lane of
 * [0003 U3-73] and the property test of [W6-29] would not exist. The real
 * worker is exercised there, by [W6-30]. The exceptions are near the end: the
 * real seam, `workerThinker`, driven against a stand-in `Worker` [W6-42],
 * because an injected seam cannot show how the real one routes its replies.
 *
 * The seam resolves through a **deferred** promise, never immediately. One that
 * answered synchronously would make [W6-32] vacuous: the loop could never
 * observe a request outstanding, so "at most one" would hold because there was
 * never one to collide with.
 *
 * The interface is mounted by importing it afresh at a chosen URL, the route
 * `turn.test.tsx` uses: `src/game.ts` deals on import [0003 U3-16], so a fresh
 * import is a reload. Controls are found by accessible role and name
 * [0003 U3-68], through the same helpers the components label them with.
 */

import { render } from '@solidjs/testing-library';
import { flush } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CENTER, apply, decodeAction, legalActions, newGame, toJSON, type AzulJSON } from 'engine';
import { pickName, picksIn } from '../src/components/Displays.jsx';
import { floorLineName } from '../src/components/FloorLine.jsx';
import { patternLineName } from '../src/components/PatternLines.jsx';
import {
  EXPERT_AVAILABLE,
  seatingFromUrl,
  seatingToUrl,
  workerThinker,
  type FromWorker,
  type Thinker,
  type ToWorker,
} from '../src/opponent.js';

/**
 * A seam that queues requests and answers only when told to.
 *
 * `terminate` abandons every request outstanding at that moment, as the real
 * seam does ([W6-42]): `answer` and `fail` refuse one, because a harness that
 * settles what the shipped client never settles tests a situation that cannot
 * arise [W6-18]. `answerAbandoned` is the one deliberate exception, for
 * [W6-37], which asks the suite to resolve a stale response on purpose — the
 * generation filter of [W6-16] is the second line behind [W6-13], and it is
 * only reachable from a seam that misbehaves.
 */
function deferredThinker(): {
  seam: Thinker;
  pending: ToWorker[];
  answer(index?: number): Promise<void>;
  answerAbandoned(index: number): Promise<void>;
  fail(message: string, index?: number): void;
  terminations: () => number;
} {
  const pending: ToWorker[] = [];
  const resolvers: ((reply: FromWorker) => void)[] = [];
  const abandoned = new Set<number>();
  let terminations = 0;

  const live = (index: number): void => {
    if (abandoned.has(index)) {
      throw new Error(`request ${index} was abandoned by terminate; the real seam never settles it`);
    }
  };

  async function settle(index: number): Promise<void> {
    const request = pending[index];
    resolvers[index]({
      generation: request.generation,
      ok: true,
      choice: {
        action: request.position.legalActions[0],
        value: 0,
        depth: 1,
        nodes: 1,
        complete: false,
        curtailed: false,
      },
    });
    // Two turns of the microtask queue: one for the seam's promise, one for
    // the `.then` in the state module that submits the move.
    await Promise.resolve();
    await Promise.resolve();
    flush();
  }

  return {
    seam: {
      think(request) {
        pending.push(request);
        return new Promise<FromWorker>((resolve) => resolvers.push(resolve));
      },
      terminate() {
        terminations++;
        for (let i = 0; i < pending.length; i++) abandoned.add(i);
      },
    },
    pending,
    answer(index = 0) {
      live(index);
      return settle(index);
    },
    answerAbandoned(index) {
      return settle(index);
    },
    fail(message, index = 0) {
      live(index);
      resolvers[index]({ generation: pending[index].generation, ok: false, message });
    },
    terminations: () => terminations,
  };
}

type Harness = ReturnType<typeof deferredThinker>;
type Screen = ReturnType<typeof render>;
type StateModule = typeof import('../src/game.js');

/**
 * Mount the interface on a fresh game with the seam injected.
 *
 * The seam goes in **before** any seating that would make the computer move, or
 * the state module would reach for a real `Worker` on the opening position and
 * jsdom has none.
 */
async function load(search = '?seed=42'): Promise<{ state: StateModule; harness: Harness }> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  const state = (await import('../src/game.js')) as StateModule;
  const harness = deferredThinker();
  // The seam goes in synchronously, in the turn the import resolved on — the
  // module's opening ask is deferred by a task, so this lands first and the
  // real `Worker` is never reached. Waiting for that task below is what makes
  // these tests exercise the *production* start-up path rather than a loop
  // kicked by the injection itself, which is what hid the missing opening ask.
  state.useThinker(harness.seam);
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
  return { state, harness };
}

/**
 * As {@link load}, plus the rendered interface.
 *
 * Separate because rendering is the expensive half and most of these tests
 * never look at the DOM — mounting the App for all of them put this file, and
 * with it the suite, over [0003 U3-77]'s budget.
 */
async function mount(search = '?seed=42'): Promise<{
  screen: Screen;
  state: StateModule;
  harness: Harness;
}> {
  const { state, harness } = await load(search);
  const { App } = await import('../src/components/App.jsx');
  const screen = render(() => <App />);
  flush();
  return { screen, state, harness };
}

beforeEach(() => {
  // Solid's testing library unmounts between tests; `vi.resetModules` in
  // `mount` is what keeps one test's held state out of the next.
  vi.resetModules();
});

describe('choosing an opponent [W6-1], [W6-2], [W6-3], [W6-4]', () => {
  it('[W6-38] [W6-4] honours a seating carried in the URL', async () => {
    const { state } = await load('?seed=42&seating=human-steady');
    expect(state.view().seating.players).toEqual([null, 'steady']);
    expect(state.computerSeat(1)).toBe(true);
    expect(state.computerSeat(0)).toBe(false);
  });

  /**
   * Parsed directly rather than through a mount.
   *
   * `seatingFromUrl` is a pure function of a query string, and `mount` costs a
   * module reset plus two dynamic imports — spending seven of those to check
   * seven strings put this file, and with it the whole suite, over
   * [0003 U3-77]'s budget. The end-to-end path is covered by the mount above,
   * once, which is all it needs to be.
   */
  it('[W6-38] [W6-4] discards a malformed seating, as [0003 U3-13] discards a seed', () => {
    for (const bad of ['banana', 'easy', 'easy-banana', 'easy-steady-sharp', '', '-', 'human']) {
      expect(seatingFromUrl(`?seating=${bad}`), bad).toBeNull();
    }
    expect(seatingFromUrl('?seed=42')).toBeNull();
  });

  it('[W6-5] [W6-4] lets a person occupy either seat', () => {
    expect(seatingFromUrl('?seating=sharp-human')?.players).toEqual(['sharp', null]);
    expect(seatingFromUrl('?seating=human-sharp')?.players).toEqual([null, 'sharp']);
    expect(seatingFromUrl('?seating=human-human')?.players).toEqual([null, null]);
    expect(seatingFromUrl('?seating=easy-steady')?.players).toEqual(['easy', 'steady']);
    // And the inverse, so a game can be linked to [W6-4].
    expect(seatingToUrl({ players: ['sharp', null] })).toBe('sharp-human');
    expect(seatingToUrl({ players: [null, 'easy'] })).toBe('human-easy');
  });

  it('[W6-3] deals a new game when the seating changes', async () => {
    const { state } = await load('?seed=42');
    const before = state.view().seed;
    state.startWithSeating({ players: [null, 'easy'] });
    flush();
    const after = state.view();
    expect(after.seed).not.toBe(before);
    expect(after.game.round).toBe(0);
    expect(after.game.scores).toEqual([0, 0]);
  });

  it('[W6-2] publishes the seating', async () => {
    const { state } = await load('?seed=42&seating=easy-sharp');
    expect(state.view().seating.players).toEqual(['easy', 'sharp']);
  });
});

describe('the turn loop [W6-6], [W6-7], [W6-8]', () => {
  it('[W6-6] asks for a move as soon as the computer is to move', async () => {
    const { harness } = await load('?seed=42&seating=easy-human');
    expect(harness.pending).toHaveLength(1);
    expect(harness.pending[0].tier).toBe('easy');
    expect(harness.pending[0].position.currentPlayer).toBe(0);
  });

  it('[W6-6] [W6-13] asks for nothing in a two-person game', async () => {
    const { harness } = await load('?seed=42');
    expect(harness.pending).toHaveLength(0);
  });

  it('[W6-32] [W6-7] keeps at most one request outstanding', async () => {
    const { harness } = await load('?seed=42&seating=easy-easy');
    // Both seats are the computer, so an unguarded loop would run away — the
    // seam is deliberately still holding the first promise.
    expect(harness.pending).toHaveLength(1);
    flush();
    expect(harness.pending).toHaveLength(1);
    await harness.answer(0);
    expect(harness.pending).toHaveLength(2);
  });

  /**
   * The assertion that actually defends the guard [W6-7], [W6-32].
   *
   * The four assertions in the test above hold with the `thinking` guard
   * removed — verified — because the loop is one-ask-per-publish
   * architecturally and nothing there provokes a second ask while one is
   * outstanding. This does: `startNewGame` asks synchronously while the opening
   * ask is still sitting in its deferred task. Both would carry the *same*
   * generation, so [W6-16] cannot tell them apart and the guard is the only
   * thing between one request and two.
   */
  it('[W6-32] [W6-7] does not race the deferred opening ask', async () => {
    history.replaceState({}, '', '/?seed=42&seating=easy-human');
    vi.resetModules();
    const state = (await import('../src/game.js')) as StateModule;
    const harness = deferredThinker();
    state.useThinker(harness.seam);

    // Synchronously, before the deferred opening ask has run.
    state.startNewGame();
    flush();
    expect(harness.pending, 'the new game did not ask').toHaveLength(1);

    // Now let the opening task fire. It must find a request outstanding and
    // add nothing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
    expect(harness.pending, 'the deferred opening ask raced the new game').toHaveLength(1);
  });

  it('[W6-8] [W6-34] submits a move that was legal in the position it asked about', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-human');
    const asked = harness.pending[0].position;
    const before = state.view().game.tilesLeft;
    await harness.answer();
    const after = state.view().game;
    expect(asked.legalActions).toContain(state.view().lastChoice!.action);
    expect(after.tilesLeft).toBeLessThan(before);
    expect(after.currentPlayer).toBe(1);
  });

  it('[W6-9] two computers play on until the game is terminal', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-easy');
    let answered = 0;
    while (!state.view().game.isTerminal && answered < 400) {
      await harness.answer(answered);
      answered++;
    }
    expect(state.view().game.isTerminal).toBe(true);
    expect(answered).toBeGreaterThan(20);
  }, 30_000);
});

/**
 * The coverage hole that let a real regression through: every existing
 * transition test is hot-seat, so nothing exercised a publish with the computer
 * next to move — which is exactly when the transition was being dropped.
 */
describe('round transitions survive a computer opponent [0003 U3-42]', () => {
  /** Play to the end, collecting every published transition. */
  async function transitionsOver(search: string): Promise<number> {
    const { state, harness } = await load(search);
    let published = 0;
    let seen = 0;
    let answered = 0;
    let plies = 0;
    while (!state.view().game.isTerminal && plies < 400) {
      const before = state.view().game;
      if (state.view().thinking !== null) {
        await harness.answer(answered);
        answered++;
      } else {
        state.submit(state.view().game.legalActions[0]);
        flush();
      }
      const after = state.view();
      // [0003 U3-39]: a transition happened when the round advanced or the
      // game ended. Counted from the games themselves, independently of
      // whether the view model reported one.
      if (after.game.round > before.round || (after.game.isTerminal && !before.isTerminal)) {
        seen++;
        if (after.transition !== null) published++;
      } else {
        // [0003 U3-42]: null on every other ply.
        expect(after.transition).toBeNull();
      }
      plies++;
    }
    expect(seen, `${search}: no transition happened at all`).toBeGreaterThan(2);
    return published === seen ? seen : -1;
  }

  it('[0003 U3-42] publishes one on every transition, computer to move or not', async () => {
    // Two seatings, because the loss depended on who moved next: with two
    // computers every non-terminal transition vanished, and with one it was
    // about half of them. Only the terminal one survived, because the loop
    // returns early on a finished game. A third seating is a third whole game
    // for no extra coverage.
    for (const seating of ['human-easy', 'easy-easy']) {
      const result = await transitionsOver(`?seed=42&seating=${seating}`);
      expect(result, `${seating}: a transition happened without being published`).toBeGreaterThan(
        2,
      );
    }
  }, 30_000);
});

describe('while it thinks [W6-19], [W6-20], [W6-33]', () => {
  it('[W6-33] [W6-19] publishes thinking exactly while a request is outstanding', async () => {
    const { state, harness } = await load('?seed=42&seating=steady-human');
    expect(state.view().thinking).toEqual({ seat: 0 });
    await harness.answer();
    expect(state.view().thinking).toBeNull();
  });

  it('[W6-20] says so on screen and in the live region, naming the seat', async () => {
    const { screen } = await mount('?seed=42&seating=sharp-human');
    // Twice on purpose: once visibly in the status, once in the live region a
    // screen reader hears [0003 U3-56]. `getAllByText` rather than `getByText`,
    // which would fail precisely because both are present.
    expect(screen.getAllByText(/Player 1 is thinking/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('status').textContent).toMatch(/Player 1 is thinking/i);
  });

  it('[W6-21] shows nothing when no request is outstanding', async () => {
    const { screen } = await mount('?seed=42');
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });

  it('[W6-22] makes every move control unavailable while the computer is to move', async () => {
    const { screen, state } = await mount('?seed=42&seating=sharp-human');
    const game = state.view().game;
    const names = game.colorNames;
    let checked = 0;
    for (const [source, pool] of [
      ...game.factories.map((pool, source) => [source, pool] as const),
      [CENTER, game.center] as const,
    ]) {
      for (const pick of picksIn([...pool], source)) {
        const control = screen.getByRole('button', { name: pickName(pick, names) });
        // Present, focusable and inert rather than removed — [0003 U3-29].
        expect(control.getAttribute('aria-disabled'), pickName(pick, names)).toBe('true');
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('[W6-23] leaves the new-game control available mid-search', async () => {
    const { screen } = await mount('?seed=42&seating=sharp-human');
    const control = screen.getByRole('button', { name: /new game/i });
    expect(control.getAttribute('aria-disabled')).not.toBe('true');
    expect((control as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('stale and failed replies [W6-15], [W6-16], [W6-17]', () => {
  it('[W6-37] [W6-16] discards a reply from a game that no longer exists', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-human');
    const stale = harness.pending[0];

    state.startWithSeating({ players: ['easy', null] });
    flush();
    expect(harness.pending.length).toBeGreaterThan(1);
    const fresh = state.view().game.tilesLeft;
    expect(harness.pending[1].generation).not.toBe(stale.generation);

    // Answering the *old* request must not advance the *new* game. The deal
    // abandoned it, so the shipped seam would never deliver this [W6-42];
    // the harness is made to, because the filter must hold even if it did.
    await harness.answerAbandoned(0);
    expect(state.view().game.tilesLeft).toBe(fresh);
  });

  /**
   * Both halves of [W6-15]: the failure **propagates**, and no move is invented.
   *
   * The propagation is caught here rather than left to escape. A throw from
   * inside the turn loop's promise surfaces as an unhandled rejection — in a
   * browser that reaches `window.onunhandledrejection` and the console, which
   * is what "propagates" means across this boundary. Letting it escape the
   * suite would fail the run for the right reason in the wrong place, and
   * asserting only "no ply was made" would pass just as well against a client
   * that swallowed the error silently, which is the defect [W6-15] exists to
   * prevent.
   */
  it('[W6-37] [W6-15] propagates the failure and makes no ply', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-human');
    const before = state.view().game.tilesLeft;

    const rejections: unknown[] = [];
    const capture = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', capture);
    try {
      harness.fail('the search exploded');
      // A macrotask, so Node has run its unhandled-rejection check.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', capture);
    }
    flush();

    expect(
      rejections.map(String).join(' '),
      'the failure was swallowed instead of propagating',
    ).toMatch(/the search exploded/);
    expect(state.view().game.tilesLeft).toBe(before);
    expect(state.view().thinking).toBeNull();
  });

  it('[W6-17] submits a curtailed choice — a shortened search, not an error', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-human');
    const request = harness.pending[0];
    const before = state.view().game.tilesLeft;
    await harness.answer();
    expect(state.view().game.tilesLeft).toBeLessThan(before);
    expect(request.position.legalActions).toContain(state.view().lastChoice!.action);
  });
});

/**
 * A stand-in for the browser's `Worker`, which jsdom does not have, so the
 * *real* seam — `workerThinker` — can run in the fast suite.
 *
 * Everything above injects a seam with a resolver per request, and that is
 * exactly why a real defect went unseen: the real seam put one listener per
 * request on one shared worker, each taking the first reply of any kind, so a
 * request issued while another was outstanding took the other's reply and its
 * own arrived to nobody. An injected seam cannot cross its wires that way.
 *
 * It behaves as the real one does in the ways that matter here: it answers in
 * the order it was asked, one reply per request, and once terminated it
 * answers nothing at all.
 */
class StubWorker extends EventTarget {
  static made: StubWorker[] = [];
  readonly posted: ToWorker[] = [];
  terminated = false;
  private replied = 0;

  constructor() {
    super();
    StubWorker.made.push(this);
  }

  postMessage(request: ToWorker): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answer the oldest unanswered request with its first legal move. */
  reply(): void {
    if (this.terminated) return;
    const request = this.posted[this.replied++];
    const data: FromWorker = {
      generation: request.generation,
      ok: true,
      choice: {
        action: request.position.legalActions[0],
        value: 0,
        depth: 1,
        nodes: 1,
        complete: false,
        curtailed: false,
      },
    };
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  /** Answer everything still queued, in order — a worker left to finish. */
  replyAll(): void {
    while (!this.terminated && this.replied < this.posted.length) this.reply();
  }
}

/** A task, by which every reply delivered so far has been acted on. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A request as the state module would send it. */
function request(generation: number): ToWorker {
  return { generation, position: toJSON(newGame(7)), tier: 'easy' };
}

/** The state module, freshly dealt at `search`, with the real seam left in place. */
async function loadReal(search: string): Promise<StateModule> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  const state = (await import('../src/game.js')) as StateModule;
  await settle();
  flush();
  return state;
}

describe('the worker ends with its game [W6-13], [W6-23]', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    StubWorker.made.length = 0;
  });

  // Seen red, on a copy, with `thinker?.terminate()` deleted from `deal`.
  it('[W6-13] [W6-23] terminates the seam on a new game or a seating change mid-search', async () => {
    const { state, harness } = await load('?seed=42&seating=sharp-human');
    expect(harness.pending).toHaveLength(1);
    expect(harness.terminations()).toBe(0);

    // A seating change while the opening search is outstanding.
    state.startWithSeating({ players: ['easy', null] });
    flush();
    expect(harness.terminations(), 'a seating change left the search running').toBe(1);
    expect(harness.pending).toHaveLength(2);

    // And New Game while that one is outstanding — the way out of a long think.
    state.startNewGame();
    flush();
    expect(harness.terminations(), 'New Game left the search running').toBe(2);
    expect(harness.pending).toHaveLength(3);

    // The two abandoned requests are never answered — the real seam drops
    // them with the worker [W6-42] — and the live one is still played.
    const tiles = state.view().game.tilesLeft;
    await harness.answer(2);
    expect(state.view().game.tilesLeft).toBeLessThan(tiles);
    expect(state.view().thinking).toBeNull();
  });

  /**
   * The freeze, end to end through the real seam: New Game mid-search, and
   * the old worker then finishing what it was asked before the new request.
   *
   * Either half of the fix alone keeps it green, so it goes red only when both
   * are gone — `deal` not ending the worker, *and* the seam letting one
   * request take another's reply — or when `terminate` leaves the dead worker
   * in place, so the new game asks something that will never answer. Each of
   * those has its own test; this one is the user-visible symptom.
   *
   * Seen red, on a copy: both halves reverted together (and each alone,
   * green); `live = null` deleted from `terminate`.
   */
  it('[W6-23] [W6-42] answers a new game dealt mid-search, whatever the old worker had queued', async () => {
    vi.stubGlobal('Worker', StubWorker);
    const state = await loadReal('?seed=42&seating=easy-human');
    expect(state.view().thinking).toEqual({ seat: 0 });
    expect(StubWorker.made).toHaveLength(1);

    state.startNewGame();
    flush();
    const tiles = state.view().game.tilesLeft;

    for (const worker of StubWorker.made) worker.replyAll();
    await settle();
    flush();
    expect(state.view().game.tilesLeft, 'the new game froze waiting for its reply').toBeLessThan(
      tiles,
    );
    expect(state.view().thinking).toBeNull();
  });

  it('[W6-13] never builds a worker in a two-person game, new games included', async () => {
    vi.stubGlobal('Worker', StubWorker);
    const state = await loadReal('?seed=42');
    state.startNewGame();
    state.startWithSeating({ players: [null, null] });
    await settle();
    flush();
    expect(StubWorker.made, 'dealing a two-person game spawned a worker').toHaveLength(0);
  });
});

describe('the real seam [W6-11], [W6-42]', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    StubWorker.made.length = 0;
  });

  // Seen red, on a copy, with the message listener settling every pending
  // request on the first reply — the listener-per-request design it replaced.
  it('[W6-42] hands each reply to the request it answers, and to no other', async () => {
    vi.stubGlobal('Worker', StubWorker);
    const seam = workerThinker();
    expect(StubWorker.made, 'a worker before anything was asked [W6-13]').toHaveLength(0);

    const got: { a: FromWorker | null; b: FromWorker | null } = { a: null, b: null };
    void seam.think(request(1)).then((reply) => (got.a = reply));
    void seam.think(request(2)).then((reply) => (got.b = reply));
    expect(StubWorker.made).toHaveLength(1);
    const [worker] = StubWorker.made;

    worker.reply();
    await settle();
    expect(got.a?.generation).toBe(1);
    expect(got.b, 'the second request took the first one’s reply').toBeNull();

    worker.reply();
    await settle();
    expect(got.b?.generation).toBe(2);
  });

  // Seen red, on a copy, with the generation match replaced by oldest-first.
  it('[W6-42] drops a reply nobody is waiting for, rather than handing it to whoever is', async () => {
    // Taking replies oldest-first without reading them would pass the test
    // above, because the stub answers in order. It fails here.
    vi.stubGlobal('Worker', StubWorker);
    const seam = workerThinker();
    let got: FromWorker | null = null;
    void seam.think(request(3)).then((reply) => (got = reply));
    const [worker] = StubWorker.made;

    const stray: FromWorker = { generation: 2, ok: false, message: 'a reply from another game' };
    worker.dispatchEvent(new MessageEvent('message', { data: stray }));
    await settle();
    expect(got, 'a request was settled by a reply to a different generation').toBeNull();

    worker.reply();
    await settle();
    expect(got).toMatchObject({ generation: 3, ok: true });
  });

  // Seen red, on a copy, with `live = null` deleted from `terminate`, and with
  // `terminate` calling `ensure()` in place of `live?.`.
  it('[W6-13] [W6-42] terminates the worker, and builds the next only when asked', async () => {
    vi.stubGlobal('Worker', StubWorker);
    const seam = workerThinker();
    let abandoned = false;
    void seam.think(request(1)).then(() => (abandoned = true));
    const [first] = StubWorker.made;

    seam.terminate();
    seam.terminate(); // idempotent [W6-13]
    expect(first.terminated).toBe(true);
    expect(StubWorker.made, 'terminating built a worker').toHaveLength(1);

    const fresh = seam.think(request(2));
    expect(StubWorker.made, 'the next request went to the terminated worker').toHaveLength(2);
    StubWorker.made[1].reply();
    expect((await fresh).generation).toBe(2);

    // A reply the old worker posted before it was terminated, delivered
    // after — `StubWorker.reply` refuses once terminated, so dispatched by
    // hand. Seen red, on a copy, with the `splice` deleted from `terminate`.
    first.dispatchEvent(
      new MessageEvent('message', {
        data: {
          generation: 1,
          ok: true,
          choice: { action: 0, value: 0, depth: 1, nodes: 1, complete: false, curtailed: false },
        } satisfies FromWorker,
      }),
    );
    first.dispatchEvent(new ErrorEvent('error', { message: 'late' }));
    await settle();
    // The request outstanding at termination is abandoned, never settled: its
    // caller has already moved to a new generation and would drop it [W6-16].
    expect(abandoned).toBe(false);
  });

  it('[W6-15] [W6-42] fails an outstanding request on a worker error, under its own generation', async () => {
    vi.stubGlobal('Worker', StubWorker);
    const seam = workerThinker();
    const pending = seam.think(request(5));
    StubWorker.made[0].dispatchEvent(new ErrorEvent('error', { message: 'the module failed' }));
    expect(await pending).toEqual({ generation: 5, ok: false, message: 'the module failed' });
  });
});

describe('what crosses the boundary [W6-14]', () => {
  it('[W6-14] sends a plain view, never a state', async () => {
    const { harness } = await load('?seed=42&seating=easy-human');
    const request = harness.pending[0];
    // Structurally cloneable, which an `AzulState` is not — it holds an `Rng`.
    expect(structuredClone(request)).toEqual(request);
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    // The bag is counts, so there is no order here to leak [0004 B4-5].
    expect(request.position.bag).toHaveLength(5);
    expect('rng' in request.position).toBe(false);
    expect('shuffle' in request.position).toBe(false);
  });
});

/**
 * [W6-29]: a whole game through the *rendered* interface with one seat a tier,
 * from a recorded seed, asserting the invariants at every ply.
 *
 * The person's side plays among the available controls the way [0003 U3-70]
 * does, so both halves of a mixed game are exercised — and legality is checked
 * against an engine state driven in parallel, not against the view.
 */
describe('a whole game with a computer opponent [W6-29]', () => {
  // Once with a tier and once with the expert [W6-41]. The seam answers for
  // both, so what differs is only which level the request names — but that is
  // the whole of what the interface knows about the difference, and a loop
  // that never ran with `expert` would leave [W6-40]'s configuration
  // unexercised through the rendered interface.
  it.for(['easy', 'expert'] as const)(
    '[W6-29] [W6-32] [W6-34] [W6-41] plays through against %s, one request at a time',
    { timeout: 60_000 },
    async (level, { skip }) => {
      // `expert` is only a seating the URL accepts while the committed gate
      // says it passed ([0008 A8-33]). Skipped rather than failed the day a
      // rerun says otherwise: the case would quietly become hot-seat, and
      // `answered` would fail for a reason that has nothing to do with
      // [W6-29]. `skip` rather than an early return, so the reporter says so
      // too — a silently green case named for a player nobody can pick is the
      // same lie in a quieter font. `it.for` rather than `it.each` is what
      // makes that possible: it is the one that hands the callback a context,
      // and its options go before the callback, which is where the timeout
      // went.
      //
      // Seen to work: flipping this condition to `level === 'expert'` prints
      // `↓ … plays through against expert` and the run ends `23 passed | 1
      // skipped`, so the branch aborts before `mount` rather than after. It is
      // unreachable while the committed gate passes, and that flip is its
      // record.
      if (level === 'expert' && !EXPERT_AVAILABLE) skip();
    const { screen, state, harness } = await mount(`?seed=42&seating=human-${level}`);
    const parallel = newGame(state.view().seed);
    let answered = 0;
    let plies = 0;

    while (!state.view().game.isTerminal && plies < 400) {
      // [0003 U3-63]: the published view always describes the held state, and
      // the parallel engine agrees about what is legal.
      expect(state.view().game.legalActions).toEqual(legalActions(parallel));

      if (state.view().thinking !== null) {
        // [W6-32]: never more than one request outstanding.
        expect(harness.pending.length - answered).toBe(1);
        const asked = harness.pending[answered];
        expect(asked.position.legalActions).toEqual(legalActions(parallel));
        const action = asked.position.legalActions[0];
        await harness.answer(answered);
        answered++;
        apply(parallel, action);
      } else {
        const legal = legalActions(parallel);
        const action = legal[plies % legal.length];
        clickThrough(screen, state.view().game, action);
        apply(parallel, action);
      }
      plies++;
    }

    expect(state.view().game.isTerminal).toBe(true);
    expect(answered).toBeGreaterThan(10);
    // The requests really did name the level under test.
    expect(harness.pending[0].tier).toBe(level);
  },
  );
});

/**
 * [W6-36]. The opponent changes *who calls* `submit`, not what a ply is: the
 * held state is still only ever advanced by one engine entry point, from one
 * `newGame`. That entry point is now `applyExplained` [0003 U3-18].
 *
 * Spying on those two is sanctioned by [0003 U3-80] and is the only way to see
 * it — this is a property of a history, and no snapshot shows it.
 */
describe('the opponent does not widen how the game advances [W6-36]', () => {
  it('[W6-36] advances only by applyExplained, from exactly one newGame', async () => {
    // The computer moves first, so a request is already outstanding. The spies
    // go on **after** mounting: `mount` resets the module registry, so a spy
    // installed before it would be watching a different copy of `engine` from
    // the one the state module ends up holding — which reads as "no ply went
    // through apply" and is a fact about the test, not about the code.
    const { state, harness } = await load('?seed=42&seating=easy-human');
    const engine = await import('engine');
    const applySpy = vi.spyOn(engine, 'applyExplained');
    // The path `submit` no longer takes: a ply through it would be a second
    // way into the held state, which is what this test exists to deny.
    const plainSpy = vi.spyOn(engine, 'apply');
    const newGameSpy = vi.spyOn(engine, 'newGame');

    try {
      await harness.answer(0);
      expect(applySpy.mock.calls.length, 'the computer ply did not go through applyExplained').toBe(1);
      expect(plainSpy.mock.calls.length, 'a ply went through apply').toBe(0);
      expect(newGameSpy.mock.calls.length, 'a ply dealt a new game').toBe(0);
      expect(state.view().game.isTerminal).toBe(false);

      // And a person's ply takes the same route.
      const before = applySpy.mock.calls.length;
      state.submit(state.view().game.legalActions[0]);
      flush();
      expect(applySpy.mock.calls.length, 'a human ply did not go through applyExplained').toBe(
        before + 1,
      );
      expect(plainSpy.mock.calls.length, 'a ply went through apply').toBe(0);
      expect(newGameSpy.mock.calls.length).toBe(0);
    } finally {
      plainSpy.mockRestore();
      applySpy.mockRestore();
      newGameSpy.mockRestore();
    }
  });
});

/** Drive a ply through the rendered controls, the way a person would. */
function clickThrough(screen: Screen, game: AzulJSON, action: number): void {
  const [source, color, dest] = decodeAction(action);
  const pool = source === CENTER ? game.center : game.factories[source];
  const pick = picksIn([...pool], source).find((p) => p.color === color)!;
  (screen.getByRole('button', { name: pickName(pick, game.colorNames) }) as HTMLElement).click();
  flush();
  const seat = game.currentPlayer;
  const name =
    dest === 5
      ? floorLineName(
          game.players[seat].floor.reduce((t, n) => t + n, 0) +
            (game.players[seat].floorMarker ? 1 : 0),
          game.players[seat].floorPenalty,
        )
      : patternLineName(game.players[seat].patternLines[dest], dest, game.colorNames);
  (screen.getByRole('button', { name }) as HTMLElement).click();
  flush();
}
