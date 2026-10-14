/**
 * The estimate: *0006 — Opponent in the interface*, [W6-55] onward, for
 * intent 0012 — How the opponent sees it.
 *
 * The estimate is a new reader of two old seams — `lastChoice` and `publish` —
 * and both bugs that shaped the turn loop were an old seam gaining a reader
 * ([0003 U3-42], [W6-42]). So most of this file is about *which publish* the
 * estimate moves on, not about the arithmetic: it must move on exactly the ply
 * a reply is submitted on, and stand on every other — a person's ply, the
 * `thinking` publish, a round transition, a failed reply, a stale one.
 *
 * The seam is injected [W6-18] and answers with values the test chooses, in
 * the reply shape of the level that was asked — but the kind of estimate must
 * follow the level, not the shape [W6-55].
 *
 * The list of what must be asserted is [W6-65]'s, and this file is most of
 * it; the rest is the source check of [W6-25] in `source.test.ts`, the
 * invariants added to [W6-29]'s property test, and the size of a board in the
 * browser lane. Mutation records for the tests that guard a sign, a
 * perspective or the standing rule are in the spec, under [W6-66].
 */

import { render, within } from '@solidjs/testing-library';
import { flush } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WIN as BOT_WIN } from 'bot';
import type { Player } from 'engine';
import type { Estimate } from '../src/game.js';
import type { FromWorker, Thinker, ToWorker } from '../src/opponent.js';
import { holdsInvariants } from './estimate-helpers.js';

type StateModule = typeof import('../src/game.js');

/** A seam that answers only when told to, with the value it is told. */
function valuedThinker(): {
  seam: Thinker;
  pending: ToWorker[];
  answer(index: number, value: number): Promise<void>;
  fail(index: number): void;
} {
  const pending: ToWorker[] = [];
  const resolvers: ((reply: FromWorker) => void)[] = [];
  return {
    seam: {
      think(request) {
        pending.push(request);
        return new Promise<FromWorker>((resolve) => resolvers.push(resolve));
      },
      terminate() {},
    },
    pending,
    async answer(index, value) {
      const request = pending[index];
      const action = request.position.legalActions[0];
      resolvers[index]({
        generation: request.generation,
        ok: true,
        // Each level's own reply shape; the kind must not be read off it.
        choice:
          request.tier === 'master'
            ? { action, value, simulations: request.simulations }
            : request.tier === 'expert'
              ? { action, value, simulations: 1, rootVisits: 1 }
              : { action, value, depth: 1, nodes: 1, complete: false, curtailed: false },
      });
      await Promise.resolve();
      await Promise.resolve();
      flush();
    },
    fail(index) {
      resolvers[index]({ generation: pending[index].generation, ok: false, message: 'no move' });
    },
  };
}
type Harness = ReturnType<typeof valuedThinker>;

/** A fresh state module at `search`, with the seam injected before the opening ask. */
async function load(search: string): Promise<{ state: StateModule; harness: Harness }> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  const state = (await import('../src/game.js')) as StateModule;
  const harness = valuedThinker();
  state.useThinker(harness.seam);
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
  return { state, harness };
}

async function mount(search: string): Promise<{
  screen: ReturnType<typeof render>;
  state: StateModule;
  harness: Harness;
}> {
  const { state, harness } = await load(search);
  const { App } = await import('../src/components/App.jsx');
  const screen = render(() => <App />);
  flush();
  return { screen, state, harness };
}

/** A person's ply, through the state module's one path [0003 U3-31]. */
function personPlays(state: StateModule): void {
  state.submit(state.view().game.legalActions[0]);
  flush();
}

/** The board of seat `seat`, found as a screen reader finds it. */
function boardOf(screen: ReturnType<typeof render>, seat: Player): HTMLElement {
  return screen.getByRole('region', { name: `Player ${seat + 1}` });
}

/**
 * What a board says of the estimate to a screen reader — its text less what is
 * hidden from one — or `null` where it holds no room.
 */
function estimateText(board: HTMLElement): string | null {
  const line = board.querySelector('.estimate');
  if (line === null) return null;
  const copy = line.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function chanceOf(e: Estimate): [number, number] {
  if (e.kind !== 'chance') throw new Error(`expected a chance, got ${e.kind}`);
  return e.chance;
}

function leadOf(e: Estimate): [number, number] {
  if (e.kind !== 'lead') throw new Error(`expected a lead, got ${e.kind}`);
  return e.lead;
}

/** A value whose two sides differ, varying ply to ply, in the asked level's kind. */
function valueFor(request: ToWorker, n: number): number {
  const isChance = request.tier === 'master' || request.tier === 'expert';
  const wobble = ((n * 37) % 19) - 9; // -9..9, never the same twice running
  return isChance ? wobble / 10 + 0.03 : wobble * 1.7 + 0.3;
}

beforeEach(() => {
  vi.resetModules();
});

describe('reading a value as its own kind [W6-56]', () => {
  it('[W6-56] holds a copy of WIN that is bot\'s own', async () => {
    const { WIN } = await import('../src/game.js');
    expect(WIN).toBe(BOT_WIN);
  });

  it('[W6-55] [W6-56] gives master and expert a chance, each seat its own side, from either seat', async () => {
    const { estimateOf } = await import('../src/game.js');
    // A value whose two sides differ, from both seats: the perspective is the
    // asker's, and the other seat's side is the rest of 100.
    expect(estimateOf(0.24, 0, 'master')).toEqual({ kind: 'chance', by: 0, level: 'master', chance: [62, 38] });
    expect(estimateOf(0.24, 1, 'master')).toEqual({ kind: 'chance', by: 1, level: 'master', chance: [38, 62] });
    expect(estimateOf(-0.6, 1, 'expert')).toEqual({ kind: 'chance', by: 1, level: 'expert', chance: [80, 20] });
    // The ends, and a value a float search might overshoot by.
    expect(chanceOf(estimateOf(1, 0, 'master'))).toEqual([100, 0]);
    expect(chanceOf(estimateOf(-1, 0, 'master'))).toEqual([0, 100]);
    expect(chanceOf(estimateOf(1.0000001, 1, 'master'))).toEqual([0, 100]);
    // Halves round up for the asker, and the other side is derived: 62.5 →
    // 63/37 and 37.5 → 38/62, never 63/38 or 37/62.
    expect(chanceOf(estimateOf(0.25, 0, 'master'))).toEqual([63, 37]);
    expect(chanceOf(estimateOf(-0.25, 0, 'master'))).toEqual([38, 62]);
    // A draw is worth 0, so counts as half.
    expect(chanceOf(estimateOf(0, 1, 'master'))).toEqual([50, 50]);
  });

  it('[W6-55] [W6-56] gives a tier a lead in points, negated for the other seat, from either seat', async () => {
    const { estimateOf } = await import('../src/game.js');
    expect(estimateOf(3.4, 0, 'sharp')).toEqual({ kind: 'lead', by: 0, level: 'sharp', lead: [3, -3], decided: null });
    expect(estimateOf(3.4, 1, 'sharp')).toEqual({ kind: 'lead', by: 1, level: 'sharp', lead: [-3, 3], decided: null });
    // Halves away from zero, both ways.
    expect(leadOf(estimateOf(2.5, 0, 'steady'))).toEqual([3, -3]);
    expect(leadOf(estimateOf(-2.5, 0, 'steady'))).toEqual([-3, 3]);
    // Rounding to zero from below is 0 on both sides, never -0 [W6-62].
    const even = estimateOf(-0.4, 1, 'easy') as Extract<Estimate, { kind: 'lead' }>;
    expect(Object.is(even.lead[0], 0) && Object.is(even.lead[1], 0)).toBe(true);
    // The kind is the level's, not the reply's: a value inside [-1, 1] from a
    // tier is still points.
    expect(estimateOf(0.5, 0, 'easy')).toMatchObject({ kind: 'lead', lead: [1, -1] });
  });

  it('[W6-56] reads a tier that reached the end of the game as a foreseen result, each way', async () => {
    const { estimateOf, WIN } = await import('../src/game.js');
    // The asker on seat 1 foresees its own win by 12.
    expect(estimateOf(WIN + 12, 1, 'sharp')).toEqual({ kind: 'lead', by: 1, level: 'sharp', lead: [-12, 12], decided: 1 });
    // The asker on seat 0 foresees its loss by 7: the other seat's win.
    expect(estimateOf(-WIN - 7, 0, 'sharp')).toEqual({ kind: 'lead', by: 0, level: 'sharp', lead: [-7, 7], decided: 1 });
    // A win on the tie-break: level on points, decided all the same.
    expect(estimateOf(WIN, 0, 'steady')).toMatchObject({ lead: [0, 0], decided: 0 });
    // A drawn finish carries no WIN: it is just even.
    expect(estimateOf(0, 0, 'sharp')).toMatchObject({ lead: [0, 0], decided: null });
  });

  it('[W6-58] says each kind in its own words, with whose it is', async () => {
    const { estimateOf } = await import('../src/game.js');
    const { estimateWords } = await import('../src/components/Estimate.jsx');
    const one = [null, 'master'] as const;
    expect(estimateWords(estimateOf(0.24, 1, 'master'), 0, one)).toEqual({
      value: '38% to win',
      by: 'as master saw it on its move',
      short: '38%',
      name: 'master',
    });
    expect(estimateWords(estimateOf(0.24, 1, 'master'), 1, one).value).toBe('62% to win');
    const tier = [null, 'sharp'] as const;
    expect(estimateWords(estimateOf(4, 1, 'sharp'), 1, tier)).toEqual({
      value: 'Ahead by 4 points',
      by: 'as ruthless saw it on its move',
      short: '+4 pt',
      name: 'ruthless',
    });
    expect(estimateWords(estimateOf(4, 1, 'sharp'), 0, tier)).toMatchObject({
      value: 'Behind by 4 points',
      short: '−4 pt',
    });
    expect(estimateWords(estimateOf(1, 1, 'sharp'), 1, tier).value).toBe('Ahead by 1 point');
    expect(estimateWords(estimateOf(0.2, 1, 'sharp'), 0, tier)).toMatchObject({ value: 'Even', short: 'even' });
    expect(estimateWords(estimateOf(BOT_WIN + 12, 1, 'sharp'), 1, tier).value).toBe('A win by 12 points');
    expect(estimateWords(estimateOf(BOT_WIN + 12, 1, 'sharp'), 0, tier)).toMatchObject({
      value: 'A loss by 12 points',
      short: 'loss',
    });
    expect(estimateWords(estimateOf(-BOT_WIN, 1, 'sharp'), 0, tier).value).toBe('A win on the tie-break');
    expect(estimateWords(estimateOf(-BOT_WIN, 1, 'sharp'), 1, tier).value).toBe('A loss on the tie-break');
    // Two computers: the attribution names the seat, so two masters differ.
    expect(estimateWords(estimateOf(0, 0, 'master'), 1, ['master', 'master'])).toMatchObject({
      by: 'as Player 1’s master saw it on its move',
      name: 'P1 master',
    });
    // A lead's short form says points, so it is not read as the round's score
    // change beside it [0003 U3-43]; a chance's short form is its percentage.
    expect(estimateWords(estimateOf(1, 0, 'easy'), 0, [null, 'easy']).short).toBe('+1 pt');
  });
});

describe('when it changes, and when it stands [W6-57]', () => {
  it('[W6-57] [W6-63] [W6-58] is set on the ply the reply is submitted on, and stands on the person\'s next', async () => {
    const { screen, state, harness } = await mount('?seed=42&seating=human-master');
    // Nothing before the computer's first move: null, and an empty line.
    expect(state.view().estimate).toBeNull();
    expect(estimateText(boardOf(screen, 0))).toBe('');
    expect(estimateText(boardOf(screen, 1))).toBe('');

    personPlays(state);
    // The publish that marks `thinking` carries nothing new.
    expect(state.view().thinking).toEqual({ seat: 1 });
    expect(state.view().estimate).toBeNull();

    const before = state.view().game;
    await harness.answer(0, 0.24);
    // The very publish that submitted the reply carries its estimate.
    expect(state.view().game).not.toBe(before);
    expect(state.view().lastMoves[1]).toBe(harness.pending[0].position.legalActions[0]);
    expect(state.view().estimate).toEqual({ kind: 'chance', by: 1, level: 'master', chance: [38, 62] });
    expect(estimateText(boardOf(screen, 0))).toBe('38% to win as master saw it on its move');
    expect(estimateText(boardOf(screen, 1))).toBe('62% to win as master saw it on its move');

    // The person moves: nothing has rated the position since, so it stands.
    const standing = state.view().estimate;
    personPlays(state);
    expect(state.view().thinking).toEqual({ seat: 1 });
    expect(state.view().estimate).toEqual(standing);
    expect(estimateText(boardOf(screen, 0))).toBe('38% to win as master saw it on its move');

    // The next reply replaces it.
    await harness.answer(1, -0.5);
    expect(state.view().estimate).toMatchObject({ by: 1, chance: [75, 25] });
    expect(estimateText(boardOf(screen, 0))).toBe('75% to win as master saw it on its move');
  });

  it('[W6-56] [W6-58] takes the seat from the request: the computer on seat 0, a tier', async () => {
    const { screen, state, harness } = await mount('?seed=42&seating=sharp-human');
    await harness.answer(0, 6.2);
    // After the submit the person is to move; the estimate is still seat 0's.
    expect(state.view().game.currentPlayer).toBe(1);
    expect(state.view().estimate).toEqual({ kind: 'lead', by: 0, level: 'sharp', lead: [6, -6], decided: null });
    expect(estimateText(boardOf(screen, 0))).toBe('Ahead by 6 points as ruthless saw it on its move');
    expect(estimateText(boardOf(screen, 1))).toBe('Behind by 6 points as ruthless saw it on its move');
  });

  /**
   * A whole game, person against a tier, each reply a different value, every
   * publish checked: the estimate is the last reply's, read from the asker's
   * seat, on the reply's ply and on every ply after it until the next — across
   * round transitions made by either mover, each transition still published
   * ([0003 U3-42]).
   */
  it('[W6-57] [W6-61] [W6-62] [W6-64] stands across round transitions by either mover, one request per computer ply', async () => {
    const { state, harness } = await load('?seed=42&seating=human-easy');
    const { estimateOf } = state;
    let expected: Estimate | null = null;
    let answered = 0;
    let computerPlies = 0;
    const transitions = { person: 0, computer: 0 };
    let plies = 0;
    while (!state.view().game.isTerminal && plies < 400) {
      const before = state.view().game;
      let mover: 'person' | 'computer';
      if (state.view().thinking !== null) {
        // [W6-61]: one request outstanding per computer ply, nothing else.
        expect(harness.pending.length).toBe(answered + 1);
        const request = harness.pending[answered];
        expect(Object.keys(request).sort()).toEqual(['generation', 'position', 'tier']);
        const value = valueFor(request, answered);
        await harness.answer(answered, value);
        expected = estimateOf(value, request.position.currentPlayer as Player, request.tier);
        answered++;
        computerPlies++;
        mover = 'computer';
      } else {
        const asked = harness.pending.length;
        personPlays(state);
        // A person's ply asks nothing for the estimate: the only request it
        // may cause is the computer's own turn.
        expect(harness.pending.length - asked).toBe(state.view().thinking !== null ? 1 : 0);
        mover = 'person';
      }
      const after = state.view();
      expect(after.estimate).toEqual(expected);
      holdsInvariants(after);
      if (after.game.round > before.round || (after.game.isTerminal && !before.isTerminal)) {
        expect(after.transition, 'a transition went unpublished').not.toBeNull();
        transitions[mover]++;
      }
      plies++;
    }
    expect(state.view().game.isTerminal).toBe(true);
    expect(answered).toBe(computerPlies);
    // Both kinds of transition happened, so both were checked.
    expect(transitions.person).toBeGreaterThan(0);
    expect(transitions.computer).toBeGreaterThan(0);
    // And it stands at the end of the game, beside the result.
    expect(state.view().estimate).toEqual(expected);
  }, 30_000);

  it('[W6-57] stands through a failed reply', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-human');
    await harness.answer(0, 4);
    const standing = state.view().estimate;
    expect(standing).toMatchObject({ by: 0, lead: [4, -4] });
    personPlays(state);

    // A failed reply publishes, and throws; the estimate stands.
    const rejections: unknown[] = [];
    const capture = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', capture);
    try {
      harness.fail(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', capture);
    }
    flush();
    expect(rejections.length).toBe(1);
    expect(state.view().estimate).toEqual(standing);
  });

  /**
   * The failed request is the *other* computer's, of the other kind, so an
   * estimator written on failure would show: one written back from the same
   * seat and level as the standing one could not be told from leaving it.
   */
  it('[W6-57] stands through a failed reply from the other seat, of the other kind', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-master');
    await harness.answer(0, 4);
    const standing = state.view().estimate;
    expect(standing).toMatchObject({ kind: 'lead', by: 0, level: 'easy', lead: [4, -4] });
    expect(harness.pending[1]).toMatchObject({ tier: 'master' });
    const rejections: unknown[] = [];
    const capture = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', capture);
    try {
      harness.fail(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', capture);
    }
    flush();
    expect(rejections.length).toBe(1);
    expect(state.view().estimate).toEqual(standing);
  });

  it('[W6-61] asks master with exactly the fields Data model declares, simulations included', async () => {
    const { state, harness } = await load('?seed=42&seating=master-human');
    expect(Object.keys(harness.pending[0]).sort()).toEqual(['generation', 'position', 'simulations', 'tier']);
    await harness.answer(0, 0.1);
    personPlays(state);
    expect(harness.pending.length).toBe(2);
    expect(Object.keys(harness.pending[1]).sort()).toEqual(['generation', 'position', 'simulations', 'tier']);
  });

  it('[W6-57] is not set by a stale reply', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-human');
    // A deal while the first request is out: its reply is from a game that no
    // longer exists [W6-16], and must leave the new game's estimate alone.
    state.startNewGame();
    flush();
    expect(harness.pending.length).toBe(2);
    await harness.answer(0, 9);
    expect(state.view().estimate).toBeNull();
    await harness.answer(1, 2);
    expect(state.view().estimate).toMatchObject({ by: 0, lead: [2, -2] });
  });

  it('[W6-57] is cleared by every kind of deal', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-human');
    const deals: [string, () => void][] = [
      ['a new game', () => state.startNewGame()],
      ['a seating change', () => state.startWithSeating({ players: ['easy', null] })],
      ['a numbered deal', () => state.startWithSeating({ players: ['easy', null] }, 7)],
      ['a replay', () => state.replayDeal()],
    ];
    for (const [what, dealIt] of deals) {
      await harness.answer(harness.pending.length - 1, 3);
      expect(state.view().estimate, `before ${what}`).not.toBeNull();
      dealIt();
      flush();
      expect(state.view().estimate, `after ${what}`).toBeNull();
    }
  });
});

describe('who sees it, and where [W6-58], [W6-59], [W6-60]', () => {
  it('[W6-60] [W6-63] shows nothing, and holds no room, in a game of two people', async () => {
    const { screen, state } = await mount('?seed=42&seating=human-human');
    const round = state.view().game.round;
    let plies = 0;
    while (state.view().game.round === round && plies < 100) {
      personPlays(state);
      expect(state.view().estimate).toBeNull();
      plies++;
    }
    expect(state.view().game.round).toBeGreaterThan(round);
    expect(state.view().transition).not.toBeNull();
    for (const seat of [0, 1] as const) expect(estimateText(boardOf(screen, seat))).toBeNull();
    expect(screen.queryByText(/saw it on its move/)).toBeNull();
  });

  it('[W6-59] is plain text in the board, outside the live region, and no control', async () => {
    const { screen, state, harness } = await mount('?seed=42&seating=human-master');
    personPlays(state);
    await harness.answer(0, 0.24);
    const board = boardOf(screen, 1);
    const text = within(board).getByText('62% to win');
    expect(text.closest('[role="status"], [aria-live]')).toBeNull();
    const line = text.closest('.estimate')!;
    expect(line.querySelector('button, a, input, select, textarea, [tabindex]')).toBeNull();
    expect(screen.getByRole('status').textContent).not.toMatch(/to win|saw it/);
  });

  it('[W6-58] [W6-62] [W6-64] with two computers, each move brings its mover\'s own estimate, in its own kind', async () => {
    const { screen, state, harness } = await mount('?seed=42&seating=easy-master');
    for (let n = 0; n < 6; n++) {
      const request = harness.pending[n];
      const seat = request.position.currentPlayer as Player;
      await harness.answer(n, valueFor(request, n));
      const e = state.view().estimate!;
      expect(e.by).toBe(seat);
      expect(e.kind).toBe(request.tier === 'master' ? 'chance' : 'lead');
      holdsInvariants(state.view());
      const name = request.tier === 'master' ? 'master' : 'gentle';
      for (const board of [0, 1] as const) {
        expect(estimateText(boardOf(screen, board))).toMatch(
          new RegExp(`as Player ${seat + 1}’s ${name} saw it on its move$`),
        );
      }
    }
  });
});
