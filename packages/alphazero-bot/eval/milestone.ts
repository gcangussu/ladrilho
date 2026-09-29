/**
 * The milestone lane ([Z11-31], [Z11-32]) and the gate ([Z11-35]).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WIDE_SEEDS } from 'bot/arena';
import { GATE_THRESHOLD, LADDER, type Rung } from './decision.js';
import { writeJson, sha256File } from './files.js';
import { measure, machine, passesBudget } from './latency.js';
import { CORPUS, GATES } from './paths.js';
import { provenance, repoRelative, type Provenance } from './provenance.js';
import {
  OUT_OF_REACH_MS,
  aggregate,
  playSeries,
  simulationCounts,
  type Entrant,
  type GameRecord,
  type SeriesResult,
} from './series.js';

/** The first 100 seeds of [0005 M5-16]'s wide list. */
export const MILESTONE_SEEDS: readonly number[] = WIDE_SEEDS.slice(0, 100);

const OPPONENTS: Record<Rung, Entrant> = {
  uniformRandom: { kind: 'uniformRandom' },
  greedy: { kind: 'greedy' },
  steady: { kind: 'tier', tier: 'steady' },
  sharp: { kind: 'tier', tier: 'sharp' },
};

export interface Player {
  binary: string;
  checkpoint: string;
  config: string;
}

function progressLine(label: string, total: number) {
  const started = Date.now();
  let successes = 0;
  return (g: GameRecord, done: number): void => {
    successes += g.points;
    process.stderr.write(
      `${label} ${done}/${total} seed ${g.seed}: ${g.points === 1 ? 'win' : g.points === 0 ? 'loss' : 'draw'}` +
        ` — running ${((100 * successes) / done).toFixed(1)}%` +
        ` (${((Date.now() - started) / 1000 / done).toFixed(1)}s/game)\n`,
    );
  };
}

/** Every move's reported count MUST equal the configured one ([Z11-34]). */
export function checkCounts(counts: Record<string, number>, want: number, what: string): void {
  const wrong = Object.keys(counts).filter((k) => Number(k) !== want);
  if (wrong.length > 0) {
    throw new Error(`${what}: play reported ${wrong.join(', ')} simulations, not ${want}`);
  }
}

export interface MilestoneRun {
  rungs: Record<Rung, SeriesResult>;
  /** Every move's simulation count, as a histogram: all `milestoneSimulations`. */
  simulations: Record<string, number>;
  seconds: number;
}

/** [Z11-31]: every rung, every milestone, 100 seeds each. */
export async function runMilestone(
  player: Player,
  milestoneSimulations: number,
  workers: number,
  seeds: readonly number[] = MILESTONE_SEEDS,
  opponents: Record<Rung, Entrant> = OPPONENTS,
): Promise<MilestoneRun> {
  const started = Date.now();
  const subject: Entrant = { kind: 'alphazero', player: { ...player, search: 'milestone' } };
  const rungs = {} as Record<Rung, SeriesResult>;
  const all: GameRecord[] = [];
  for (const rung of LADDER) {
    const games = await playSeries(
      { subject, opponent: opponents[rung], seeds },
      workers,
      progressLine(`milestone vs ${rung}`, seeds.length),
    );
    rungs[rung] = aggregate(games);
    all.push(...games);
  }
  const simulations = simulationCounts(all);
  checkCounts(simulations, milestoneSimulations, 'milestone');
  return { rungs, simulations, seconds: Math.round((Date.now() - started) / 1000) };
}

export interface GateResult {
  run: string;
  generation: number;
  date: string;
  checkpoint: string;
  checkpointSha256: string;
  winrate: number;
  lowerBound: number;
  bySeat: [number, number];
  nullWinrate: number;
  nullBySeat: [number, number];
  threshold: number;
  /** [Z11-35]'s latency pass of the gated checkpoint, at `playSimulations`. */
  latency: {
    simulations: number;
    measured: number;
    skipped: number;
    p50: number;
    p95: number;
    p99: number;
    p999: number;
    max: number;
    passed: boolean;
  };
  passed: boolean;
  against: SeriesResult;
  null: SeriesResult;
  simulations: Record<string, number>;
  seeds: number[];
  sharp: { tier: 'sharp'; milliseconds: number };
  config: unknown;
  provenance: Provenance;
  machine: ReturnType<typeof machine>;
  seconds: number;
}

/** `gate/<run>/<generation>.json`, or `-2`, `-3`… — no result is overwritten. */
export function gatePath(run: string, generation: number): string {
  for (let k = 1; ; k++) {
    const p = join(GATES, run, k === 1 ? `${generation}.json` : `${generation}-${k}.json`);
    if (!existsSync(p)) return p;
  }
}

/**
 * [Z11-35]: 200 games against `sharp`, the null over the same seeds, then —
 * alone, after every game — the latency of the gated checkpoint itself. Every
 * gate writes its own result, passing or failing.
 */
export async function runGate(
  player: Player,
  run: string,
  generation: number,
  config: { playSimulations: number | null },
  configObject: unknown,
  workers: number,
  seeds: readonly number[] = WIDE_SEEDS,
): Promise<GateResult & { path: string }> {
  const playSimulations = config.playSimulations;
  if (playSimulations === null) throw new Error('the gate plays at playSimulations, which is unset');
  const started = Date.now();
  const az: Entrant = { kind: 'alphazero', player: { ...player, search: 'play' } };
  const against = await playSeries(
    { subject: az, opponent: OPPONENTS.sharp, seeds },
    workers,
    progressLine('gate vs sharp', seeds.length),
  );
  const nullGames = await playSeries({ subject: az, opponent: az, seeds }, workers, progressLine('gate null', seeds.length));
  const simulations = simulationCounts([...against, ...nullGames]);
  checkCounts(simulations, playSimulations, 'gate');
  process.stderr.write('gate: the latency pass, alone\n');
  const lat = measure(player.binary, player.checkpoint, CORPUS, player.config);
  const a = aggregate(against);
  const n = aggregate(nullGames);
  const latency = {
    simulations: lat.simulations,
    measured: lat.count,
    skipped: lat.skipped,
    p50: lat.p50,
    p95: lat.p95,
    p99: lat.p99,
    p999: lat.p999,
    max: lat.max,
    passed: passesBudget(lat),
  };
  const result: GateResult = {
    run,
    generation,
    date: new Date().toISOString(),
    checkpoint: repoRelative(player.checkpoint),
    checkpointSha256: sha256File(player.checkpoint),
    winrate: a.winrate,
    lowerBound: a.lowerBound,
    bySeat: a.bySeat,
    nullWinrate: n.winrate,
    nullBySeat: n.bySeat,
    threshold: GATE_THRESHOLD,
    latency,
    passed: a.winrate >= GATE_THRESHOLD && n.winrate < GATE_THRESHOLD && latency.passed,
    against: a,
    null: n,
    simulations,
    seeds: [...seeds],
    sharp: { tier: 'sharp', milliseconds: OUT_OF_REACH_MS },
    config: configObject,
    provenance: provenance(),
    machine: machine(),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  const path = gatePath(run, generation);
  writeJson(path, result);
  return { ...result, path: repoRelative(path).replace(/^packages\/alphazero-bot\//, '') };
}

