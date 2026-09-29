/**
 * The committed record: `milestones/log.json` replayed through the rule
 * ([Z11-34], [Z11-45]), and every committed gate and latency result held to
 * its own numbers ([Z11-35], [Z11-40]).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATE_THRESHOLD, decide, due, ruleEntries, type LogEntry, type MilestoneEntry } from '../eval/decision.js';
import { BUDGET, HALF_BUDGET } from '../eval/latency.js';
import { readLog } from '../eval/log.js';
import { GATES, LATENCY, LOG, PACKAGE } from '../eval/paths.js';
import { gate, milestone, override, results } from './support/entries.js';

/** Every check [Z11-45] asks of a log; throws on the first failure. */
function replay(log: readonly LogEntry[], gateExists: (path: string) => { passed: boolean } | null): void {
  const done = new Set<string>();
  log.forEach((e, i) => {
    const where = `entry ${i} (${e.kind}, run ${e.run})`;
    if (!['milestone', 'override', 'manual-gate'].includes(e.kind)) throw new Error(`${where}: unknown kind`);
    if (typeof e.run !== 'string' || typeof e.date !== 'string') throw new Error(`${where}: no run or date`);
    if (done.has(e.run)) throw new Error(`${where}: follows a done`);
    const before = ruleEntries(log.slice(0, i), e.run);
    if (e.kind === 'milestone') {
      const r = { rungs: e.results, ladderHash: e.ladderHash };
      if (e.gate.due !== due(before, r)) throw new Error(`${where}: gate-was-due disagrees with due()`);
      if (e.gate.ran && !e.gate.due) throw new Error(`${where}: a gate ran that was not due`);
      if (e.decision !== decide(before, r, e.gate.outcome)) throw new Error(`${where}: the decision disagrees with decide()`);
      if (typeof e.reason !== 'string' || e.reason.length < 20) throw new Error(`${where}: no reason`);
      if (e.decision === 'done') done.add(e.run);
    } else if (e.kind === 'override') {
      const last = before[before.length - 1];
      if (last === undefined || last.kind !== 'milestone' || last.decision !== 'stop') {
        throw new Error(`${where}: an override that follows no stop`);
      }
    } else {
      const g = gateExists(e.gate);
      if (g === null || !g.passed) throw new Error(`${where}: names no passing gate result`);
      done.add(e.run);
    }
  });
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

describe('the committed log [Z11-34]', () => {
  it('replays through due and decide, entry by entry [Z11-45]', () => {
    expect(readFileSync(LOG, 'utf8').trim().startsWith('[')).toBe(true);
    replay(readLog(), (p) => {
      const f = join(PACKAGE, p);
      return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { passed: boolean }) : null;
    });
  });

  it('catches what the replay exists to catch', () => {
    const good: LogEntry[] = [];
    const add = (sharp: number, passes?: boolean) => {
      const entries = ruleEntries(good, 'a');
      const r = results(sharp);
      const d = due(entries, r);
      const outcome = d && passes !== undefined ? gate(passes) : null;
      good.push(milestone('a', r, decide(entries, r, outcome), { due: d, outcome }));
    };
    add(0.4);
    add(0.39);
    add(0.38);
    good.push(override('a'));
    add(0.55, false);
    add(0.6, true);
    replay(good, () => ({ passed: true }));

    const wrongDecision = structuredClone(good);
    (wrongDecision[1] as MilestoneEntry).decision = 'stop';
    expect(() => replay(wrongDecision, () => null)).toThrow(/decision disagrees/);
    const wrongDue = structuredClone(good);
    (wrongDue[5] as MilestoneEntry).gate.due = false;
    expect(() => replay(wrongDue, () => null)).toThrow(/gate-was-due/);
    const strayOverride = [good[0], override('a')];
    expect(() => replay(strayOverride, () => null)).toThrow(/follows no stop/);
    const afterDone = [...good, override('a')];
    expect(() => replay(afterDone, () => null)).toThrow(/follows a done/);
    const manual: LogEntry = { kind: 'manual-gate', run: 'b', date: 'd', generation: 1, gate: 'gate/b/1.json', decision: 'done', reason: 'r' };
    expect(() => replay([manual], () => ({ passed: false }))).toThrow(/no passing gate/);
    replay([manual], () => ({ passed: true }));
  });
});

describe('the committed results', () => {
  it('every gate result passes exactly when its numbers do [Z11-35]', () => {
    for (const f of jsonFiles(GATES)) {
      const g = JSON.parse(readFileSync(f, 'utf8'));
      const latencyPassed = g.latency.p95 < BUDGET.p95 && g.latency.p999 < BUDGET.p999;
      expect(g.latency.passed, f).toBe(latencyPassed);
      expect(g.passed, f).toBe(g.winrate >= GATE_THRESHOLD && g.nullWinrate < GATE_THRESHOLD && latencyPassed);
      expect(typeof g.checkpointSha256, f).toBe('string');
      expect(typeof g.provenance.ladderHash, f).toBe('string');
    }
  });

  it('every latency record passes exactly when its numbers do [Z11-40], [Z11-57]', () => {
    for (const f of jsonFiles(LATENCY)) {
      const l = JSON.parse(readFileSync(f, 'utf8'));
      expect(l.passed, f).toBe(l.p95 < BUDGET.p95 && l.p999 < BUDGET.p999);
      expect(l.halfBudgetMet, f).toBe(l.p95 <= HALF_BUDGET.p95 && l.p999 <= HALF_BUDGET.p999);
      expect(l.above.simulations, f).toBe(l.settings.playSimulations + 100);
      expect(l.above.halfBudgetMet, f).toBe(false);
      expect(l.settings.playSimulations % 100, f).toBe(0);
    }
  });
});
