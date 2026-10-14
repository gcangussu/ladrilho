/**
 * The estimate's invariants, asserted on one published view. Shared by
 * `estimate.test.tsx` and the whole-game property test in `opponent.test.tsx`,
 * which both cite the requirements they hold this to.
 */

import { expect } from 'vitest';
import type { ViewModel } from '../src/game.js';

/**
 * Of a set estimate: both sides integers, never `-0`; a chance's in [0, 100]
 * summing to 100, a lead's summing to 0; and its level the level its seat
 * holds.
 */
export function holdsInvariants(view: ViewModel): void {
  const e = view.estimate;
  if (e === null) return;
  const sides = e.kind === 'chance' ? e.chance : e.lead;
  for (const side of sides) {
    expect(Number.isInteger(side), `a side of the estimate is ${side}`).toBe(true);
    expect(Object.is(side, -0), 'a side of the estimate is -0').toBe(false);
  }
  if (e.kind === 'chance') {
    for (const side of e.chance) expect(side >= 0 && side <= 100, `a chance of ${side}`).toBe(true);
    expect(e.chance[0] + e.chance[1]).toBe(100);
  } else {
    expect(e.lead[0] + e.lead[1]).toBe(0);
  }
  expect(e.level).toBe(view.seating.players[e.by]);
}
