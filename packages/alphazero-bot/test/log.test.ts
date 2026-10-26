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
  stopPatience,
  type LadderResults,
  type LogEntry,
  type MilestoneEntry,
  type MilestoneResults,
} from '../eval/decision.js';
import { settle, verdict } from '../eval/elo.js';
import { memberName, type PoolRecord } from '../eval/pool.js';
import {
  anchorsExist,
  checkRecord,
  overlaps,
  readAnchors,
  usedSeeds,
  type AnchoredRecord,
  type AnchorsFile,
  type SeedRun,
} from '../eval/anchors.js';
import { BUDGET, HALF_BUDGET } from '../eval/latency.js';
import { SHIP_TEST, checkShip } from '../eval/ship.js';
import type { ShipEntry } from '../eval/decision.js';
import { readLog } from '../eval/log.js';
import { GATES, LATENCY, LOG, PACKAGE } from '../eval/paths.js';
import { gate, milestone, override, results } from './support/entries.js';

type Series = Record<string, { games: number; wins: number; draws: number }>;

/** Every check [Z11-45] asks of a log; throws on the first failure. */
function replay(
  log: readonly LogEntry[],
  gateExists: (path: string) => { passed: boolean } | null,
  anchors: AnchorsFile | null = null,
): void {
  const done = new Set<string>();
  // [Z11-85]: every seed run spoken for so far, the anchors' own pairings first.
  const seen: SeedRun[] = usedSeeds(anchors, []).slice(0, 1);
  for (const p of anchors?.pairings ?? []) {
    const run = { base: p.seedBase, n: p.games };
    if (seen.some((u) => overlaps(run, u))) throw new Error(`anchors: the seeds from ${p.seedBase} were used before`);
    seen.push(run);
  }
  const anchored = (where: string, record: AnchoredRecord, results: Series): void => {
    if (anchors === null) throw new Error(`${where}: an anchored record, but no anchors`);
    try {
      checkRecord(anchors, record, results, seen);
    } catch (err) {
      throw new Error(`${where}: ${(err as Error).message}`);
    }
    seen.push({ base: record.seedBase, n: record.gamesPerMember });
  };
  log.forEach((e, i) => {
    const where = `entry ${i} (${e.kind}, run ${e.run})`;
    if (!['milestone', 'override', 'manual-gate', 'rating', 'ship'].includes(e.kind)) throw new Error(`${where}: unknown kind`);
    if (typeof e.run !== 'string' || typeof e.date !== 'string') throw new Error(`${where}: no run or date`);
    if (e.kind === 'rating') {
      // [Z11-84]: about a checkpoint, not a run's course; held to its own numbers only.
      anchored(where, e.anchored as AnchoredRecord, e.results as Series);
      return;
    }
    if (e.kind === 'ship') {
      // [0012 T12-35]: about master, not a run's course; held to its own numbers.
      const earlier = log.slice(0, i);
      if (!earlier.some((x) => x.kind === 'milestone' && x.run === e.run && x.generation === e.generation)) {
        throw new Error(`${where}: names no logged milestone`);
      }
      if (typeof e.reason !== 'string' || e.reason.length < 20) throw new Error(`${where}: no reason`);
      if (e.decision === 'pin') {
        if (e.master !== null) throw new Error(`${where}: a pin plays no master`);
        return;
      }
      let run: SeedRun;
      try {
        run = checkShip(e, earlier, anchors?.simulations ?? -1);
      } catch (err) {
        throw new Error(`${where}: ${(err as Error).message}`);
      }
      if (seen.some((u) => overlaps(run, u))) throw new Error(`${where}: the seeds from ${run.base} were used before`);
      seen.push(run);
      return;
    }
    if (done.has(e.run)) throw new Error(`${where}: follows a done`);
    const before = ruleEntries(log.slice(0, i), e.run);
    if (e.kind === 'milestone') {
      const pool = (e as { pool?: PoolRecord }).pool;
      const anchor = (e as { anchored?: AnchoredRecord }).anchored;
      const rated = pool ?? anchor;
      const r: MilestoneResults =
        rated === undefined
          ? { rungs: e.results as LadderResults['rungs'], ladderHash: e.ladderHash }
          : { rating: rated.rating, ladderHash: e.ladderHash };
      if (anchor !== undefined) {
        if (e.progress !== measureOf(r)) throw new Error(`${where}: progress is not the rating`);
        anchored(where, anchor, e.results as unknown as Series);
      }
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
      // [Z11-90]: the patience the entry's own copy of the config holds.
      const patience = stopPatience((e as { config?: { stopPatience?: unknown } }).config);
      if (e.decision !== decide(before, r, e.gate.outcome, patience)) throw new Error(`${where}: the decision disagrees with decide()`);
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
    replay(
      readLog(),
      (p) => {
        const f = join(PACKAGE, p);
        return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { passed: boolean }) : null;
      },
      anchorsExist() ? readAnchors() : null,
    );
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

    // [0012 T12-35]: a ship entry replays from its own counts, against the
    // master of its time, on seeds no record used; each record that
    // contradicts them is caught.
    const base = milestone('m', results(0), 'continue');
    const pin: LogEntry = { kind: 'ship', run: 'm', date: 'd', generation: base.generation, decision: 'pin', master: null, reason: 'the first master, named by hand' };
    const cand = { ...milestone('n', results(0), 'continue'), generation: 7 } as LogEntry;
    const test = SHIP_TEST;
    const anchorsFor: AnchorsFile = { simulations: 200, gamesPerMember: 800, pin: { run: 'x', generation: 1, rating: 856 }, members: [], pairings: [], date: 'd', seconds: 0 };
    const ok = (entries: LogEntry[]) => replay(entries, () => null, anchorsFor);
    const played = (over: Partial<ShipEntry> = {}): LogEntry => ({
      kind: 'ship', run: 'n', date: 'd', generation: 7, decision: 'accept', master: { run: 'm', generation: base.generation },
      simulations: 200, seedBase: 900_000_000, test, looks: [[0, 0, 100, 0, 100]], seconds: 1,
      reason: 'n/7 against master: accepted on its numbers', ...over,
    });
    ok([base, pin, cand, played()]);
    expect(() => ok([base, pin, cand, played({ decision: 'reject' })])).toThrow(/disagrees with verdict/);
    expect(() => ok([base, pin, cand, played({ master: { run: 'n', generation: 7 } })])).toThrow(/master of its time/);
    expect(() => ok([base, cand, played()])).toThrow(/master of its time/);
    expect(() => ok([base, pin, played()])).toThrow(/no logged milestone/);
    expect(() => ok([base, pin, cand, played({ looks: [[0, 0, 100, 0, 99]] })])).toThrow(/batches/);
    expect(() => ok([base, pin, cand, played({ looks: [[50, 0, 100, 0, 50], [40, 0, 210, 0, 150]] })])).toThrow(/cumulative/);
    // Kept playing after the first look accepted.
    expect(() => ok([base, pin, cand, played({ looks: [[0, 0, 100, 0, 100], [0, 0, 200, 0, 200]] })])).toThrow(/played on after look 0/);
    // Past the cap: twenty-one looks of 400 games is 8 400.
    const flat = (k: number): [number, number, number, number, number] => [50 * k, 0, 100 * k, 0, 50 * k];
    expect(() => ok([base, pin, cand, played({ decision: 'reject', looks: Array.from({ length: 21 }, (_, k) => flat(k + 1)) })])).toThrow(/past the cap/);
    expect(() => ok([base, pin, cand, played({ test: { ...SHIP_TEST, alpha: 0.5 } })])).toThrow(/not \[T12-34\]'s/);
    expect(() => ok([base, pin, cand, played({ simulations: 800 })])).toThrow(/not the anchors' 200/);
    expect(() => ok([base, pin, cand, played({ looks: [] })])).toThrow(/no looks/);
    // A candidate that is master already: pinned, then played against itself.
    const pinCand: LogEntry = { kind: 'ship', run: 'n', date: 'd', generation: 7, decision: 'pin', master: null, reason: 'n/7 pinned by hand first' };
    expect(() => ok([base, pin, cand, pinCand, played({ master: { run: 'n', generation: 7 } })])).toThrow(/against itself/);
    const replayed = played({ master: { run: 'n', generation: 7 } }) as ShipEntry;
    expect(() => ok([base, pin, cand, played(), { ...replayed, run: 'm', generation: base.generation }])).toThrow(/used before/);
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
