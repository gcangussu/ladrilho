/**
 * [0012 T12-25]'s budgets for `master` in the browser, as the latency lane
 * applies them and the climb's records are held to ([T12-37]). Intent 0016:
 * on this laptop, with nothing else running, 19 moves in 20 at the default
 * take at most three seconds and 99 in 100 at most five.
 */

/** At the default: p95, p99 and a tripwire on the slowest move, in ms. */
export const WEB_BUDGET = Object.freeze({ p95: 3000, p99: 5000, max: 10_000 });
/** At `quick`: every move, as intent 0010 first promised. */
export const QUICK_MAX_MS = 1000;
/** The budget for memory, at every count and at the maximum. */
export const MAX_MEMORY_MB = 512;

/** [0011 Z11-40]'s rank: the value at `⌈p/100 · n⌉` of the sorted times. */
export const pct = (sorted: readonly number[], p: number): number => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];

export interface PassFigures {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function figures(times: readonly number[]): PassFigures {
  const sorted = [...times].sort((a, b) => a - b);
  return { p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted.at(-1) ?? 0 };
}

/** Whether one pass's figures keep the default's budget. */
export function keepsBudget(f: { p95: number; p99: number; max: number }): boolean {
  return f.p95 <= WEB_BUDGET.p95 && f.p99 <= WEB_BUDGET.p99 && f.max <= WEB_BUDGET.max;
}

/** The slower of the passes, figure by figure: what a count is held to. */
export function slower(passes: readonly PassFigures[]): PassFigures {
  return {
    p50: Math.max(...passes.map((p) => p.p50)),
    p95: Math.max(...passes.map((p) => p.p95)),
    p99: Math.max(...passes.map((p) => p.p99)),
    max: Math.max(...passes.map((p) => p.max)),
  };
}

/** What a count must meet: the default's budget, `quick`'s ceiling, or nothing. */
export type Budget = 'default' | 'quick' | 'report';

/** Why a count's passes fail its budget; empty when they meet it. Every pass must. */
export function faults(budget: Budget, passes: readonly PassFigures[]): string[] {
  const out: string[] = [];
  passes.forEach((f, i) => {
    if (budget === 'default') {
      if (f.p95 > WEB_BUDGET.p95) out.push(`pass ${i + 1}: p95 ${f.p95.toFixed(0)} ms over ${WEB_BUDGET.p95}`);
      if (f.p99 > WEB_BUDGET.p99) out.push(`pass ${i + 1}: p99 ${f.p99.toFixed(0)} ms over ${WEB_BUDGET.p99}`);
      if (f.max > WEB_BUDGET.max) out.push(`pass ${i + 1}: a move of ${f.max.toFixed(0)} ms, over ${WEB_BUDGET.max}`);
    }
    if (budget === 'quick' && !(f.max < QUICK_MAX_MS)) out.push(`pass ${i + 1}: a move of ${f.max.toFixed(0)} ms, not under ${QUICK_MAX_MS}`);
  });
  return out;
}
