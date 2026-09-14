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
import { chooseFor, createExpertSeats } from '../src/experts.js';
import {
  EXPERT_AVAILABLE,
  LEVELS,
  expertAvailable,
  seatingFromUrl,
  seatingToUrl,
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
async function mount(search: string): Promise<ReturnType<typeof render>> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  const state = await import('../src/game.js');
  state.useThinker({ think: () => new Promise(() => {}), terminate: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
  const { App } = await import('../src/components/App.jsx');
  const screen = render(() => <App />);
  flush();
  return screen;
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
    expect(failed.LEVELS).toEqual(['easy', 'steady', 'sharp']);
    expect(failed.seatingFromUrl('?seating=expert-human')).toBeNull();
    // The three tiers keep working: intent 0006 says picking any other setting
    // plays exactly as it did before.
    expect(failed.seatingFromUrl('?seating=sharp-human')?.players).toEqual(['sharp', null]);

    const gated = await withGate(true);
    expect(gated.EXPERT_AVAILABLE).toBe(true);
    expect(gated.LEVELS).toEqual(['easy', 'steady', 'sharp', 'expert']);
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
      expect(round).toEqual({ players: ['expert', null] });
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
  it('[W6-1] [0008 A8-33] offers expert as a fourth difficulty, after sharp', async () => {
    // Intent 0006: "picking it is picking one more difficulty setting, next to
    // the other three". The order and the presence are the whole of what a
    // player sees, and nothing looked at the control until now — every
    // computer option could have been dropped with the suite green.
    const screen = await mount('?seed=42');
    const selects = [...screen.container.querySelectorAll('select')];
    expect(selects).toHaveLength(2); // a seat each [W6-5]
    for (const select of selects) {
      const values = [...select.options].map((option) => option.value);
      expect(values).toEqual(
        EXPERT_AVAILABLE
          ? ['human', 'easy', 'steady', 'sharp', 'expert']
          : ['human', 'easy', 'steady', 'sharp'],
      );
      // By a name a player can act on, never a number [W6-1].
      const labels = [...select.options].map((option) => option.textContent ?? '');
      expect(labels[0]).toMatch(/person/i);
      for (const label of labels.slice(1)) expect(label).toMatch(/computer/i);
      if (EXPERT_AVAILABLE) expect(labels.at(-1)).toMatch(/expert/i);
    }
  });
});

describe('which player answers a request [W6-1], [W6-40]', () => {
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

  it('[W6-40] [W6-13] starts a new game with none, because the worker is replaced', () => {
    // Nothing here ends a session: [W6-13] terminates the worker on a new game
    // and on a seating change, and these die with it. What the interface must
    // not do is carry one across — which is the same as saying a fresh set
    // starts empty.
    const asked: AzulJSON[][] = [];
    const first = createExpertSeats(stubExpert(asked).create);
    play(first, 6);
    expect(first.sessions).toBeGreaterThan(0);

    const next = stubExpert([]);
    const second = createExpertSeats(next.create);
    expect(second.sessions).toBe(0);
    expect(next.created()).toBe(0);
  });
});
