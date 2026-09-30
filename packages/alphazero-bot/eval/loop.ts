/**
 * The loop ([Z11-28]) and the entry points around it: `train init`
 * ([Z11-58]), the latency and throughput lanes ([Z11-57], [Z11-53]), and the
 * milestone and gate run by hand ([Z11-4], [Z11-61]).
 *
 * The loop writes; it never commits ([Z11-34]).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startingConfig, type RunConfig } from './config.js';
import { alphazero, buildRelease, trainer } from './crate.js';
import {
  GATE_TRIGGER,
  context,
  decide,
  atLeast,
  due,
  entriesOf,
  freshStart,
  isDone,
  isStopped,
  progress,
  ruleEntries,
  type Decision,
  type GateOutcome,
  type MilestoneEntry,
  type MilestoneResults,
} from './decision.js';
import { readJson, writeAtomic, writeJson } from './files.js';
import { findPlaySimulations, machine, meetsHalfBudget, measure, passesBudget, PROBE_SIMULATIONS, type Point } from './latency.js';
import { withLock } from './lock.js';
import { appendLog, readLog } from './log.js';
import { runGate, runMilestone, type Player } from './milestone.js';
import { CORPUS, LATENCY, checkRunName, milestoneCheckpoint, parseMilestonePath, runPaths } from './paths.js';
import { provenance } from './provenance.js';

/** A sample record's size ([Z11-27]). */
const RECORD_BYTES = 1113;

interface RunState {
  /** The generation the loop is on: its checkpoint exists. */
  generation: number;
  startedAt: string;
}

function today(): string {
  return new Date().toISOString();
}

function readConfig(name: string): RunConfig {
  const p = runPaths(name);
  if (!existsSync(p.config)) throw new Error(`no run named ${name}: run \`train init --run ${name}\` first`);
  return readJson<RunConfig>(p.config);
}

/** [Z11-58]: the run's directory, its config with a random seed, and checkpoint 0. */
export function initRun(name: string): void {
  checkRunName(name);
  const p = runPaths(name);
  if (existsSync(p.dir)) throw new Error(`${p.dir} already exists`);
  const config = startingConfig();
  mkdirSync(p.dir, { recursive: true });
  writeJson(p.config, config);
  trainer(['init', '--run-dir', p.dir]);
  process.stdout.write(
    `run ${name}: checkpoint 0 written. Next, on an idle machine:\n` +
      `  pnpm -F alphazero-bot latency --run ${name}\n` +
      `  pnpm -F alphazero-bot throughput --run ${name}\n` +
      `then: pnpm -F alphazero-bot train --run ${name}\n`,
  );
}

function started(name: string): boolean {
  return existsSync(runPaths(name).state);
}

/**
 * [Z11-40], [Z11-57]: finds `playSimulations` on checkpoint 0, writes the
 * run's latency record to be committed, and fixes the count in the config.
 */
export async function latencyLane(name: string): Promise<void> {
  checkRunName(name);
  await withLock(`latency --run ${name}`, () => {
    const p = runPaths(name);
    const config = readConfig(name);
    if (started(name)) {
      throw new Error(`run ${name} has started generation 0: its latency record and playSimulations are fixed`);
    }
    if (!existsSync(CORPUS)) throw new Error('no latency corpus: run `pnpm -F alphazero-bot latency-corpus` once');
    const bin = buildRelease();
    const checkpoint = p.checkpoint(0);
    const log = (line: string): void => void process.stderr.write(`latency: ${line}\n`);
    const probe = measure(bin, checkpoint, CORPUS, p.config, PROBE_SIMULATIONS);
    log(`${PROBE_SIMULATIONS}: p95 ${probe.p95.toFixed(1)} ms`);
    // Every full measurement this run has taken, kept across attempts: the
    // regression of [Z11-57] starts from them.
    const points: (Point & { date: string })[] = existsSync(p.latencyPoints) ? readJson(p.latencyPoints) : [];
    const found = findPlaySimulations(
      probe,
      (n) => {
        const m = measure(bin, checkpoint, CORPUS, p.config, n);
        points.push({ simulations: n, p95: m.p95, p999: m.p999, date: new Date().toISOString() });
        writeJson(p.latencyPoints, points);
        return m;
      },
      log,
      [...points],
    );
    const s = found.settled;
    const record = {
      run: name,
      date: today(),
      settings: { width: config.width, blocks: config.blocks, playSimulations: s.simulations, cpuct: config.cpuct, fpu: config.fpu },
      checkpoint: 'checkpoint 0',
      checkpointSha256: s.checkpointSha256,
      machine: machine(),
      measured: s.count,
      skipped: s.skipped,
      p50: s.p50,
      p95: s.p95,
      p99: s.p99,
      p999: s.p999,
      max: s.max,
      halfBudgetMet: meetsHalfBudget(s),
      passed: passesBudget(s),
      above: {
        simulations: found.above.simulations,
        measured: found.above.count,
        p50: found.above.p50,
        p95: found.above.p95,
        p99: found.above.p99,
        p999: found.above.p999,
        max: found.above.max,
        halfBudgetMet: meetsHalfBudget(found.above),
      },
      probe: { simulations: PROBE_SIMULATIONS, p95: probe.p95 },
      prediction: found.prediction,
      start: found.start,
      passes: found.measured.map((m) => ({ simulations: m.simulations, p95: m.p95, p999: m.p999 })),
    };
    writeJson(join(LATENCY, `${name}.json`), record);
    const next = { ...config, playSimulations: s.simulations };
    next.milestoneSimulations = Math.min(config.milestoneSimulations, s.simulations);
    writeJson(p.config, next);
    process.stdout.write(
      `playSimulations ${s.simulations}: p95 ${s.p95.toFixed(0)} ms, p99.9 ${s.p999.toFixed(0)} ms; ` +
        `${found.above.simulations} missed half the budget. Written to latency/${name}.json\n`,
    );
  });
}

/** [Z11-53]: self-play's speed on checkpoint 0, written to `runs/<name>/throughput.json`. */
export async function throughputLane(name: string): Promise<void> {
  checkRunName(name);
  await withLock(`throughput --run ${name}`, () => {
    const p = runPaths(name);
    readConfig(name);
    const bin = buildRelease();
    process.stdout.write(alphazero(bin, ['throughput', p.checkpoint(0), '--config', p.config]).toString());
  });
}

function sampleCount(name: string, upTo: number): number {
  let n = 0;
  for (let g = 0; g < upTo; g++) {
    const f = runPaths(name).samples(g);
    if (existsSync(f)) n += statSync(f).size / RECORD_BYTES;
  }
  return n;
}

/** The loss records of the generations since the previous milestone ([Z11-54]). */
function lossesSince(name: string, from: number, to: number): unknown[] {
  const f = runPaths(name).losses;
  if (!existsSync(f)) return [];
  const all = readJson<Record<string, unknown>>(f);
  const out: unknown[] = [];
  for (let g = from; g < to; g++) if (all[String(g)] !== undefined) out.push(all[String(g)]);
  return out;
}

const pct = (x: number): string => x.toFixed(2);

/** One sentence naming the numbers the decision was taken on ([Z11-34]). */
export function reasonFor(
  results: MilestoneResults,
  previous: MilestoneEntry | null,
  fresh: string | null,
  gateDue: boolean,
  gate: GateOutcome | null,
  lastFailure: number | null,
  decision: Decision,
  previousImproved: boolean,
): string {
  const p = progress(results.rungs);
  const sharp = results.rungs.sharp.winrate;
  const parts = [`progress ${pct(p)} (sharp ${pct(sharp)})`];
  if (fresh !== null) parts.push(`a fresh start: ${fresh}`);
  else if (previous !== null) {
    parts.push(
      atLeast(p, previous.progress)
        ? `improved on ${pct(previous.progress)} at generation ${previous.generation}`
        : `did not improve on ${pct(previous.progress)} at generation ${previous.generation}` +
            (previousImproved ? ', which had improved' : ', which had not improved either'),
    );
  }
  if (sharp < GATE_TRIGGER) parts.push(`sharp below ${pct(GATE_TRIGGER)}, so no gate`);
  else if (!gateDue) parts.push(`gate not due: progress has not passed ${pct(lastFailure ?? 0)}, where the last gate failed`);
  else if (gate !== null) {
    parts.push(
      `gate ${gate.passed ? 'passed' : 'failed'} (${pct(gate.winrate)} against sharp, null ${pct(gate.nullWinrate)}, ` +
        `latency ${gate.latencyPassed ? 'within' : 'over'} budget)`,
    );
  }
  return `${parts.join('; ')}: ${decision}.`;
}

/** Step 5 of [Z11-28]: measure, gate if due, decide, log. */
async function milestoneStep(
  name: string,
  generation: number,
  config: RunConfig,
  state: RunState,
  bin: string,
  workers: number,
): Promise<MilestoneEntry> {
  const p = runPaths(name);
  const started = Date.now();
  const dest = milestoneCheckpoint(name, generation);
  mkdirSync(dirname(dest), { recursive: true });
  // The parity file first, so a checkpoint is never on disk without one ([Z11-13]).
  writeAtomic(dest.replace(/\.bin$/, '.parity'), readFileSync(p.checkpoint(generation).replace(/\.bin$/, '.parity')));
  writeAtomic(dest, readFileSync(p.checkpoint(generation)));
  const player: Player = { binary: bin, checkpoint: dest, config: p.config };

  const measured = await runMilestone(player, config.milestoneSimulations, workers);
  const prov = provenance();
  const results: MilestoneResults = { rungs: measured.rungs, ladderHash: prov.ladderHash };
  const entries = ruleEntries(readLog(), name);
  const { previous, previousImproved, lastFailure } = context(entries);
  const fresh = freshStart(entries, results);
  const gateDue = due(entries, results);
  let gate: GateOutcome | null = null;
  if (gateDue) {
    // The loop's own gate runs under the loop's lock, in this process ([Z11-61]).
    const g = await runGate(player, name, generation, config, config, workers);
    gate = { passed: g.passed, winrate: g.winrate, nullWinrate: g.nullWinrate, latencyPassed: g.latency.passed, path: g.path };
  }
  const decision = decide(entries, results, gate);
  const entry: MilestoneEntry = {
    kind: 'milestone',
    run: name,
    date: today(),
    generation,
    sinceRunStartSeconds: Math.round((Date.now() - Date.parse(state.startedAt)) / 1000),
    milestoneSeconds: Math.round((Date.now() - started) / 1000),
    games: generation * config.gamesPerGeneration,
    samples: sampleCount(name, generation),
    config,
    simulations: measured.simulations,
    results: measured.rungs,
    ladderHash: prov.ladderHash,
    progress: progress(measured.rungs),
    previousProgress: previous?.progress ?? null,
    freshStart: { fresh: fresh !== null, why: fresh },
    gate: { due: gateDue, ran: gate !== null, outcome: gate },
    losses: lossesSince(name, previous?.generation ?? 0, generation),
    provenance: prov,
    decision,
    reason: reasonFor(results, previous, fresh, gateDue, gate, lastFailure, decision, previousImproved),
  };
  appendLog(entry);
  process.stdout.write(`milestone ${name}/${generation}: ${entry.reason}\n`);
  return entry;
}

/** [Z11-28]: starts or resumes a run, from the first step not on disk. */
export async function trainLoop(
  name: string,
  opts: { override?: string; until?: number; workers: number },
): Promise<void> {
  checkRunName(name);
  await withLock(`train --run ${name}`, async () => {
    const p = runPaths(name);
    const config = readConfig(name);
    // [Z11-58], [Z11-39], [Z11-53]: no generation runs before both lanes pass.
    const latencyFile = join(LATENCY, `${name}.json`);
    if (config.playSimulations === null || !existsSync(latencyFile)) {
      throw new Error(`run the latency lane first: pnpm -F alphazero-bot latency --run ${name}`);
    }
    if (readJson<{ halfBudgetMet: boolean }>(latencyFile).halfBudgetMet !== true) {
      throw new Error(`latency/${name}.json does not meet the half-budget target`);
    }
    if (!existsSync(p.throughput)) {
      throw new Error(`run the throughput lane first: pnpm -F alphazero-bot throughput --run ${name}`);
    }
    const tp = readJson<{ minutesPerGeneration: number }>(p.throughput);
    if (!(tp.minutesPerGeneration <= config.maxGenerationMinutes)) {
      throw new Error(`self-play would take ${tp.minutesPerGeneration} minutes a generation, past ${config.maxGenerationMinutes}`);
    }
    const log = readLog();
    if (isDone(log, name)) throw new Error(`run ${name} is done: its log holds a done`);
    if (isStopped(log, name)) {
      if (opts.override === undefined) {
        const last = entriesOf(log, name).filter((e) => e.kind === 'milestone').pop() as MilestoneEntry;
        throw new Error(`run ${name} stopped: ${last.reason} Continue with --override "<reason>"`);
      }
      appendLog({ kind: 'override', run: name, date: today(), reason: opts.override });
    } else if (opts.override !== undefined) {
      throw new Error(`run ${name} has not stopped: there is nothing to override`);
    }

    const state: RunState = existsSync(p.state)
      ? readJson<RunState>(p.state)
      : { generation: 0, startedAt: today() };
    writeJson(p.state, state);
    const bin = buildRelease();
    for (;;) {
      const g = state.generation;
      if (opts.until !== undefined && g >= opts.until) return;
      if (!existsSync(p.manifest(g))) throw new Error(`generation ${g} has no manifest`);
      if (!existsSync(p.samples(g))) {
        process.stderr.write(`generation ${g}: self-play\n`);
        mkdirSync(dirname(p.samples(g)), { recursive: true });
        alphazero(bin, [
          'selfplay', p.checkpoint(g), '--config', p.config,
          '--generation', String(g), '--games', String(config.gamesPerGeneration), '--out', p.samples(g),
        ]);
      }
      if (!existsSync(p.manifest(g + 1))) {
        process.stderr.write(`generation ${g}: training\n`);
        trainer(['generation', '--run-dir', p.dir, '--generation', String(g)]);
      }
      const next = g + 1;
      const logged = entriesOf(readLog(), name).some((e) => e.kind === 'milestone' && e.generation === next);
      let decision: Decision = 'continue';
      if (next % config.milestoneEvery === 0 && !logged) {
        decision = (await milestoneStep(name, next, config, state, bin, opts.workers)).decision;
      }
      state.generation = next;
      writeJson(p.state, state);
      if (decision !== 'continue') return;
    }
  });
}

/** A logged milestone's entry, which holds the settings it ran with ([Z11-4]). */
function loggedMilestone(checkpoint: string): { entry: MilestoneEntry; config: string } {
  const { run, generation } = parseMilestonePath(checkpoint);
  const entry = entriesOf(readLog(), run).find(
    (e): e is MilestoneEntry => e.kind === 'milestone' && e.generation === generation,
  );
  if (entry === undefined) {
    throw new Error(`${run}/${generation} is not a logged milestone: only a logged one is reproducible`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'alphazero-'));
  const config = join(dir, 'config.json');
  writeJson(config, entry.config);
  return { entry, config };
}

/** `milestone <checkpoint>`: [Z11-31] on one logged milestone, printed, not logged. */
export async function milestoneCommand(checkpoint: string, workers: number): Promise<void> {
  const { entry, config } = loggedMilestone(checkpoint);
  const bin = buildRelease();
  const c = entry.config as RunConfig;
  const m = await runMilestone({ binary: bin, checkpoint, config }, c.milestoneSimulations, workers);
  for (const [rung, r] of Object.entries(m.rungs)) {
    process.stdout.write(`${rung}: ${(100 * r.winrate).toFixed(1)}% (logged ${(100 * entry.results[rung as keyof typeof entry.results].winrate).toFixed(1)}%)\n`);
  }
  process.stdout.write(`progress ${progress(m.rungs).toFixed(2)} (logged ${entry.progress.toFixed(2)})\n`);
}

/** `gate <checkpoint>` by hand ([Z11-61]): a pass ends the run; a failure changes nothing. */
export async function gateCommand(checkpoint: string, workers: number): Promise<void> {
  const { run, generation } = parseMilestonePath(checkpoint);
  await withLock(`gate ${run}/${generation}`, async () => {
    const { entry, config } = loggedMilestone(checkpoint);
    const bin = buildRelease();
    const g = await runGate({ binary: bin, checkpoint, config }, run, generation, entry.config as RunConfig, entry.config, workers);
    const line = `${(100 * g.winrate).toFixed(1)}% against sharp, null ${(100 * g.nullWinrate).toFixed(1)}%, latency p95 ${g.latency.p95.toFixed(0)} ms`;
    if (g.passed) {
      appendLog({ kind: 'manual-gate', run, date: today(), generation, gate: g.path, decision: 'done', reason: `gate passed: ${line}.` });
    }
    process.stdout.write(`gate ${g.passed ? 'PASSED' : 'FAILED'}: ${line}; written to ${g.path}\n`);
  });
}
