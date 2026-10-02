/**
 * The expert in the interface [W6-40], [W6-41], [0008 A8-33].
 *
 * *0008*'s player keeps a search tree for the length of a game, so unlike a
 * tier it has state between requests — and two computer seats in one worker is
 * exactly the configuration in which that state would first be shared by
 * mistake. Nothing in 0006's suite has ever held state between requests, so
 * these are the cases that would not otherwise exist.
 *
 * The sessions are reached through `experts.ts` rather than through a real
 * worker, for the reason `opponent.test.tsx` gives: jsdom has no `Worker`, and
 * without the seam every one of these would fall to the browser lane.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@solidjs/testing-library';
import { flush } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply, legalActions, newGame, toJSON, type AzulJSON } from 'engine';
import type { Expert, ExpertChoice } from 'ai-bot';
import { chooseFor, createExpertSeats, type ExpertSeats } from '../src/experts.js';
import {
  EXPERT_AVAILABLE,
  LEVELS,
  expertAvailable,
  seatingFromUrl,
  seatingToUrl,
  type FromWorker,
} from '../src/opponent.js';

const BASELINE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'ai-bot',
  'gate',
  'baseline.json',
);

/** A session that answers immediately and records what it was asked. */
function stubExpert(asked: AzulJSON[][]): { create: () => Expert; created: () => number } {
  let created = 0;
  return {
    created: () => created,
    create() {
      const index = created++;
      asked[index] = [];
      const seat = { value: null as number | null };
      return {
        choose(position: AzulJSON): ExpertChoice {
          // The real session binds to one seat and throws on the other
          // ([0008 A8-26]); the stub does the same, so a session handed the
          // wrong seat's position fails here as it would there.
          seat.value ??= position.currentPlayer;
          if (seat.value !== position.currentPlayer) {
            throw new Error(`this session serves seat ${seat.value}`);
          }
          asked[index].push(position);
          return {
            action: position.legalActions[0],
            value: 0,
            simulations: 1,
            rootVisits: 1,
          };
        },
      };
    },
  };
}

/**
 * The interface, mounted on a given URL with a seam that never answers.
 *
 * The same route `opponent.test.tsx` takes — module reset, then two dynamic
 * imports — because `src/game.ts` deals on import and the selector is only
 * rendered by `App`.
 */
async function mount(
  search: string,
  gate?: boolean,
): Promise<{ screen: ReturnType<typeof render>; state: typeof import('../src/game.js') }> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  // The rendered control has to consult the gate, not just the module behind
  // it, so a mounted interface can be given one that did not pass.
  if (gate !== undefined) vi.doMock('ai-bot/gate/baseline.json', () => ({ default: { passed: gate } }));
  const state = await import('../src/game.js');
  state.useThinker({ think: () => new Promise(() => {}), terminate: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
  const { App } = await import('../src/components/App.jsx');
  const screen = render(() => <App />);
  flush();
  return { screen, state };
}

/** The seat selectors, in seat order. */
function selectors(screen: ReturnType<typeof render>): HTMLSelectElement[] {
  return [...screen.container.querySelectorAll('select')];
}

/** Pick a value in a selector the way a player does. */
function pick(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  flush();
}

/** `opponent.ts` as it loads against a given gate result. */
async function withGate(passed: boolean): Promise<typeof import('../src/opponent.js')> {
  vi.resetModules();
  vi.doMock('ai-bot/gate/baseline.json', () => ({ default: { passed } }));
  return import('../src/opponent.js');
}

afterEach(() => {
  vi.doUnmock('ai-bot/gate/baseline.json');
  vi.resetModules();
});

describe('the expert is offered exactly when the gate passed [0008 A8-33]', () => {
  it('[0008 A8-33] takes its answer from the committed file, in both directions', async () => {
    // The direction the committed baseline cannot show. Ninety minutes of play
    // exist to be able to say `passed: false`, and until this test nothing in
    // the client was wired to that answer: a hard-coded `true`, or dropping
    // the import altogether, agreed with the file as long as it said yes.
    const failed = await withGate(false);
    expect(failed.EXPERT_AVAILABLE).toBe(false);
    // `master` is offered either way: nothing gates it [W6-43].
    expect(failed.LEVELS).toEqual(['easy', 'steady', 'sharp', 'master']);
    expect(failed.seatingFromUrl('?seating=expert-human')).toBeNull();
    // The three tiers keep working: intent 0006 says picking any other setting
    // plays exactly as it did before.
    expect(failed.seatingFromUrl('?seating=sharp-human')?.players).toEqual(['sharp', null]);

    const gated = await withGate(true);
    expect(gated.EXPERT_AVAILABLE).toBe(true);
    expect(gated.LEVELS).toEqual(['easy', 'steady', 'sharp', 'expert', 'master']);
    expect(gated.seatingFromUrl('?seating=expert-human')?.players).toEqual(['expert', null]);
  });

  it('[0008 A8-33] reads the gate rather than a constant', () => {
    // Both answers, which the committed file alone cannot show: it passed, so
    // a hard-coded `true` agrees with it today, and would go on agreeing the
    // day a rerun did not clear the bar.
    expect(expertAvailable({ passed: true })).toBe(true);
    expect(expertAvailable({ passed: false })).toBe(false);
    expect(expertAvailable({})).toBe(false);
    expect(expertAvailable({ passed: 'yes' })).toBe(false);
  });

  it('[0008 A8-33] [W6-1] offers it if and only if the committed baseline passed', () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { passed: boolean };
    expect(EXPERT_AVAILABLE).toBe(baseline.passed);
    expect(LEVELS.includes('expert')).toBe(baseline.passed);
    // And the three tiers are offered either way: intent 0006 says picking any
    // other setting plays exactly as it did before.
    expect(LEVELS.slice(0, 3)).toEqual(['easy', 'steady', 'sharp']);
  });

  it('[W6-4] carries expert in the URL exactly when it is offered', () => {
    const round = seatingFromUrl('?seating=expert-human');
    if (EXPERT_AVAILABLE) {
      expect(round).toEqual({ players: ['expert', null], simulations: [10_000, 10_000] });
      expect(seatingToUrl({ players: ['expert', null] })).toBe('expert-human');
    } else {
      // A setting the interface does not offer is not one a URL may name, or a
      // link would seat an opponent nobody can choose.
      expect(round).toBeNull();
    }
    // A malformed value is discarded whole, as [0003 U3-13] discards a seed.
    expect(seatingFromUrl('?seating=wizard-human')).toBeNull();
  });
});

describe('what the seat selector offers [W6-1]', () => {
  it('[W6-1] offers expert as a fourth difficulty, after sharp, by name', async () => {
    // Intent 0006: "picking it is picking one more difficulty setting, next to
    // the other three". Nothing looked at the control until now — every
    // computer option could have been dropped with the suite green.
    const { screen } = await mount('?seed=42', true);
    const selects = selectors(screen);
    expect(selects).toHaveLength(2); // a seat each [W6-5]
    for (const select of selects) {
      expect([...select.options].map((option) => option.value)).toEqual([
        'human',
        'easy',
        'steady',
        'sharp',
        'expert',
        'master',
      ]);
      // By a name a player can act on, never a number [W6-1], and in the order
      // the settings rank: swapping two labels is a different interface.
      expect([...select.options].map((option) => option.textContent)).toEqual([
        'Person',
        'Computer — gentle',
        'Computer — steady',
        'Computer — ruthless',
        'Computer — expert',
        'Computer — master',
      ]);
    }
  });

  it('[0008 A8-33] [W6-1] offers no expert when the committed gate did not pass', async () => {
    // [A8-33] is about the *interface*, so it is asserted about the rendered
    // control and not only about the level list a module away. Written out
    // rather than derived from `EXPERT_AVAILABLE`: a test that agrees with the
    // model agrees with it when both are wrong.
    const { screen } = await mount('?seed=42', false);
    for (const select of selectors(screen)) {
      expect([...select.options].map((option) => option.value)).toEqual([
        'human',
        'easy',
        'steady',
        'sharp',
        'master',
      ]);
    }
  });

  it('[W6-1] [W6-3] seats the player that was picked, and deals a new game', async () => {
    // What a player *does* with the control, which is the half the options
    // list cannot see: an interface can offer "Computer — expert" and seat
    // `easy`, and until this test every lane stayed green when it did.
    const { screen, state } = await mount('?seed=42', true);
    const [first, second] = selectors(screen);

    for (const level of ['expert', 'easy', 'steady', 'sharp'] as const) {
      const before = state.view().seed;
      pick(first, level);
      expect(state.view().seating.players[0], level).toBe(level);
      expect(state.view().seating.players[1], level).toBeNull();
      // [W6-3]: changing the seating deals a new game rather than swapping an
      // opponent into one in progress.
      expect(state.view().seed, level).not.toBe(before);
    }

    pick(second, 'expert');
    expect(state.view().seating.players[1]).toBe('expert');
    pick(second, 'human');
    expect(state.view().seating.players[1]).toBeNull();
  });
});

describe('which player answers a request [W6-40]', () => {
  it('[W6-40] routes expert to a session and every tier to bot', () => {
    const asked: AzulJSON[][] = [];
    const seats = createExpertSeats(stubExpert(asked).create);
    const position = toJSON(newGame(31337));

    // The expert's answer comes from the session: an `ExpertChoice` carries
    // simulations and root visits where a `Choice` carries depth and nodes, so
    // routing `expert` to a tier is visible here and nowhere else — the game
    // would still finish, and the browser lane would not notice.
    const expert = chooseFor({ generation: 1, position, tier: 'expert' }, seats);
    expect(asked[0]).toHaveLength(1);
    expect(expert).toHaveProperty('rootVisits');
    expect(expert).not.toHaveProperty('nodes');

    // A tier's does not, and does not disturb the sessions.
    const tier = chooseFor({ generation: 2, position, tier: 'easy' }, seats);
    expect(asked[0]).toHaveLength(1);
    expect(tier).toHaveProperty('nodes');
    expect(tier).not.toHaveProperty('rootVisits');
    expect(position.legalActions).toContain(tier.action);
  });
});

describe('what the worker’s bundle carries [W6-12]', () => {
  it('[W6-12] keeps the expert’s weights under 1 MB', () => {
    // Stated honestly: this measures the weights module, not a built bundle.
    // It is the whole of what `ai-bot` adds to the worker's chunk — the rest
    // of the package is a few kilobytes of TypeScript — and it is the number
    // the amendment names. A real bundle measurement would need a build, which
    // the fast suite does not do; what a build would add is bounded and small.
    const weights = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'ai-bot',
      'src',
      'weights.ts',
    );
    const bytes = readFileSync(weights).byteLength;
    expect(bytes).toBeGreaterThan(500_000); // it really is the weights
    expect(bytes).toBeLessThan(1_000_000);
  });
});

describe('one session per seat, for the worker’s lifetime [W6-40], [W6-41]', () => {
  /** Plays `plies` of a game, routing each position through `seats`. */
  function play(seats: ReturnType<typeof createExpertSeats>, plies: number): void {
    const state = newGame(4242);
    for (let ply = 0; ply < plies && !state.isTerminal; ply++) {
      apply(state, seats.choose(toJSON(state)).action);
    }
  }

  it('[W6-41] [W6-40] holds one session per seat with expert on both seats', () => {
    const asked: AzulJSON[][] = [];
    const stub = stubExpert(asked);
    const seats = createExpertSeats(stub.create);
    play(seats, 12);

    // Both seats played, and exactly two sessions exist: one each.
    expect(stub.created()).toBe(2);
    expect(seats.sessions).toBe(2);
    expect(asked[0].length).toBeGreaterThan(2);
    expect(asked[1].length).toBeGreaterThan(2);
    // Each session was asked only about its own seat's positions — the stub
    // throws otherwise, as the real session does.
    for (const [index, positions] of asked.entries()) {
      const seat = positions[0].currentPlayer;
      expect(index === 0 ? seat : 1 - seat).toBe(asked[0][0].currentPlayer);
      for (const position of positions) expect(position.currentPlayer).toBe(seat);
    }
  });

  it('[W6-40] creates a seat’s session on its first request, not before', () => {
    const asked: AzulJSON[][] = [];
    const stub = stubExpert(asked);
    const seats = createExpertSeats(stub.create);
    expect(stub.created()).toBe(0);
    expect(seats.sessions).toBe(0);

    const state = newGame(77);
    seats.choose(toJSON(state));
    expect(stub.created()).toBe(1); // seat 0 only
    expect(seats.sessions).toBe(1);
    apply(state, legalActions(state)[0]);
    seats.choose(toJSON(state));
    expect(stub.created()).toBe(2);
  });

  /**
   * The lifetime, asserted where it is decided: in the state module.
   *
   * This used to build a second `createExpertSeats` and check that it started
   * empty — true of any fresh object whatever the interface did, and the
   * interface did nothing: no deal ever terminated the worker, so its sessions
   * were carried into every later game. A title claiming [W6-13] on a test
   * that never reached `game.ts` is how that stayed green.
   *
   * The seam here is `worker.ts` in miniature: one set of seats per worker,
   * built on the first request and gone when the worker is terminated. So the
   * only way the second game can meet fresh sessions is for the deal to end
   * the worker. Seen red, on a copy, with `thinker?.terminate()` deleted from
   * `deal`.
   */
  it('[W6-40] [W6-41] [W6-13] starts a new game with no sessions, because the deal ends the worker', async () => {
    history.replaceState({}, '', '/?seed=42');
    vi.resetModules();
    const state = await import('../src/game.js');
    const asked: AzulJSON[][] = [];
    const stub = stubExpert(asked);
    /** Requests the worker has been asked and not yet answered, oldest first. */
    const queue: (() => void)[] = [];
    let seats: ExpertSeats | null = null;
    let workers = 0;
    state.useThinker({
      think(request) {
        if (seats === null) {
          seats = createExpertSeats(stub.create);
          workers++;
        }
        const mine = seats;
        return new Promise<FromWorker>((resolve) =>
          queue.push(() =>
            resolve({ generation: request.generation, ok: true, choice: chooseFor(request, mine) }),
          ),
        );
      },
      terminate() {
        // A terminated worker answers nothing more, and its seats go with it.
        seats = null;
        queue.length = 0;
      },
    });
    const answer = async (plies: number): Promise<void> => {
      for (let ply = 0; ply < plies; ply++) {
        queue.shift()!();
        await Promise.resolve();
        await Promise.resolve();
        flush();
      }
    };

    state.startWithSeating({ players: ['expert', 'expert'] });
    flush();
    await answer(6);
    expect(workers).toBe(1);
    expect(stub.created(), 'one session per seat in the first game').toBe(2);
    const first = [asked[0].length, asked[1].length];

    state.startNewGame();
    flush();
    await answer(4);
    expect(workers, 'the new game was answered by the old worker').toBe(2);
    expect(stub.created(), 'the new game met the old game’s sessions').toBe(4);
    // The first game's sessions were asked nothing about the second.
    expect([asked[0].length, asked[1].length]).toEqual(first);
  });
});
