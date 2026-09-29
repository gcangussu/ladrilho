/** Latency's arithmetic and search ([Z11-40], [Z11-57]), and the corpus ([Z11-38]). */

import { readFileSync } from 'node:fs';
import { fromCanonical } from 'engine';
import { describe, expect, it } from 'vitest';
import { findPlaySimulations, percentiles, predictStart, theilSen, type Measurement, type Point } from '../eval/latency.js';
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

/**
 * A machine where a move costs `perSimulation` ms a simulation, p99.9 is
 * `tail`× p95, and the first pass at each count in `spikes` puts p99.9 at
 * 3000 ms.
 */
function fake(perSimulation: number, tail = 1.5, spikes = new Set<number>()) {
  const measured: number[] = [];
  const full = (n: number): Measurement => {
    measured.push(n);
    const p95 = n * perSimulation;
    const p999 = spikes.delete(n) ? 3000 : p95 * tail;
    return { simulations: n, count: 2000, p50: p95 / 2, p95, p99: p95 * 1.2, p999, max: p95 * 2, skipped: 0, checkpointSha256: '' };
  };
  return { full, measured };
}

const PROBE_1MS = { count: 2000, p50: 0, p95: 50, p99: 0, p999: 0, max: 0 };

describe("playSimulations' search [Z11-57]", () => {
  it('without earlier measurements, starts from the probe, gallops up, then bisects', () => {
    // Predicted 1.0 ms a simulation: 1200 would predict exactly 1200 ms, not
    // under it, so the start is 1100. Half the budget is p95 ≤ 1500: 1500
    // meets it and 1600 does not.
    const f = fake(1.0);
    const r = findPlaySimulations(PROBE_1MS, f.full);
    expect(r.start).toBe(1100);
    expect(r.prediction.from).toBe('probe');
    expect(f.measured).toEqual([1100, 1200, 1400, 1800, 1600, 1500]);
    expect(r.settled.simulations).toBe(1500);
    expect(r.above.simulations).toBe(1600);
  });

  it('gallops down when the prediction was optimistic', () => {
    // The probe says 0.5 ms (start 2300); the real cost is 1.2 ms, so p95 is
    // 1440 at 1200 and 1560 at 1300.
    const f = fake(1.2);
    const r = findPlaySimulations({ count: 2000, p50: 0, p95: 25, p99: 0, p999: 0, max: 0 }, f.full);
    expect(r.start).toBe(2300);
    expect(r.settled.simulations).toBe(1200);
    expect(r.above.simulations).toBe(1300);
    expect(f.measured).toEqual([2300, 2200, 2000, 1600, 800, 1200, 1400, 1300]);
  });

  it('refuses a network too big for even 100 simulations', () => {
    const f = fake(40);
    expect(() => findPlaySimulations({ count: 1, p50: 0, p95: 2000, p99: 0, p999: 0, max: 0 }, f.full)).toThrow(/too big/);
  });

  it('starts where a line through earlier measurements crosses half the budget, outliers and all', () => {
    // A machine at 0.12 ms a simulation, p99.9 1.2× p95: p95 reaches 1500 at
    // 12500. The earlier passes include the two a busy machine spoiled — a
    // slow first pass, and a p99.9 spike at the top — which a least-squares
    // line would follow: the spike alone drags its crossing below 11000.
    const prior: Point[] = [];
    for (let n = 8600; n <= 9300; n += 100) prior.push({ simulations: n, p95: 0.12 * n, p999: 0.144 * n });
    prior.push({ simulations: 8500, p95: 1300, p999: 1500 }, { simulations: 9400, p95: 0.12 * 9400, p999: 2606 });
    const p = predictStart(prior, PROBE_1MS);
    expect(p.from).toBe('regression');
    expect(p.start).toBe(12500);
    const f = fake(0.12, 1.2);
    const r = findPlaySimulations(PROBE_1MS, f.full, () => {}, prior);
    expect(f.measured).toEqual([12500, 12600]);
    expect(r.settled.simulations).toBe(12500);
    expect(r.above.simulations).toBe(12600);
  });

  it('starts at the lower of the two crossings when p99.9 binds first', () => {
    // p95 alone would cross at 12500; p99.9 at 2× p95 reaches 2500 at 10416.
    const prior: Point[] = [8600, 8800, 9000].map((n) => ({ simulations: n, p95: 0.12 * n, p999: 0.24 * n }));
    expect(predictStart(prior, PROBE_1MS)).toMatchObject({ from: 'regression', start: 10400 });
  });

  it('falls back to the probe with fewer than three earlier measurements', () => {
    const prior: Point[] = [{ simulations: 9000, p95: 1080, p999: 1200 }, { simulations: 9100, p95: 1092, p999: 1210 }];
    expect(predictStart(prior, PROBE_1MS)).toMatchObject({ from: 'probe', start: 1100 });
  });

  it('measures a p99.9-only miss again, and lets the second pass decide', () => {
    // 1600 would meet half the budget but its first pass spikes on p99.9.
    const f = fake(0.9, 1.2, new Set([1600]));
    const r = findPlaySimulations(PROBE_1MS, f.full);
    expect(f.measured).toEqual([1100, 1200, 1400, 1800, 1600, 1600, 1700]);
    expect(r.settled.simulations).toBe(1600);
    expect(r.above.simulations).toBe(1700);
  });
});

describe('theilSen', () => {
  it('recovers a line despite a wild point', () => {
    expect(theilSen([1, 2, 3, 4, 5], [2, 4, 6, 100, 10])).toEqual({ slope: 2, intercept: 0 });
    expect(theilSen([3, 3], [1, 2])).toBeNull();
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
