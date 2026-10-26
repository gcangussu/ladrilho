/**
 * The stop rule ([Z11-33], [Z11-37]): whether the gate is due, and what a
 * milestone decides. Two pure functions over the log, so the rule the loop
 * applies is the rule the suite checks, and the rule the committed log is
 * replayed against.
 */

/** The ladder, weakest first ([Z11-32]). */
export const LADDER = ['uniformRandom', 'greedy', 'steady', 'sharp'] as const;
export type Rung = (typeof LADDER)[number];

/** The `sharp` winrate at which the gate becomes due ([Z11-33]). */
export const GATE_TRIGGER = 0.5;
/** Intent 0009's bar, which the gate tests ([Z11-35]). */
export const GATE_THRESHOLD = 0.6;

export type Decision = 'done' | 'stop' | 'continue';

/**
 * A run's `gate` setting ([Z11-68]): `end` (absent) runs the gate when it is
 * due and ends the run `done` when it passes; `off` never runs it.
 */
export type GateSetting = 'end' | 'off';

/** The gate setting a config or a logged entry's copy of it holds. */
export function gateSetting(config: { gate?: unknown } | undefined): GateSetting {
  return config?.gate === 'off' ? 'off' : 'end';
}

/**
 * What a milestone measured, and the ladder it played ([Z11-63]: a change
 * starts the comparison afresh): each rung's winrate on the ladder of
 * [Z11-31], or the challenger's Elo rating against the pool of [Z11-73].
 */
export type MilestoneResults =
  | { rungs: Record<Rung, { winrate: number }>; ladderHash: string }
  | { rating: number; ladderHash: string };

/** The ladder's kind of results. */
export type LadderResults = Extract<MilestoneResults, { rungs: unknown }>;

/**
 * The number the rule compares ([Z11-33], [Z11-73]): progress on the ladder,
 * or the rating against the pool, both at [grain].
 */
export function measureOf(results: MilestoneResults): number {
  return 'rungs' in results ? progress(results.rungs) : grain(results.rating) / 1e9;
}

/** A gate's outcome as the decision reads it ([Z11-35]). */
export interface GateOutcome {
  passed: boolean;
  winrate: number;
  nullWinrate: number;
  latencyPassed: boolean;
  /** The gate's result file, relative to the package. */
  path: string;
}

export interface MilestoneEntry {
  kind: 'milestone';
  run: string;
  date: string;
  generation: number;
  /** The ladder's rungs, or the pool's members, each with its series' winrate. */
  results: Record<string, { winrate: number }>;
  ladderHash: string;
  progress: number;
  previousProgress: number | null;
  freshStart: { fresh: boolean; why: string | null };
  gate: { due: boolean; ran: boolean; outcome: GateOutcome | null };
  decision: Decision;
  reason: string;
  [other: string]: unknown;
}

export interface OverrideEntry {
  kind: 'override';
  run: string;
  date: string;
  reason: string;
}

export interface ManualGateEntry {
  kind: 'manual-gate';
  run: string;
  date: string;
  generation: number;
  gate: string;
  decision: 'done';
  reason: string;
}

/**
 * A logged milestone rated against the anchors after the fact, by `anchors
 * rate` ([Z11-84]). It takes no part in its run's decisions.
 */
export interface RatingEntry {
  kind: 'rating';
  run: string;
  date: string;
  generation: number;
  anchored: unknown;
  results: Record<string, unknown>;
  seconds: number;
  reason: string;
}

/**
 * A milestone's ship match against `master` ([0012 T12-35]), or the `pin` that
 * named a `master` without one. It is about `master`, not its run's course, so
 * it takes no part in a run's decisions.
 */
export interface ShipEntry {
  kind: 'ship';
  run: string;
  date: string;
  generation: number;
  decision: 'accept' | 'reject' | 'pin';
  /** The `master` it played; `null` for a pin. */
  master: { run: string; generation: number } | null;
  simulations?: number;
  seedBase?: number;
  test?: { elo0: number; elo1: number; alpha: number; beta: number; maxGames: number; batchPairs: number };
  /** The cumulative pair-score counts after each look, in quarters. */
  looks?: [number, number, number, number, number][];
  seconds?: number;
  reason: string;
}

export type LogEntry = MilestoneEntry | OverrideEntry | ManualGateEntry | RatingEntry | ShipEntry;

/**
 * Progress to nine decimals, the grain every comparison of it is made at.
 * Winrates are multiples of 1 / (2 · games), far coarser than 10⁻⁹, but a
 * floating-point sum of them is not exact: 1 + 0.59 + 0.255 + 0.045 is
 * 1.8899999999999997 and 1 + 0.55 + 0.3 + 0.04 is 1.8900000000000001, and
 * run `first` stopped at generation 160 on that difference.
 */
function grain(p: number): number {
  return Math.round(p * 1e9);
}

/** Whether progress `a` exceeds `b`, compared at [grain]. */
function above(a: number, b: number): boolean {
  return grain(a) > grain(b);
}

/** Whether progress `a` is at least `b`, compared at [grain]. */
export function atLeast(a: number, b: number): boolean {
  return grain(a) >= grain(b);
}

/** The sum of the ladder's winrates, in `[0, 4]`, rounded to nine decimals. */
export function progress(rungs: LadderResults['rungs']): number {
  return grain(LADDER.reduce((sum, r) => sum + rungs[r].winrate, 0)) / 1e9;
}

/** Why a milestone starts afresh, or `null` when it does not. */
function freshReason(
  previous: MilestoneEntry | null,
  overrideSince: boolean,
  ladderHash: string,
): string | null {
  if (previous === null) return 'the first milestone of its run';
  if (overrideSince) return 'the first milestone after an override';
  if (previous.ladderHash !== ladderHash) return 'bot changed since the milestone before it (ladder hash)';
  return null;
}

interface Walked {
  previous: MilestoneEntry | null;
  /** Whether the previous milestone improved, by this same rule. */
  previousImproved: boolean;
  overrideSince: boolean;
  /** The most recent failed gate since the last fresh start. */
  lastFailure: MilestoneEntry | null;
  /** [Z11-90]: the best milestone since the last fresh start, and how many have followed it without beating it. */
  best: MilestoneEntry | null;
  sinceBest: number;
}

/**
 * Replays a run's earlier entries through the rule itself. `override`
 * entries count only as fresh starts; `manual-gate` entries never enter.
 */
function walk(entries: readonly LogEntry[]): Walked {
  let previous: MilestoneEntry | null = null;
  let previousImproved = false;
  let overrideSince = false;
  let lastFailure: MilestoneEntry | null = null;
  let best: MilestoneEntry | null = null;
  let sinceBest = 0;
  for (const e of entries) {
    if (e.kind === 'override') {
      overrideSince = true;
      continue;
    }
    if (e.kind !== 'milestone') continue;
    const fresh = freshReason(previous, overrideSince, e.ladderHash) !== null;
    if (fresh) lastFailure = null;
    previousImproved = fresh || (previous !== null && atLeast(e.progress, previous.progress));
    if (e.gate.ran && e.gate.outcome !== null && !e.gate.outcome.passed) lastFailure = e;
    if (fresh || best === null || above(e.progress, best.progress)) {
      best = e;
      sinceBest = 0;
    } else {
      sinceBest++;
    }
    previous = e;
    overrideSince = false;
  }
  return { previous, previousImproved, overrideSince, lastFailure, best, sinceBest };
}

/**
 * [Z11-90]: the patience rule's view of a new milestone: whether it is a new
 * best since the last fresh start, the best it is measured against, and how
 * many milestones in a row, it included, have not beaten that best.
 */
export function patienceOf(
  entries: readonly LogEntry[],
  results: MilestoneResults,
): { newBest: boolean; best: MilestoneEntry | null; without: number } {
  const w = walk(entries);
  const fresh = freshReason(w.previous, w.overrideSince, results.ladderHash) !== null;
  const newBest = fresh || w.best === null || above(measureOf(results), w.best.progress);
  return { newBest, best: fresh ? null : w.best, without: newBest ? 0 : w.sinceBest + 1 };
}

/**
 * [Z11-90]: the patience a run's config sets, or `undefined` for [Z11-33]'s
 * rule. Anything but a whole number from 1 up is refused: 0 would stop at a
 * new best.
 */
export function stopPatience(config: { stopPatience?: unknown } | undefined): number | undefined {
  const p = config?.stopPatience;
  if (p === undefined) return undefined;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1) throw new Error(`stopPatience must be a whole number from 1, not ${String(p)}`);
  return p;
}

/**
 * What the rule saw, for the milestone's reason: the previous milestone,
 * whether it improved, and the progress of the most recent failed gate since
 * the last fresh start — each computed by the same walk `due` and `decide` use.
 */
export function context(entries: readonly LogEntry[]): {
  previous: MilestoneEntry | null;
  previousImproved: boolean;
  lastFailure: number | null;
} {
  const w = walk(entries);
  return { previous: w.previous, previousImproved: w.previousImproved, lastFailure: w.lastFailure?.progress ?? null };
}

/** Whether this milestone starts afresh, and why ([Z11-33], [Z11-63]). */
export function freshStart(entries: readonly LogEntry[], results: MilestoneResults): string | null {
  const w = walk(entries);
  return freshReason(w.previous, w.overrideSince, results.ladderHash);
}

/**
 * Whether the gate is due ([Z11-37]): every condition for running it. False
 * whenever `sharp` is below 0.50; otherwise true unless the most recent
 * failed gate since the last fresh start ran at a milestone whose progress is
 * at least this one's. Only the most recent failure counts.
 */
export function due(entries: readonly LogEntry[], results: MilestoneResults, gate: GateSetting = 'end'): boolean {
  // [Z11-68]: a run whose gate is off never runs it, so never ends done.
  if (gate === 'off') return false;
  // [Z11-73]: the pool has no `sharp`, so a pool milestone never runs the gate.
  if (!('rungs' in results) || results.rungs.sharp.winrate < GATE_TRIGGER) return false;
  const w = walk(entries);
  if (freshReason(w.previous, w.overrideSince, results.ladderHash) !== null) return true;
  return w.lastFailure === null || !atLeast(w.lastFailure.progress, measureOf(results));
}

/**
 * The decision ([Z11-33]'s table, checked in order): `done` when the gate was
 * due and passed; `stop` when this milestone does not improve and neither did
 * the one before it, or, with `patience` set ([Z11-90]), when `patience`
 * milestones in a row have not beaten the run's best; `continue` otherwise.
 * `gate` is absent when it was not due or not reached.
 */
export function decide(
  entries: readonly LogEntry[],
  results: MilestoneResults,
  gate?: GateOutcome | null,
  patience?: number,
): Decision {
  if (gate?.passed === true && due(entries, results)) return 'done';
  // [Z11-90]: with patience set, `stop` once that many milestones in a row
  // have not beaten the run's best since its last fresh start.
  if (patience !== undefined) return patienceOf(entries, results).without >= patience ? 'stop' : 'continue';
  const w = walk(entries);
  const fresh = freshReason(w.previous, w.overrideSince, results.ladderHash) !== null;
  const improves = fresh || (w.previous !== null && atLeast(measureOf(results), w.previous.progress));
  if (!improves && !w.previousImproved) return 'stop';
  return 'continue';
}

/**
 * A run's entries, in log order: its milestones, overrides and manual gates.
 * A `rating` entry is about a checkpoint, and a `ship` entry about `master`,
 * not a run's course, so neither is one.
 */
export function entriesOf(
  log: readonly LogEntry[],
  run: string,
): (MilestoneEntry | OverrideEntry | ManualGateEntry)[] {
  return log.filter(
    (e): e is MilestoneEntry | OverrideEntry | ManualGateEntry => e.run === run && e.kind !== 'rating' && e.kind !== 'ship',
  );
}

/** Whether a run has ended `done`, by a milestone or a manual gate ([Z11-61]). */
export function isDone(log: readonly LogEntry[], run: string): boolean {
  return entriesOf(log, run).some((e) => e.kind !== 'override' && e.decision === 'done');
}

/** Whether a run's latest decision is a `stop` no override has answered ([Z11-36]). */
export function isStopped(log: readonly LogEntry[], run: string): boolean {
  const mine = entriesOf(log, run).filter((e) => e.kind !== 'manual-gate');
  const last = mine[mine.length - 1];
  return last !== undefined && last.kind === 'milestone' && last.decision === 'stop';
}

/** The entries `due` and `decide` take: the run's, `manual-gate` left out. */
export function ruleEntries(log: readonly LogEntry[], run: string): LogEntry[] {
  return entriesOf(log, run).filter((e) => e.kind !== 'manual-gate');
}
