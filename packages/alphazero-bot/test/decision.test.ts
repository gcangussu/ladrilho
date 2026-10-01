/**
 * The stop rule ([Z11-33], [Z11-37]) on hand-written logs, case by case
 * ([Z11-45]).
 */

import { describe, expect, it } from 'vitest';
import {
  decide,
  due,
  gateSetting,
  isDone,
  isStopped,
  ruleEntries,
  type LogEntry,
} from '../eval/decision.js';
import { gate, milestone, override, results } from './support/entries.js';

/** Runs the loop's sequence — `due`, the gate if due, `decide` — and logs it. */
function step(log: LogEntry[], run: string, r: ReturnType<typeof results>, gatePasses?: boolean) {
  const entries = ruleEntries(log, run);
  const isDue = due(entries, r);
  const outcome = isDue && gatePasses !== undefined ? gate(gatePasses) : null;
  const decision = decide(entries, r, outcome);
  log.push(milestone(run, r, decision, { due: isDue, outcome }));
  return { due: isDue, decision };
}

describe('the decision table [Z11-33]', () => {
  it('is done when the gate is due and passes', () => {
    const log: LogEntry[] = [];
    step(log, 'a', results(0.3));
    expect(step(log, 'a', results(0.55), true)).toEqual({ due: true, decision: 'done' });
    expect(isDone(log, 'a')).toBe(true);
  });

  it('stops when a milestone does not improve and neither did the one before it', () => {
    const log: LogEntry[] = [];
    step(log, 'a', results(0.3));
    expect(step(log, 'a', results(0.35)).decision).toBe('continue');
    // "Neither did the milestone before it": the boundary. The one before
    // improved, so one fall is not enough…
    expect(step(log, 'a', results(0.33)).decision).toBe('continue');
    // …and a second is.
    expect(step(log, 'a', results(0.32)).decision).toBe('stop');
    expect(isStopped(log, 'a')).toBe(true);
  });

  it('continues otherwise, and a milestone equal to the one before it improves', () => {
    const log: LogEntry[] = [];
    step(log, 'a', results(0.3));
    expect(step(log, 'a', results(0.28)).decision).toBe('continue');
    expect(step(log, 'a', results(0.28)).decision).toBe('continue');
    expect(step(log, 'a', results(0.27)).decision).toBe('continue');
  });

  /** Four winrates, weakest rung first. */
  const ladder = (u: number, g: number, st: number, sh: number): ReturnType<typeof results> => ({
    rungs: { uniformRandom: { winrate: u }, greedy: { winrate: g }, steady: { winrate: st }, sharp: { winrate: sh } },
    ladderHash: 'h',
  });

  /**
   * Run `first`, generations 140 to 160: 1 + 0.55 + 0.3 + 0.04 sums to
   * 1.8900000000000001 and 1 + 0.59 + 0.255 + 0.045 to 1.8899999999999997.
   * Both are 1.89, so 160 improves on 150. Mutation, seen red: comparing the
   * raw sums with `>=` stops here.
   */
  it('compares progress as the sum it is, not the floating-point sum it lands on', () => {
    const log: LogEntry[] = [];
    step(log, 'a', ladder(1, 0.655, 0.26, 0.04));
    expect(step(log, 'a', ladder(1, 0.55, 0.3, 0.04)).decision).toBe('continue');
    expect(step(log, 'a', ladder(1, 0.59, 0.255, 0.045)).decision).toBe('continue');
    // The same pair, the other way round, as entries logged before the fix
    // stored it: the raw sum. Still equal, so the one after it can fall once.
    const stored: LogEntry[] = [
      milestone('b', ladder(1, 0.655, 0.26, 0.04), 'continue'),
      milestone('b', ladder(1, 0.55, 0.3, 0.04), 'continue'),
    ];
    expect(decide(stored, ladder(1, 0.59, 0.255, 0.045))).toBe('continue');
    // And the walk that judges the milestone before: 160 logged as equal to
    // 150 improved, so one fall after it continues. Mutation, seen red.
    const walked: LogEntry[] = [
      milestone('c', ladder(1, 0.55, 0.3, 0.04), 'continue'),
      milestone('c', ladder(1, 0.59, 0.255, 0.045), 'continue'),
    ];
    expect(decide(walked, ladder(1, 0.5, 0.3, 0.04))).toBe('continue');
  });

  it('does not rerun a failed gate at progress equal to its own, however it was summed', () => {
    // 1 + 0.5 + 0.15 + 0.5 sums to 2.15; 1 + 0.5 + 0.1 + 0.55 to 2.1500000000000004.
    // Mutation, seen red: comparing the raw sums runs the gate again.
    const failed = [milestone('a', ladder(1, 0.5, 0.15, 0.5), 'continue', { due: true, outcome: gate(false) })];
    expect(due(failed, ladder(1, 0.5, 0.1, 0.55))).toBe(false);
    expect(due(failed, ladder(1, 0.5, 0.1, 0.555))).toBe(true);
  });

  it('starts the first milestone of a run afresh', () => {
    expect(decide([], results(0))).toBe('continue');
    expect(due([], results(0.5))).toBe(true);
    expect(due([], results(0.49))).toBe(false);
  });

  it('keeps two runs in one log apart', () => {
    const log: LogEntry[] = [];
    step(log, 'a', results(0.4));
    step(log, 'a', results(0.39));
    // Run b's first milestone is fresh however run a has gone…
    expect(step(log, 'b', results(0.1)).decision).toBe('continue');
    // …and run a's third compares against run a's second.
    expect(step(log, 'a', results(0.38)).decision).toBe('stop');
  });

  /**
   * Mutation, seen red ([Z11-48]): comparing against the best earlier
   * milestone instead of the previous one stops this run at its fourth.
   */
  it('compares against the previous milestone, not the best one', () => {
    const log: LogEntry[] = [];
    step(log, 'a', results(0.5, 0.95));
    step(log, 'a', results(0.4));
    // Better than the previous (0.40), worse than the best (0.50).
    expect(step(log, 'a', results(0.45)).decision).toBe('continue');
    expect(step(log, 'a', results(0.44)).decision).toBe('continue');
  });
});

describe('an override [Z11-36]', () => {
  /**
   * Mutation, seen red ([Z11-48]): an override that does not reset the
   * comparison stops the milestone after it again.
   */
  it('starts the milestone after it afresh', () => {
    const log: LogEntry[] = [];
    step(log, 'a', results(0.4));
    step(log, 'a', results(0.39));
    expect(step(log, 'a', results(0.38)).decision).toBe('stop');
    log.push(override('a'));
    expect(isStopped(log, 'a')).toBe(false);
    expect(step(log, 'a', results(0.3)).decision).toBe('continue');
    // Its successor compares against it, and it improved by definition.
    expect(step(log, 'a', results(0.29)).decision).toBe('continue');
    expect(step(log, 'a', results(0.28)).decision).toBe('stop');
  });
});

describe('when the gate is due [Z11-33], [Z11-37]', () => {
  it('is never due below 0.50 against sharp', () => {
    expect(due([], results(0.49, 1))).toBe(false);
    const log: LogEntry[] = [];
    step(log, 'a', results(0.2));
    expect(step(log, 'a', results(0.49), true)).toEqual({ due: false, decision: 'continue' });
  });

  it('decides on a gate that passes and on one that fails, between 0.50 and 0.60', () => {
    const passing: LogEntry[] = [];
    step(passing, 'a', results(0.4));
    expect(step(passing, 'a', results(0.52), true)).toEqual({ due: true, decision: 'done' });
    const failing: LogEntry[] = [];
    step(failing, 'a', results(0.4));
    expect(step(failing, 'a', results(0.52), false)).toEqual({ due: true, decision: 'continue' });
    expect(failing[1].kind === 'milestone' && failing[1].gate).toMatchObject({ due: true, ran: true });
  });

  /**
   * Mutation, seen red ([Z11-48]): the gate due at every milestone above
   * 0.50, ignoring the last failure, runs a gate at the second milestone here.
   */
  it('waits for progress to pass the last failed gate', () => {
    const log: LogEntry[] = [];
    step(log, 'a', results(0.4));
    step(log, 'a', results(0.55), false);
    // Above 0.50, but progress has not passed the failure's: no gate.
    expect(step(log, 'a', results(0.55), true).due).toBe(false);
    expect(step(log, 'a', results(0.54), true).due).toBe(false);
    // Past it: the gate again.
    expect(step(log, 'a', results(0.56), true)).toEqual({ due: true, decision: 'done' });
  });

  it('counts only the most recent failed gate', () => {
    // Hand-written: an earlier failure at a higher progress than the later one.
    const log: LogEntry[] = [
      milestone('a', results(0.6), 'continue', { due: true, outcome: gate(false) }),
      milestone('a', results(0.52), 'continue', { due: true, outcome: gate(false) }),
    ];
    // 0.55 has passed the most recent failure (0.52), not the earlier (0.60).
    expect(due(log, results(0.55))).toBe(true);
    expect(due(log, results(0.52))).toBe(false);
  });

  it('clears a failed gate at a fresh start', () => {
    const log: LogEntry[] = [];
    step(log, 'a', results(0.4));
    step(log, 'a', results(0.6), false);
    expect(step(log, 'a', results(0.55)).due).toBe(false);
    log.push(override('a'));
    expect(due(ruleEntries(log, 'a'), results(0.55))).toBe(true);
  });
});

describe('a run with its gate off [Z11-68]', () => {
  /**
   * Mutation, seen red: `due` ignoring the setting, which runs the gate
   * above 0.50 and lets a passing one end the run.
   */
  it('never runs the gate, so never ends done, and the stop rule still stops it', () => {
    expect(due([], results(0.9), 'end')).toBe(true);
    expect(due([], results(0.9), 'off')).toBe(false);
    const log: LogEntry[] = [];
    const offStep = (r: ReturnType<typeof results>) => {
      const entries = ruleEntries(log, 'a');
      const isDue = due(entries, r, 'off');
      const decision = decide(entries, r, isDue ? gate(true) : null);
      log.push(milestone('a', r, decision, { due: isDue, outcome: null }));
      return decision;
    };
    expect(offStep(results(0.9))).toBe('continue');
    expect(offStep(results(0.95))).toBe('continue');
    expect(offStep(results(0.93))).toBe('continue');
    expect(offStep(results(0.92))).toBe('stop');
    expect(gateSetting({ gate: 'off' })).toBe('off');
    expect(gateSetting({})).toBe('end');
    expect(gateSetting(undefined)).toBe('end');
  });
});

describe('a ladder hash change [Z11-63]', () => {
  it('starts afresh: no stop across two opponents, and no failure carried', () => {
    const log: LogEntry[] = [];
    step(log, 'a', results(0.4, 0.95, 'old'));
    step(log, 'a', results(0.6, 0.95, 'old'), false);
    step(log, 'a', results(0.5, 0.95, 'old'));
    // Lower than the previous, whose own fall would make this a stop — but
    // measured against a different bot, so it starts afresh.
    expect(step(log, 'a', results(0.51, 0.9, 'new'))).toEqual({ due: true, decision: 'continue' });
  });
});

describe('a manual gate [Z11-61]', () => {
  it('ends the run when it passes, and never enters the rule', () => {
    const log: LogEntry[] = [];
    step(log, 'a', results(0.4));
    step(log, 'a', results(0.39));
    const manual: LogEntry = {
      kind: 'manual-gate', run: 'a', date: '2026-09-29', generation: 20, gate: 'gate/a/20.json', decision: 'done', reason: 'x',
    };
    expect(isDone([...log, manual], 'a')).toBe(true);
    expect(ruleEntries([...log, manual], 'a')).toEqual(log);
    // A failing manual gate appends nothing, so nothing changes.
    expect(isDone(log, 'a')).toBe(false);
    expect(step(log, 'a', results(0.38)).decision).toBe('stop');
  });
});
