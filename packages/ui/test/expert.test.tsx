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
import { describe, expect, it } from 'vitest';
import { apply, legalActions, newGame, toJSON, type AzulJSON } from 'engine';
import type { Expert, ExpertChoice } from 'ai-bot';
import { createExpertSeats } from '../src/experts.js';
import { EXPERT_AVAILABLE, LEVELS, seatingFromUrl, seatingToUrl } from '../src/opponent.js';

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

describe('the expert is offered exactly when the gate passed [0008 A8-33]', () => {
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
