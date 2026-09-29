/**
 * Latency ([Z11-38] through [Z11-40], [Z11-57]): the corpus, the percentiles,
 * the budget, and the search for `playSimulations`.
 */

import { cpus, totalmem } from 'node:os';
import { applyExplained, legalActions, newGame, toCanonical, type AzulState } from 'engine';
import { WIDE_SEEDS, tier } from 'bot/arena';
import { toJSON } from 'engine';
import { canonicalWords, frame } from './chooser.js';
import { alphazero } from './crate.js';
import { OUT_OF_REACH_MS } from './series.js';

/** [Z11-40]'s budget: intent 0009's figures, held at p95 rather than p50. */
export const BUDGET = { p95: 3000, p999: 5000 };
/** [Z11-57]'s target on the machine of record: half the budget. */
export const HALF_BUDGET = { p95: 1500, p999: 2500 };
/** Where [Z11-57]'s prediction starts: the predicted p95 must be under this. */
export const PREDICTED_P95 = 1200;
/** The small count the corpus is first timed at, to predict per simulation. */
export const PROBE_SIMULATIONS = 50;
export const MIN_CORPUS = 2000;

export interface Percentiles {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
}

/** pN is the value at rank `⌈N/100 · n⌉` of the sorted times ([Z11-40]). */
export function percentiles(times: readonly number[]): Percentiles {
  if (times.length === 0) throw new Error('no times to take percentiles of');
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  // In integers, per mille: `Math.ceil(0.999 * 2000)` is 1999, because
  // 0.999 · 2000 is 1998.0000000000002 in floating point.
  const at = (permille: number): number => sorted[Math.min(n, Math.max(1, Math.ceil((permille * n) / 1000))) - 1];
  return { count: n, p50: at(500), p95: at(950), p99: at(990), p999: at(999), max: sorted[n - 1] };
}

export function passesBudget(p: Percentiles): boolean {
  return p.p95 < BUDGET.p95 && p.p999 < BUDGET.p999;
}

export function meetsHalfBudget(p: Percentiles): boolean {
  return p.p95 <= HALF_BUDGET.p95 && p.p999 <= HALF_BUDGET.p999;
}

/** One full measurement: every corpus position at one simulation count. */
export interface Measurement extends Percentiles {
  simulations: number;
  skipped: number;
  checkpointSha256: string;
}

/** Runs `alphazero latency` and reduces its times. */
export function measure(
  bin: string,
  checkpoint: string,
  corpus: string,
  config: string,
  simulations?: number,
): Measurement {
  const args = ['latency', checkpoint, corpus, '--config', config];
  if (simulations !== undefined) args.push('--simulations', String(simulations));
  const out = JSON.parse(alphazero(bin, args).toString()) as {
    simulations: number;
    skipped: number;
    checkpointSha256: string;
    milliseconds: number[];
  };
  return {
    ...percentiles(out.milliseconds),
    simulations: out.simulations,
    skipped: out.skipped,
    checkpointSha256: out.checkpointSha256,
  };
}

/** One full measurement's two budgeted percentiles: a point for [Z11-57]'s regression. */
export interface Point {
  simulations: number;
  p95: number;
  p999: number;
}

export interface Line {
  slope: number;
  intercept: number;
}

function median(v: readonly number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Theil–Sen: the median of the slopes between every pair of points with
 * different x, and the median of `y - slope·x`. A spike moves a median by at
 * most one rank, so a busy moment during one pass does not tilt the line.
 */
export function theilSen(xs: readonly number[], ys: readonly number[]): Line | null {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      if (xs[i] !== xs[j]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
    }
  }
  if (slopes.length === 0) return null;
  const slope = median(slopes);
  return { slope, intercept: median(xs.map((x, i) => ys[i] - slope * x)) };
}

/** The fewest earlier full measurements the regression is trusted on. */
export const MIN_POINTS = 3;

export interface Prediction {
  from: 'regression' | 'probe';
  points: number;
  p95: Line | null;
  p999: Line | null;
  /** Where the lines cross half the budget, the lower of the two. */
  crossing: number;
  start: number;
}

/**
 * Where [Z11-57]'s search starts. With at least three earlier full
 * measurements, a Theil–Sen line through p95 and one through p99.9, each
 * solved for half the budget, rounded down to a multiple of 100. Otherwise
 * the probe: the largest multiple of 100 whose predicted p95 is under 1200 ms.
 */
export function predictStart(prior: readonly Point[], probe: Percentiles): Prediction {
  if (prior.length >= MIN_POINTS) {
    const xs = prior.map((p) => p.simulations);
    const p95 = theilSen(xs, prior.map((p) => p.p95));
    const p999 = theilSen(xs, prior.map((p) => p.p999));
    const cross = (l: Line | null, limit: number): number =>
      l && l.slope > 0 ? (limit - l.intercept) / l.slope : Infinity;
    const crossing = Math.min(cross(p95, HALF_BUDGET.p95), cross(p999, HALF_BUDGET.p999));
    if (Number.isFinite(crossing)) {
      const start = Math.max(100, Math.floor(crossing / 100) * 100);
      return { from: 'regression', points: prior.length, p95, p999, crossing, start };
    }
  }
  const perSimulation = probe.p95 / PROBE_SIMULATIONS;
  if (!(perSimulation > 0)) throw new Error(`a probe p95 of ${probe.p95} ms predicts nothing`);
  // The largest multiple of 100 whose predicted p95 is strictly under 1200 ms.
  const start = Math.max(100, (Math.ceil(PREDICTED_P95 / perSimulation / 100) - 1) * 100);
  return { from: 'probe', points: prior.length, p95: null, p999: null, crossing: HALF_BUDGET.p95 / perSimulation, start };
}

/**
 * [Z11-57]'s search, over any measuring function: start where the prediction
 * says, gallop away from it in steps of 100, 200, 400, … until the verdict
 * flips, then bisect on multiples of 100 until a count that meets half the
 * budget sits 100 below one measured and seen to miss it. A miss on p99.9
 * alone is measured once more and decided by the second pass: over 2000
 * positions p99.9 is the third-largest time, and one busy moment moves it.
 */
export function findPlaySimulations(
  probe: Percentiles,
  full: (simulations: number) => Measurement,
  log: (line: string) => void = () => {},
  prior: readonly Point[] = [],
): { settled: Measurement; above: Measurement; start: number; prediction: Prediction; measured: Measurement[] } {
  const prediction = predictStart(prior, probe);
  const { start } = prediction;
  if (prediction.from === 'regression') {
    log(`regression over ${prediction.points} measurements crosses half the budget at ${prediction.crossing.toFixed(0)}: starting at ${start}`);
  } else {
    log(`predicted ${(probe.p95 / PROBE_SIMULATIONS).toFixed(3)} ms a simulation at p95: starting at ${start}`);
  }
  const measured: Measurement[] = [];
  const once = (n: number): Measurement => {
    const m = full(n);
    measured.push(m);
    log(`${n}: p95 ${m.p95.toFixed(0)} ms, p99.9 ${m.p999.toFixed(0)} ms`);
    return m;
  };
  const at = (n: number): Measurement => {
    const m = once(n);
    if (meetsHalfBudget(m) || m.p95 > HALF_BUDGET.p95) return m;
    log(`${n}: missed on p99.9 alone, measuring again`);
    return once(n);
  };
  let lo: Measurement | undefined;
  let hi: Measurement | undefined;
  const first = at(start);
  if (meetsHalfBudget(first)) lo = first;
  else hi = first;
  for (let step = 100; lo === undefined || hi === undefined; step *= 2) {
    if (hi === undefined) {
      const m = at(lo!.simulations + step);
      if (meetsHalfBudget(m)) lo = m;
      else hi = m;
    } else {
      if (hi.simulations <= 100) {
        throw new Error('even 100 simulations miss half the budget: the network is too big for this machine');
      }
      const m = at(Math.max(100, hi.simulations - step));
      if (meetsHalfBudget(m)) lo = m;
      else hi = m;
    }
  }
  while (hi.simulations - lo.simulations > 100) {
    const m = at(lo.simulations + Math.floor((hi.simulations - lo.simulations) / 200) * 100);
    if (meetsHalfBudget(m)) lo = m;
    else hi = m;
  }
  return { settled: lo, above: hi, start, prediction, measured };
}

export function machine() {
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 1e9),
    node: process.version,
  };
}

/**
 * [Z11-38]'s corpus: every position of `steady`-against-`steady` games from
 * recorded seeds, in order, until there are at least 2000, as framed canonical
 * blocks. Terminal positions are included; the lane skips and counts them.
 */
export function recordCorpus(): { bytes: Uint8Array; positions: number; games: number } {
  const steady = tier({ tier: 'steady', milliseconds: OUT_OF_REACH_MS });
  const chunks: Uint8Array[] = [];
  let positions = 0;
  let games = 0;
  for (const seed of WIDE_SEEDS) {
    if (positions >= MIN_CORPUS) break;
    const s: AzulState = newGame(seed);
    for (;;) {
      chunks.push(frame(canonicalWords(toCanonical(s))));
      positions++;
      if (s.isTerminal) break;
      const action = steady(toJSON(s)).action;
      if (!legalActions(s).includes(action)) throw new Error(`seed ${seed}: steady chose an illegal move`);
      applyExplained(s, action);
    }
    games++;
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, positions, games };
}
