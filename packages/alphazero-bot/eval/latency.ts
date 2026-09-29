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

/**
 * [Z11-57]'s search, over any measuring function: predict per simulation from
 * a probe, start at the largest multiple of 100 whose predicted p95 is under
 * 1200 ms, then step up by 100 while the full measurement meets half the
 * budget, or down by 100 until one does. Settles on a count that meets it
 * whose next count up was measured and seen to miss it.
 */
export function findPlaySimulations(
  probe: Percentiles,
  full: (simulations: number) => Measurement,
  log: (line: string) => void = () => {},
): { settled: Measurement; above: Measurement; start: number } {
  const perSimulation = probe.p95 / PROBE_SIMULATIONS;
  if (!(perSimulation > 0)) throw new Error(`a probe p95 of ${probe.p95} ms predicts nothing`);
  // The largest multiple of 100 whose predicted p95 is strictly under 1200 ms.
  const start = Math.max(100, (Math.ceil(PREDICTED_P95 / perSimulation / 100) - 1) * 100);
  log(`predicted ${perSimulation.toFixed(3)} ms a simulation at p95: starting at ${start}`);
  let m = full(start);
  log(`${start}: p95 ${m.p95.toFixed(0)} ms, p99.9 ${m.p999.toFixed(0)} ms`);
  if (meetsHalfBudget(m)) {
    for (;;) {
      const next = full(m.simulations + 100);
      log(`${next.simulations}: p95 ${next.p95.toFixed(0)} ms, p99.9 ${next.p999.toFixed(0)} ms`);
      if (!meetsHalfBudget(next)) return { settled: m, above: next, start };
      m = next;
    }
  }
  for (;;) {
    if (m.simulations <= 100) {
      throw new Error('even 100 simulations miss half the budget: the network is too big for this machine');
    }
    const below = full(m.simulations - 100);
    log(`${below.simulations}: p95 ${below.p95.toFixed(0)} ms, p99.9 ${below.p999.toFixed(0)} ms`);
    if (meetsHalfBudget(below)) return { settled: below, above: m, start };
    m = below;
  }
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
