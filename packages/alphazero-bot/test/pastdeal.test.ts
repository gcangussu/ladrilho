/**
 * The past-deal refinement and the climb as they bear on what ships
 * ([0012 T12-36], [T12-37]), and the latency budget the climb's records are
 * held to ([T12-25]).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClimbEntry, LogEntry, PastDealEntry } from '../eval/decision.js';
import { readLog } from '../eval/log.js';
import { milestoneCheckpoint } from '../eval/paths.js';
import { CLIMB_FROM, climbed, pastDealFaults } from '../eval/pastdeal.js';
import { SHIPPED, SHIP_TEST, currentMaster, shippedFor } from '../eval/ship.js';
import { QUICK_MAX_MS, WEB_BUDGET, faults, figures, keepsBudget, pct, slower } from '../eval/web-budget.js';
import { MASTER_SIMULATIONS } from '../web/settings.js';

const M = { run: 'twelfth', generation: 120 };
const REASON = 'a reason long enough to read';

const step = (from: number, to: number, decision: 'accept' | 'reject', fits: boolean, m = M): LogEntry =>
  ({
    kind: 'climb', run: m.run, generation: m.generation, date: 'd', from, to, decision, fits,
    latency: { p95: 0, p99: 0, max: 0, pastDeal: 'x' }, seedBase: 0, test: SHIP_TEST, looks: [], seconds: 0, reason: REASON,
  }) satisfies ClimbEntry;

const deal = (decision: PastDealEntry['decision'], sha256: string | null, simulations?: number, m = M): LogEntry =>
  ({ kind: 'pastDeal', run: m.run, generation: m.generation, date: 'd', decision, sha256, ...(simulations === undefined ? {} : { simulations }), reason: REASON }) satisfies PastDealEntry;

describe('the climb [T12-37], [Z11-99]', () => {
  /**
   * Mutations, seen red: a step accepted over budget taken as the next
   * default; a rejected step not ending the climb.
   */
  it('takes each accepted step in budget, stops at a rejection, and names deep only over budget', () => {
    expect(climbed([], M)).toEqual({ default: CLIMB_FROM, deep: null, ended: false });
    expect(climbed([step(10_000, 25_000, 'accept', true)], M)).toEqual({ default: 25_000, deep: null, ended: false });
    expect(climbed([step(10_000, 25_000, 'accept', true), step(25_000, 50_000, 'reject', true)], M)).toEqual({
      default: 25_000, deep: null, ended: true,
    });
    expect(climbed([step(10_000, 25_000, 'accept', true), step(25_000, 50_000, 'accept', false)], M)).toEqual({
      default: 25_000, deep: 50_000, ended: true,
    });
    // A rejected step over budget names no deep: more would only be waiting.
    expect(climbed([step(10_000, 25_000, 'reject', false)], M)).toEqual({ default: 10_000, deep: null, ended: true });
    // Another milestone's climb is not this one's.
    expect(climbed([step(10_000, 25_000, 'accept', true, { run: 'x', generation: 1 })], M).default).toBe(10_000);
  });

  it('refuses a step from anywhere but the default of its time, or after the end', () => {
    expect(() => climbed([step(25_000, 50_000, 'accept', true)], M)).toThrow(/not the default/);
    expect(() => climbed([step(10_000, 25_000, 'reject', true), step(10_000, 50_000, 'accept', true)], M)).toThrow(/ended/);
  });

  /** The committed log decides the interface's configurations. */
  it("is what the interface's constants say", () => {
    const log = readLog();
    const master = currentMaster(log);
    expect(master).not.toBeNull();
    const c = climbed(log, master!);
    expect(MASTER_SIMULATIONS.default).toBe(c.default);
    expect(MASTER_SIMULATIONS.deep ?? null).toBe(c.deep);
  });
});

describe('the refinement on master [T12-36], [Z11-98]', () => {
  const shipped = (pastDeal: { sha256: string } | null) => ({ ...M, pastDeal });

  /**
   * Mutations, seen red: a non-null `pastDeal` accepted without its match;
   * a null one accepted with no decision at all.
   */
  it('is shipped only beside an accepting match, and left out only beside a rejection or a drop', () => {
    expect(pastDealFaults([], shipped(null), 10_000)).toEqual([expect.stringMatching(/no past-deal decision/)]);
    expect(pastDealFaults([], shipped({ sha256: 'a' }), 10_000)).not.toEqual([]);
    expect(pastDealFaults([deal('accept', 'a', 10_000)], shipped({ sha256: 'a' }), 10_000)).toEqual([]);
    expect(pastDealFaults([deal('accept', 'b', 10_000)], shipped({ sha256: 'a' }), 10_000)).not.toEqual([]);
    expect(pastDealFaults([deal('accept', 'a', 10_000)], shipped(null), 10_000)).not.toEqual([]);
    expect(pastDealFaults([deal('reject', 'a', 10_000)], shipped(null), 10_000)).toEqual([]);
    expect(pastDealFaults([deal('drop', null)], shipped(null), 10_000)).toEqual([]);
    // A decision at another default is owed again.
    expect(pastDealFaults([deal('accept', 'a', 10_000)], shipped({ sha256: 'a' }), 25_000)).not.toEqual([]);
    expect(pastDealFaults([deal('reject', 'a', 10_000)], shipped(null), 25_000)).not.toEqual([]);
    // Another milestone's decision is not master's.
    expect(pastDealFaults([deal('drop', null, undefined, { run: 'x', generation: 1 })], shipped(null), 10_000)).not.toEqual([]);
  });

  /** Option (a): the committed record settles it for today's master, or the suite fails. */
  it('is settled for the committed master', () => {
    const s = JSON.parse(readFileSync(SHIPPED, 'utf8')) as { run: string; generation: number; pastDeal: { sha256: string } | null };
    expect(pastDealFaults(readLog(), s, MASTER_SIMULATIONS.default)).toEqual([]);
  });

  /**
   * Mutation, seen red ([T12-29]), in a copy with its anchor confirmed:
   * `shippedFor` keeping the old master's refinement. Posed on a shipped
   * file whose refinement is set, since the committed one may hold none.
   */
  it('does not carry over to a new master', () => {
    const now = JSON.parse(readFileSync(SHIPPED, 'utf8')) as { run: string; generation: number };
    const pd = { sha256: 'ab'.repeat(32) };
    const dir = mkdtempSync(join(tmpdir(), 'shipped-'));
    const path = join(dir, 'shipped.json');
    writeFileSync(path, JSON.stringify({ ...now, pastDeal: pd }));
    try {
      expect(shippedFor({ run: now.run, generation: now.generation }, path).pastDeal).toEqual(pd);
      const other = readLog().find(
        (e): e is LogEntry & { generation: number } =>
          e.kind === 'milestone' &&
          !(e.run === now.run && (e as { generation: number }).generation === now.generation) &&
          existsSync(milestoneCheckpoint(e.run, (e as { generation: number }).generation)),
      );
      expect(other, 'a committed milestone other than master').toBeDefined();
      expect(shippedFor({ run: other!.run, generation: other!.generation }, path).pastDeal).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('the budget [T12-25]', () => {
  /** Mutations, seen red: p99 checked against the p95 bound; the tripwire left out. */
  it('holds the default to p95, p99 and its tripwire, on every pass', () => {
    const ok = { p50: 10, p95: WEB_BUDGET.p95, p99: WEB_BUDGET.p99, max: WEB_BUDGET.max };
    expect(faults('default', [ok, ok])).toEqual([]);
    expect(keepsBudget(ok)).toBe(true);
    for (const bad of [{ ...ok, p95: 3001 }, { ...ok, p99: 5001 }, { ...ok, max: 10_001 }]) {
      expect(faults('default', [ok, bad])).not.toEqual([]);
      expect(keepsBudget(slower([ok, bad]))).toBe(false);
    }
    expect(faults('quick', [{ ...ok, max: QUICK_MAX_MS - 1 }])).toEqual([]);
    expect(faults('quick', [{ ...ok, max: QUICK_MAX_MS }])).not.toEqual([]);
    expect(faults('report', [{ ...ok, max: 1e9 }])).toEqual([]);
  });

  it("ranks as [0011 Z11-40] does: the value at ⌈p/100 · n⌉", () => {
    const times = Array.from({ length: 200 }, (_, i) => i + 1);
    expect(pct(times, 95)).toBe(190);
    expect(pct(times, 99)).toBe(198);
    expect(figures(times)).toEqual({ p50: 100, p95: 190, p99: 198, max: 200 });
  });
});
