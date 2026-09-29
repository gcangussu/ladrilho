/** Hand-written log entries for the stop rule's tests. */

import type { GateOutcome, LogEntry, MilestoneEntry, MilestoneResults, Decision } from '../../eval/decision.js';

/** Results whose ladder sums to `2 + steady + sharp`. */
export function results(sharp: number, steady = 0.95, ladderHash = 'h'): MilestoneResults {
  return {
    rungs: { uniformRandom: { winrate: 1 }, greedy: { winrate: 1 }, steady: { winrate: steady }, sharp: { winrate: sharp } },
    ladderHash,
  };
}

export function gate(passed: boolean, winrate = passed ? 0.63 : 0.55): GateOutcome {
  return { passed, winrate, nullWinrate: 0.5, latencyPassed: true, path: 'gate/x/0.json' };
}

let generation = 0;

/** A milestone entry as the loop would write it, for the fields the rule reads. */
export function milestone(
  run: string,
  r: MilestoneResults,
  decision: Decision,
  g: { due: boolean; outcome: GateOutcome | null } = { due: false, outcome: null },
): MilestoneEntry {
  generation += 10;
  const progress = r.rungs.uniformRandom.winrate + r.rungs.greedy.winrate + r.rungs.steady.winrate + r.rungs.sharp.winrate;
  return {
    kind: 'milestone',
    run,
    date: '2026-09-29',
    generation,
    results: r.rungs,
    ladderHash: r.ladderHash,
    progress,
    previousProgress: null,
    freshStart: { fresh: false, why: null },
    gate: { due: g.due, ran: g.outcome !== null, outcome: g.outcome },
    decision,
    reason: `decided ${decision} at progress ${progress.toFixed(2)}`,
  };
}

export function override(run: string): LogEntry {
  return { kind: 'override', run, date: '2026-09-29', reason: 'a person decided' };
}
