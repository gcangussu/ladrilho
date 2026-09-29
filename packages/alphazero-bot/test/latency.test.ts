/** Latency's arithmetic and search ([Z11-40], [Z11-57]), and the corpus ([Z11-38]). */

import { readFileSync } from 'node:fs';
import { fromCanonical } from 'engine';
import { describe, expect, it } from 'vitest';
import { findPlaySimulations, percentiles, type Measurement } from '../eval/latency.js';
import { CORPUS } from '../eval/paths.js';

describe('percentiles [Z11-40]', () => {
  it('takes pN at rank ⌈N/100 · n⌉ of the sorted times', () => {
    const times = Array.from({ length: 2000 }, (_, i) => 2000 - i); // 1..2000, reversed
    const p = percentiles(times);
    expect(p).toEqual({ count: 2000, p50: 1000, p95: 1900, p99: 1980, p999: 1998, max: 2000 });
    // Over 2000 positions p99.9 is the third-largest time.
    expect(percentiles([5, 1, 3]).p50).toBe(3);
  });
});

/** A machine where a move costs `perSimulation` ms a simulation, and p99.9 is 1.5× p95. */
function fake(perSimulation: number) {
  const measured: number[] = [];
  const full = (n: number): Measurement => {
    measured.push(n);
    const p95 = n * perSimulation;
    return { simulations: n, count: 2000, p50: p95 / 2, p95, p99: p95 * 1.2, p999: p95 * 1.5, max: p95 * 2, skipped: 0, checkpointSha256: '' };
  };
  return { full, measured };
}

describe("playSimulations' search [Z11-57]", () => {
  it('starts from the prediction and steps up until the next count misses half the budget', () => {
    // Predicted 1.0 ms a simulation: 1200 would predict exactly 1200 ms, not
    // under it, so the start is 1100. Half the budget is p95 ≤ 1500: 1500
    // meets it and 1600 does not.
    const f = fake(1.0);
    const r = findPlaySimulations({ count: 2000, p50: 0, p95: 50, p99: 0, p999: 0, max: 0 }, f.full);
    expect(r.start).toBe(1100);
    expect(f.measured).toEqual([1100, 1200, 1300, 1400, 1500, 1600]);
    expect(r.settled.simulations).toBe(1500);
    expect(r.above.simulations).toBe(1600);
  });

  it('steps down when the prediction was optimistic', () => {
    // The probe says 0.5 ms (start 2300); the real cost is 1.2 ms, so p95 is
    // 1440 at 1200 and 1560 at 1300.
    const f = fake(1.2);
    const r = findPlaySimulations({ count: 2000, p50: 0, p95: 25, p99: 0, p999: 0, max: 0 }, f.full);
    expect(r.start).toBe(2300);
    expect(r.settled.simulations).toBe(1200);
    expect(r.above.simulations).toBe(1300);
    expect(f.measured).toEqual([2300, 2200, 2100, 2000, 1900, 1800, 1700, 1600, 1500, 1400, 1300, 1200]);
  });

  it('refuses a network too big for even 100 simulations', () => {
    const f = fake(40);
    expect(() => findPlaySimulations({ count: 1, p50: 0, p95: 2000, p99: 0, p999: 0, max: 0 }, f.full)).toThrow(/too big/);
  });
});

describe('the latency corpus [Z11-38]', () => {
  it('is at least 2000 framed canonical blocks, every one a position the engine loads', () => {
    const bytes = readFileSync(CORPUS);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    let n = 0;
    let terminal = 0;
    while (at < bytes.length) {
      const words = v.getUint32(at, true);
      const w = Array.from({ length: words }, (_, i) => v.getInt32(at + 4 + 4 * i, true));
      at += 4 + 4 * words;
      n++;
      const bag = w.slice(32, 32 + w[31]);
      let k = 32 + w[31];
      const take = (m: number) => w.slice(k, (k += m));
      const lid = take(5);
      const walls = [take(25), take(25)];
      const plColor = [take(5), take(5)];
      const plCount = [take(5), take(5)];
      const floor = [take(5), take(5)];
      const [m0, m1, s0, s1, cp, fp, round, tilesLeft, shuffles, term, exh] = take(11);
      const s = fromCanonical(
        {
          factories: [0, 1, 2, 3, 4].map((f) => w.slice(f * 5, f * 5 + 5)),
          center: w.slice(25, 30),
          markerInCenter: w[30] === 1,
          bag,
          lid,
          walls,
          plColor,
          plCount,
          floor,
          floorMarker: [m0 === 1, m1 === 1],
          scores: [s0, s1],
          currentPlayer: cp as 0 | 1,
          firstPlayer: fp as 0 | 1,
          roundIndex: round,
          tilesLeft,
          shufflesUsed: shuffles,
          isTerminal: term === 1,
          exhausted: exh === 1,
        } as never,
        0,
      );
      terminal += s.isTerminal ? 1 : 0;
    }
    expect(at).toBe(bytes.length);
    expect(n).toBeGreaterThanOrEqual(2000);
    expect(terminal).toBeGreaterThan(10);
  });
});
