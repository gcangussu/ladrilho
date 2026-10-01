/**
 * The committed record: `milestones/log.json` replayed through the rule
 * ([Z11-34], [Z11-45]), and every committed gate and latency result held to
 * its own numbers ([Z11-35], [Z11-40]).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GATE_THRESHOLD,
  decide,
  due,
  gateSetting,
  measureOf,
  ruleEntries,
  type LadderResults,
  type LogEntry,
  type MilestoneEntry,
  type MilestoneResults,
} from '../eval/decision.js';
import { settle, verdict } from '../eval/elo.js';
import { memberName, type PoolRecord } from '../eval/pool.js';
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
      const pool = (e as { pool?: PoolRecord }).pool;
      const r: MilestoneResults =
        pool === undefined
          ? { rungs: e.results as LadderResults['rungs'], ladderHash: e.ladderHash }
          : { rating: pool.rating, ladderHash: e.ladderHash };
      if (pool !== undefined) {
        // [Z11-74]: the record's verdict, settling and replacement follow from its own numbers.
        if (e.progress !== measureOf(r)) throw new Error(`${where}: progress is not the rating`);
        const first = verdict(pool.first, pool.weakest.rating);
        if (first !== pool.verdict) throw new Error(`${where}: the verdict disagrees with verdict()`);
        if ((first === 'more') !== pool.extraPerMember > 0) throw new Error(`${where}: extra games disagree with the verdict`);
        const settled = first === 'more' ? settle(pool, pool.weakest.rating) : first;
        if (settled !== pool.settled) throw new Error(`${where}: the settling disagrees with settle()`);
        const out = pool.replaced;
        if ((out !== null) !== (settled === 'replace') || (out !== null && memberName(out) !== memberName(pool.weakest))) {
          throw new Error(`${where}: the replacement is not the weakest champion's`);
        }
      }
      // [Z11-68]: the gate setting the entry's own copy of the config holds.
      const setting = gateSetting((e as { config?: { gate?: unknown } }).config);
      if (e.gate.due !== due(before, r, setting)) throw new Error(`${where}: gate-was-due disagrees with due()`);
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
    // [Z11-68]: a run with its gate off records none due above 0.50, which the
    // replay accepts by reading the entry's own config; the same entry
    // without that setting is a gate the rule says was due.
    const off = milestone('c', results(0.9), 'continue', { due: false, outcome: null });
    replay([{ ...off, config: { gate: 'off' } }], () => null);
    expect(() => replay([off], () => null)).toThrow(/gate-was-due/);

    // [Z11-74]: a pool entry replays from its own numbers; each record that
    // contradicts them is caught.
    const record: PoolRecord = {
      simulations: 200, gamesPerMember: 300, extraPerMember: 0,
      members: [{ run: 'x', generation: 1, rating: 0 }, { run: 'y', generation: 1, rating: 40 }],
      rating: 80, se: 12, first: { rating: 80, se: 12 },
      weakest: { run: 'x', generation: 1, rating: 0 }, verdict: 'replace', settled: 'replace',
      replaced: { run: 'x', generation: 1 },
    };
    const poolEntry = (p: PoolRecord, progress = p.rating): LogEntry =>
      ({ ...milestone('d', results(0), 'continue'), results: {}, progress, gate: { due: false, ran: false, outcome: null }, pool: p }) as LogEntry;
    replay([poolEntry(record)], () => null);
    expect(() => replay([poolEntry({ ...record, verdict: 'more' })], () => null)).toThrow(/verdict disagrees/);
    expect(() => replay([poolEntry({ ...record, replaced: { run: 'y', generation: 1 } })], () => null)).toThrow(/weakest/);
    expect(() => replay([poolEntry(record, 81)], () => null)).toThrow(/not the rating/);
    const close: PoolRecord = { ...record, first: { rating: 10, se: 12 }, verdict: 'more', extraPerMember: 100, rating: 5, settled: 'replace' };
    replay([poolEntry(close)], () => null);
    expect(() => replay([poolEntry({ ...close, extraPerMember: 0 })], () => null)).toThrow(/extra games/);
    expect(() => replay([poolEntry({ ...close, rating: -5 })], () => null)).toThrow(/not the rating|settling/);
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
