/**
 * The record's invariants, asserted on one published view. Shared by
 * `record.test.tsx` and the whole-game property test in `opponent.test.tsx`,
 * which both cite the requirement they hold this to. (No requirement is cited
 * here: a helper is not a test of anything.)
 */

import { expect } from 'vitest';
import type { PlyRecord, ViewModel } from '../src/game.js';

type StateModule = typeof import('../src/game.js');

/**
 * `plies` is how many plies the caller has seen played since the deal; `loop`
 * says every ply came through the turn loop or a person, so a computer seat's
 * record carries a choice and a person's none.
 */
export function holdsRecordInvariants(
  state: Pick<StateModule, 'estimateOf'>,
  view: ViewModel,
  plies: number,
  loop = true,
): void {
  const h = view.history;
  expect(h.length, 'the record has a record per ply').toBe(plies);
  h.forEach((record, i) => {
    expect(record.ply).toBe(i + 1);
    if (i > 0) expect(record.round).toBeGreaterThanOrEqual(h[i - 1].round);
    expect(record.level).toBe(view.seating.players[record.seat]);
    expect(record.choice === null, 'choice and estimate are set together').toBe(record.estimate === null);
    if (record.choice !== null) {
      expect(record.level).not.toBeNull();
      expect(record.estimate).toEqual(state.estimateOf(record.choice.value, record.seat, record.level!));
    }
    if (loop) expect(record.choice !== null).toBe(record.level !== null);
  });
  for (const seat of [0, 1] as const) {
    const last = [...h].reverse().find((r) => r.seat === seat);
    expect(view.lastMoves[seat]).toBe(last === undefined ? null : last.action);
  }
  const lastEstimate = [...h].reverse().find((r) => r.estimate !== null);
  expect(view.estimate).toEqual(lastEstimate?.estimate ?? null);
  const lastScored = [...h].reverse().find((r) => r.scoring !== null);
  expect(view.scoring, 'the round record published is the last one recorded').toBe(lastScored?.scoring ?? null);
  if (view.transition !== null) {
    expect((h.at(-1) as PlyRecord).scoring, 'a transition published without its round in the record').not.toBeNull();
  }
}
