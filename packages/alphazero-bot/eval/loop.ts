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
import { startingConfig, type RunConfig, type RunOrigin } from './config.js';
import { alphazero, buildRelease, trainer } from './crate.js';
import {
  GATE_TRIGGER,
  context,
  decide,
  atLeast,
  due,
  entriesOf,
  measureOf,
  gateSetting,
  freshStart,
  isDone,
  isStopped,
  patienceOf,
  progress,
  ruleEntries,
  stopPatience,
  type Decision,
  type GateOutcome,
  type GateSetting,
  type MilestoneEntry,
  type LogEntry,
  type MilestoneResults,
} from './decision.js';
import { readJson, sha256File, writeAtomic, writeJson } from './files.js';
import { findPlaySimulations, machine, meetsHalfBudget, measure, passesBudget, PROBE_SIMULATIONS, type Point } from './latency.js';
import { withLock } from './lock.js';
import { appendLog, readLog } from './log.js';
import { checkCounts, runGate, runMilestone, type Player } from './milestone.js';
import { CORPUS, LATENCY, PACKAGE, RUNS, checkRunName, milestoneCheckpoint, parseMilestonePath, runPaths } from './paths.js';
import { fitPool } from './elo.js';
import {
  POOL,
  currentPool,
  memberName,
  playPoolMilestone,
  playSeedRoundRobin,
  readSeed,
  type PoolSeed,
} from './pool.js';
import { provenance } from './provenance.js';
import { simulationCounts } from './series.js';
import {
  ANCHORS,
  BEYOND,
  allocateBase,
  fitAnchors,
  playAgainst,
  playAnchored,
  rateAgainst,
  anchorsExist,
  readAnchors,
  usedSeeds,
  type Anchor,
  type AnchorPairing,
  type AnchorsFile,
} from './anchors.js';
import { currentMaster, pendingShips, playShip, shipEntry, shippedFor, writeShipped } from './ship.js';

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

/** `<run>:<generation>`, the parent a run starts from ([Z11-66]). */
export function parseFrom(text: string): { run: string; generation: number } {
  const m = /^([^:]+):(\d+)$/.exec(text);
  if (m === null) throw new Error(`--from takes <run>:<generation>, not ${text}`);
  return { run: m[1], generation: Number(m[2]) };
}

/**
 * The settings a run started from another may change ([Z11-66]): how it
 * trains and self-plays. Not the network, not the search the milestones and
 * the gate measure, and not the latency record's `playSimulations`, all of
 * which the parent's measurements stand on.
 */
export const CHANGEABLE = [
  'gamesPerGeneration',
  'window',
  'stepsPerGeneration',
  'batch',
  'learningRate',
  'momentum',
  'weightDecay',
  'boundaryWeight',
  'selfPlaySimulations',
  'cheapSimulations',
  'fullSearchFraction',
  'threads',
  'torchThreads',
  'auxMarginWeight',
  'auxWallsWeight',
  'lookaheadDeals',
  'lookaheadAlpha',
  'improvedCScale',
  'improvedCVisit',
  'gumbelConsidered',
  'gumbelScale',
] as const;
export type Changeable = (typeof CHANGEABLE)[number];

/** `key=value` for one of [CHANGEABLE], a positive finite number. */
export function parseSet(text: string): [Changeable, number] {
  const m = /^([A-Za-z]+)=(.+)$/.exec(text);
  if (m === null) throw new Error(`--set takes <setting>=<number>, not ${text}`);
  const key = m[1] as Changeable;
  if (!CHANGEABLE.includes(key)) throw new Error(`--set cannot change ${m[1]}: only ${CHANGEABLE.join(', ')}`);
  const value = Number(m[2]);
  if (!(Number.isFinite(value) && value > 0)) throw new Error(`--set ${key} needs a positive number, not ${m[2]}`);
  return [key, value];
}

/**
 * [Z11-81]: `lookaheadDeals` and `lookaheadAlpha` together or not at all, the
 * deals a whole number in 1..=64 and alpha in (0, 1], as the crate will
 * insist when self-play first reads them. Refused here, before a run exists.
 */
export function checkLookahead(config: Pick<RunConfig, 'lookaheadDeals' | 'lookaheadAlpha'>): void {
  const { lookaheadDeals: deals, lookaheadAlpha: alpha } = config;
  if ((deals === undefined) !== (alpha === undefined)) {
    throw new Error('lookaheadDeals and lookaheadAlpha go together ([Z11-81])');
  }
  if (deals !== undefined && !(Number.isInteger(deals) && deals >= 1 && deals <= 64)) {
    throw new Error(`lookaheadDeals must be a whole number in 1..=64, not ${deals}`);
  }
  if (alpha !== undefined && !(alpha > 0 && alpha <= 1)) {
    throw new Error(`lookaheadAlpha must be in (0, 1], not ${alpha}`);
  }
}

/**
 * [Z11-87]: `improvedCVisit` only beside `improvedCScale`, the scale in (0, 10]
 * and the visit constant in [0, 10000], as the crate will insist when
 * self-play first reads them. Refused here, before a run exists.
 */
export function checkImproved(config: Pick<RunConfig, 'improvedCScale' | 'improvedCVisit'>): void {
  const { improvedCScale: scale, improvedCVisit: visit } = config;
  if (scale === undefined && visit !== undefined) throw new Error('improvedCVisit goes with improvedCScale ([Z11-87])');
  if (scale !== undefined && !(scale > 0 && scale <= 10)) throw new Error(`improvedCScale must be in (0, 10], not ${scale}`);
  if (visit !== undefined && !(visit >= 0 && visit <= 10000)) throw new Error(`improvedCVisit must be in [0, 10000], not ${visit}`);
}

/**
 * [Z11-89]: `gumbelScale` only beside `gumbelConsidered`, a whole number in
 * 2..=64, the scale in [0, 10], and never with a lookahead, as the crate
 * will insist when self-play first reads them. Refused here, before a run exists.
 */
export function checkGumbel(
  config: Pick<RunConfig, 'gumbelConsidered' | 'gumbelScale' | 'lookaheadDeals'>,
): void {
  const { gumbelConsidered: m, gumbelScale: scale, lookaheadDeals } = config;
  if (m === undefined && scale !== undefined) throw new Error('gumbelScale goes with gumbelConsidered ([Z11-89])');
  if (m === undefined) return;
  if (!(Number.isInteger(m) && m >= 2 && m <= 64)) throw new Error(`gumbelConsidered must be a whole number in 2..=64, not ${m}`);
  if (scale !== undefined && !(scale >= 0 && scale <= 10)) throw new Error(`gumbelScale must be in [0, 10], not ${scale}`);
  if (lookaheadDeals !== undefined) throw new Error('a Gumbel search has no lookahead ([Z11-89])');
}

/** [Z11-90]: the patience a new anchors run decides by. */
export const STOP_PATIENCE = 5;

/** A run's `stopPatience`: its parent's if it had one, else [STOP_PATIENCE] on the anchors, else none. */
function patienceFor(yardstick: string | undefined, inherited: number | undefined): { stopPatience?: number } {
  if (inherited !== undefined) return { stopPatience: inherited };
  return yardstick === 'anchors' ? { stopPatience: STOP_PATIENCE } : {};
}

/**
 * [Z11-66]'s config: the parent's, with a fresh seed, its own `augment`, the
 * changes asked for, and `from` recording the parent and what differs from it.
 */
export function childConfig(
  pc: RunConfig,
  origin: Omit<RunOrigin, 'changes'>,
  seed: number,
  augment: 'none' | 'displays' | undefined,
  set: Partial<Record<Changeable, number>> = {},
  gate?: GateSetting,
  yardstick?: 'ladder' | 'pool' | 'anchors',
): RunConfig {
  const {
    from: _grandparent,
    augment: parentAugment,
    gate: parentGate,
    yardstick: parentYardstick,
    stopPatience: parentPatience,
    ...inherited
  } = pc;
  const changes: RunOrigin['changes'] = {};
  for (const [k, v] of Object.entries(set) as [Changeable, number][]) {
    // An absent aux weight is 0, off ([Z11-67]); so is an absent playout cap
    // ([Z11-75]), an absent lookahead ([Z11-81]), an absent improved target
    // ([Z11-87]), and an absent Gumbel search ([Z11-89]).
    const was = inherited[k] ?? 0;
    if (was !== v) changes[k] = { parent: was, run: v };
  }
  checkLookahead({ ...inherited, ...set });
  checkImproved({ ...inherited, ...set });
  checkGumbel({ ...inherited, ...set });
  return {
    ...inherited,
    ...set,
    seed,
    augment: augment ?? parentAugment ?? 'none',
    // [Z11-68]: written only when set, so a config without it still reads as before.
    ...((gate ?? parentGate) === undefined ? {} : { gate: gate ?? parentGate }),
    // [Z11-73]: likewise the yardstick.
    ...((yardstick ?? parentYardstick) === undefined ? {} : { yardstick: yardstick ?? parentYardstick }),
    // [Z11-90]: a run on the anchors decides by patience, inherited or new.
    ...patienceFor(yardstick ?? parentYardstick, parentPatience),
    from: { ...origin, changes },
  };
}

/**
 * [Z11-58]: the run's directory, its config with a random seed, and checkpoint 0.
 * With `from` ([Z11-66]), the config is the parent's with a fresh seed, and
 * checkpoint 0 is the parent's checkpoint at that generation; `augment` is
 * the one setting that may differ from the parent's ([Z11-65]).
 */
export function initRun(
  name: string,
  from?: { run: string; generation: number },
  augment?: 'none' | 'displays',
  set: Partial<Record<Changeable, number>> = {},
  gate?: GateSetting,
  yardstick?: 'ladder' | 'pool' | 'anchors',
): void {
  checkRunName(name);
  const p = runPaths(name);
  if (existsSync(p.dir)) throw new Error(`${p.dir} already exists`);
  if (from === undefined && Object.keys(set).length > 0) throw new Error('--set goes with --from');
  if (from === undefined) {
    const config: RunConfig = {
      ...startingConfig(),
      ...(augment === undefined ? {} : { augment }),
      ...(gate === undefined ? {} : { gate }),
      ...(yardstick === undefined ? {} : { yardstick }),
      ...patienceFor(yardstick, undefined),
    };
    mkdirSync(p.dir, { recursive: true });
    writeJson(p.config, config);
    trainer(['init', '--run-dir', p.dir]);
    process.stdout.write(
      `run ${name}: checkpoint 0 written. Next, on an idle machine:\n` +
        `  pnpm -F alphazero-bot latency --run ${name}\n` +
        `  pnpm -F alphazero-bot throughput --run ${name}\n` +
        `then: pnpm -F alphazero-bot train --run ${name}\n`,
    );
    return;
  }
  checkRunName(from.run);
  const parent = runPaths(from.run);
  const pc = readConfig(from.run);
  if (pc.playSimulations === null) throw new Error(`run ${from.run} has no playSimulations: it never passed the latency lane`);
  if (!existsSync(parent.manifest(from.generation))) {
    throw new Error(`run ${from.run} has no complete generation ${from.generation}`);
  }
  const windowGenerations: number[] = [];
  for (let k = Math.max(0, from.generation - pc.window + 1); k < from.generation; k++) {
    if (!existsSync(parent.samples(k))) throw new Error(`run ${from.run} has no samples for generation ${k}`);
    windowGenerations.push(k);
  }
  const config = childConfig(
    pc,
    {
      run: from.run,
      generation: from.generation,
      checkpointSha256: sha256File(parent.checkpoint(from.generation)),
      windowGenerations,
      latencyRun: pc.from?.latencyRun ?? from.run,
    },
    startingConfig().seed,
    augment,
    set,
    gate,
    yardstick,
  );
  mkdirSync(p.dir, { recursive: true });
  writeJson(p.config, config);
  trainer([
    'init', '--run-dir', p.dir,
    '--from-run-dir', parent.dir, '--from-generation', String(from.generation),
  ]);
  process.stdout.write(
    `run ${name}: checkpoint 0 is ${from.run}'s generation ${from.generation}, with ${windowGenerations.length} ` +
      `generations of its samples in the window; playSimulations ${config.playSimulations} from ` +
      `latency/${config.from?.latencyRun}.json. Next:\n` +
      `  pnpm -F alphazero-bot throughput --run ${name}\n` +
      `then: pnpm -F alphazero-bot train --run ${name}\n`,
  );
}

/** The run whose latency record holds for `name` ([Z11-57], [Z11-66]). */
function latencyRun(name: string, config: RunConfig): string {
  return config.from?.latencyRun ?? name;
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
    if (config.from !== undefined) {
      throw new Error(`run ${name} starts from ${config.from.run}: its playSimulations is ${config.from.latencyRun}'s`);
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
  gateSet: GateSetting,
  pool?: string,
  scale: 'the pool' | 'the anchors' = 'the pool',
  patience?: { patience: number } & ReturnType<typeof patienceOf>,
): string {
  const p = measureOf(results);
  const ladder = 'rungs' in results;
  // [Z11-73]: a rating reads in whole Elo points.
  const show = ladder ? pct : (x: number): string => x.toFixed(0);
  const parts = ladder
    ? [`progress ${pct(p)} (sharp ${pct(results.rungs.sharp.winrate)})`]
    : [`rating ${show(p)} against ${scale}${pool === undefined ? '' : ` (${pool})`}`];
  if (fresh !== null) parts.push(`a fresh start: ${fresh}`);
  else if (patience !== undefined && patience.best !== null) {
    // [Z11-90]: measured against the run's best since its last fresh start.
    const b = patience.best;
    parts.push(
      patience.newBest
        ? `a new best, above ${show(b.progress)} at generation ${b.generation}`
        : `${show(b.progress)} at generation ${b.generation} is still the best, ` +
            `${patience.without} of ${patience.patience} milestones without beating it`,
    );
  } else if (previous !== null) {
    parts.push(
      atLeast(p, previous.progress)
        ? `improved on ${show(previous.progress)} at generation ${previous.generation}`
        : `did not improve on ${show(previous.progress)} at generation ${previous.generation}` +
            (previousImproved ? ', which had improved' : ', which had not improved either'),
    );
  }
  if (!ladder) parts.push(`${scale === 'the pool' ? 'the pool has' : 'the anchors have'} no gate`);
  else if (gateSet === 'off') parts.push('the gate is off for this run');
  else if (results.rungs.sharp.winrate < GATE_TRIGGER) parts.push(`sharp below ${pct(GATE_TRIGGER)}, so no gate`);
  else if (!gateDue) parts.push(`gate not due: progress has not passed ${pct(lastFailure ?? 0)}, where the last gate failed`);
  else if (gate !== null) {
    parts.push(
      `gate ${gate.passed ? 'passed' : 'failed'} (${pct(gate.winrate)} against sharp, null ${pct(gate.nullWinrate)}, ` +
        `latency ${gate.latencyPassed ? 'within' : 'over'} budget)`,
    );
  }
  return `${parts.join('; ')}: ${decision}.`;
}

/** [Z11-90]'s view for a milestone's reason, when the run sets a patience. */
function patienceView(
  entries: ReturnType<typeof ruleEntries>,
  results: MilestoneResults,
  patience: number | undefined,
): Parameters<typeof reasonFor>[11] {
  return patience === undefined ? undefined : { patience, ...patienceOf(entries, results) };
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
  const gateSet = gateSetting(config);
  const gateDue = due(entries, results, gateSet);
  let gate: GateOutcome | null = null;
  if (gateDue) {
    // The loop's own gate runs under the loop's lock, in this process ([Z11-61]).
    const g = await runGate(player, name, generation, config, config, workers);
    gate = { passed: g.passed, winrate: g.winrate, nullWinrate: g.nullWinrate, latencyPassed: g.latency.passed, path: g.path };
  }
  const patience = stopPatience(config);
  const decision = decide(entries, results, gate, patience);
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
    reason: reasonFor(results, previous, fresh, gateDue, gate, lastFailure, decision, previousImproved, gateSet, undefined, 'the pool', patienceView(entries, results, patience)),
  };
  appendLog(entry);
  process.stdout.write(`milestone ${name}/${generation}: ${entry.reason}\n`);
  return entry;
}

/** The run's config at the pool's count, which both sides of a pool game read ([Z11-73]). */
function poolConfig(name: string, config: RunConfig, simulations: number): string {
  const path = join(runPaths(name).dir, 'pool-config.json');
  writeJson(path, { ...config, milestoneSimulations: simulations });
  return path;
}

/** Step 5 of [Z11-28] for a run whose yardstick is the pool ([Z11-73], [Z11-74]). */
async function poolMilestoneStep(
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
  writeAtomic(dest.replace(/\.bin$/, '.parity'), readFileSync(p.checkpoint(generation).replace(/\.bin$/, '.parity')));
  writeAtomic(dest, readFileSync(p.checkpoint(generation)));

  const seed = readSeed();
  const log = readLog();
  const members = currentPool(seed, log);
  const side = { binary: bin, config: poolConfig(name, config, seed.simulations) };
  const played = await playPoolMilestone(side, dest, seed, members, workers);
  const prov = provenance();
  const results: MilestoneResults = { rating: played.record.rating, ladderHash: prov.ladderHash };
  const entries = ruleEntries(log, name);
  const { previous, previousImproved } = context(entries);
  const fresh = freshStart(entries, results);
  const patience = stopPatience(config);
  const decision = decide(entries, results, null, patience);
  const r = played.record;
  const pool =
    `±${r.se.toFixed(0)} over ${r.gamesPerMember + r.extraPerMember} games a champion` +
    `${r.extraPerMember > 0 ? `, ${r.extraPerMember} of them extra` : ''}; ` +
    (r.replaced === null
      ? `the weakest, ${memberName(r.weakest)} at ${r.weakest.rating.toFixed(0)}, keeps its place`
      : `replaces ${memberName(r.weakest)} at ${r.weakest.rating.toFixed(0)}`);
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
    simulations: played.simulations,
    results: played.results,
    ladderHash: prov.ladderHash,
    progress: measureOf(results),
    previousProgress: previous?.progress ?? null,
    freshStart: { fresh: fresh !== null, why: fresh },
    gate: { due: false, ran: false, outcome: null },
    pool: r,
    losses: lossesSince(name, previous?.generation ?? 0, generation),
    provenance: prov,
    decision,
    reason: reasonFor(results, previous, fresh, false, null, null, decision, previousImproved, gateSetting(config), pool, 'the pool', patienceView(entries, results, patience)),
  };
  appendLog(entry);
  process.stdout.write(`milestone ${name}/${generation}: ${entry.reason}\n`);
  return entry;
}

/** Step 5 of [Z11-28] for a run whose yardstick is the anchors ([Z11-85]). */
async function anchoredMilestoneStep(
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
  writeAtomic(dest.replace(/\.bin$/, '.parity'), readFileSync(p.checkpoint(generation).replace(/\.bin$/, '.parity')));
  writeAtomic(dest, readFileSync(p.checkpoint(generation)));

  const file = readAnchors();
  const log = readLog();
  const side = { binary: bin, config: anchorConfig(join(p.dir, 'anchors-config.json'), config, file.simulations) };
  const played = await playAnchored(side, dest, `${name}/${generation}`, file, log, workers);
  const prov = provenance();
  const results: MilestoneResults = { rating: played.record.rating, ladderHash: prov.ladderHash };
  const entries = ruleEntries(log, name);
  const { previous, previousImproved } = context(entries);
  const fresh = freshStart(entries, results);
  const patience = stopPatience(config);
  const decision = decide(entries, results, null, patience);
  const r = played.record;
  const note = `±${r.se.toFixed(0)} over ${r.gamesPerMember} games an anchor` +
    (r.beyond ? `; more than ${BEYOND} above the strongest anchor, so add a stronger one` : '');
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
    simulations: played.simulations,
    results: played.results,
    ladderHash: prov.ladderHash,
    progress: measureOf(results),
    previousProgress: previous?.progress ?? null,
    freshStart: { fresh: fresh !== null, why: fresh },
    gate: { due: false, ran: false, outcome: null },
    anchored: r,
    losses: lossesSince(name, previous?.generation ?? 0, generation),
    provenance: prov,
    decision,
    reason: reasonFor(results, previous, fresh, false, null, null, decision, previousImproved, gateSetting(config), note, 'the anchors', patienceView(entries, results, patience)),
  };
  appendLog(entry);
  process.stdout.write(`milestone ${name}/${generation}: ${entry.reason}\n`);
  await catchUpShips(name, side, file, workers);
  return entry;
}

/**
 * [0012 T12-34]: every ship match the run still owes, in log order: after an
 * anchored milestone that out-rates `master`, and when the loop comes back
 * to a run whose match was interrupted. A win names the milestone in
 * `web/shipped.json`, which a person commits with the log.
 */
async function catchUpShips(
  name: string,
  side: { binary: string; config: string },
  file: AnchorsFile,
  workers: number,
): Promise<void> {
  // Owed afresh before each match: a win changes `master`, and what is owed with it.
  for (;;) {
    const log = readLog();
    const candidate = pendingShips(log, name, file)[0];
    const master = currentMaster(log);
    if (candidate === undefined || master === null) return;
    await playAndShip(candidate, master, side, file, log, workers);
  }
}

/**
 * [0012 T12-34]: only a run's own loop settles what it owes, so another run's
 * owed matches are named here, each with the command that plays it.
 */
function warnOwedElsewhere(name: string, file: AnchorsFile): void {
  const log = readLog();
  const runs = new Set(log.filter((e) => e.kind === 'milestone' && e.run !== name).map((e) => e.run));
  for (const run of runs) {
    for (const m of pendingShips(log, run, file)) {
      process.stderr.write(`ship match owed: ${memberName(m)}; play it with pnpm -F alphazero-bot ship milestones/${m.run}/${m.generation}/checkpoint.bin\n`);
    }
  }
}

async function playAndShip(
  candidate: { run: string; generation: number },
  master: { run: string; generation: number },
  side: { binary: string; config: string },
  file: AnchorsFile,
  log: readonly LogEntry[],
  workers: number,
): Promise<void> {
  if (memberName(candidate) === memberName(master)) throw new Error(`${memberName(candidate)} is master already`);
  const key = `ship:${memberName(candidate)}`;
  const match = await playShip(side, milestoneCheckpoint(candidate.run, candidate.generation), master, key, file, log, workers);
  const entry = shipEntry(candidate, master, match, file.simulations, today());
  // The payload's record first computed, so a missing file fails before the log names it.
  const next = entry.decision === 'accept' ? shippedFor(candidate) : null;
  appendLog(entry);
  if (next !== null) writeShipped(next);
  process.stdout.write(`ship ${memberName(candidate)}: ${entry.reason}\n`);
}

/** `ship <checkpoint>` by hand ([0012 T12-34]): a logged milestone against `master`, whatever its rating. */
export async function shipCommand(checkpoint: string, workers: number): Promise<void> {
  await withLock('ship', async () => {
    const candidate = parseMilestonePath(checkpoint);
    const log = readLog();
    const master = currentMaster(log);
    if (master === null) throw new Error('no master in the log: `ship pin <run>:<generation> --reason …` names the first');
    const file = readAnchors();
    const { config } = loggedMember(candidate);
    const scratch = join(RUNS, 'anchors');
    mkdirSync(scratch, { recursive: true });
    const side = { binary: buildRelease(), config: anchorConfig(join(scratch, 'ship-config.json'), config, file.simulations) };
    await playAndShip(candidate, master, side, file, log, workers);
  });
}

/**
 * `ship pin <run>:<generation> --reason …` ([0012 T12-35]): names a logged
 * milestone `master` without a match, with the reason in the log. For the
 * first `master` under the ship match, and for a person's own call.
 */
export async function shipPin(m: { run: string; generation: number }, reason: string): Promise<void> {
  // The lock: a pin landing inside a loop's ship match would leave that match
  // naming a master that is no longer the master of its time.
  await withLock('ship pin', () => {
    loggedMember(m);
    if (reason.length < 20) throw new Error('a pin needs its reason, at least a sentence');
    const next = shippedFor(m);
    appendLog({ kind: 'ship', run: m.run, date: today(), generation: m.generation, decision: 'pin', master: null, reason });
    writeShipped(next);
    process.stdout.write(`master is ${memberName(m)}, pinned: ${reason}\n`);
  });
}

/** A config at the anchors' count, which both sides of an anchored game read. */
function anchorConfig(path: string, config: RunConfig, simulations: number): string {
  writeJson(path, { ...config, milestoneSimulations: simulations });
  return path;
}

/** A logged milestone's checkpoint and config, as the anchors' commands read them. */
function loggedMember(m: { run: string; generation: number }): { checkpoint: string; config: RunConfig } {
  const checkpoint = `milestones/${m.run}/${m.generation}/checkpoint.bin`;
  if (!existsSync(milestoneCheckpoint(m.run, m.generation))) throw new Error(`${checkpoint} is not committed`);
  const entry = readLog().find((e) => e.kind === 'milestone' && e.run === m.run && e.generation === m.generation) as
    | MilestoneEntry
    | undefined;
  if (entry === undefined) throw new Error(`no logged milestone ${memberName(m)}`);
  return { checkpoint, config: entry.config as RunConfig };
}

/**
 * [Z11-84]: the anchors' round robin, `games` a pairing at `simulations`, each
 * pairing on seeds of its own, the pinned member held at its rating. Writes
 * `milestones/anchors.json`, to be committed. Refuses when the file exists.
 */
export async function anchorsInit(
  members: { run: string; generation: number }[],
  pin: { run: string; generation: number; rating: number },
  games: number,
  simulations: number,
  gamesPerMember: number,
  workers: number,
): Promise<void> {
  await withLock('anchors init', async () => {
    if (existsSync(ANCHORS)) throw new Error('milestones/anchors.json exists: the anchors are made once; `anchors add` adds one');
    if (members.length < 2) throw new Error('the anchors need at least two members');
    if (!members.some((m) => memberName(m) === memberName(pin))) throw new Error(`the pin ${memberName(pin)} is not a member`);
    const loaded = members.map((m) => ({ ...m, ...loggedMember(m) }));
    const scratch = join(RUNS, 'anchors');
    mkdirSync(scratch, { recursive: true });
    const pinned = loggedMember(pin);
    const side = { binary: buildRelease(), config: anchorConfig(join(scratch, 'config.json'), pinned.config, simulations) };
    const started = Date.now();
    const empty: AnchorsFile = { simulations, gamesPerMember, pin, members: [], pairings: [], date: '', seconds: 0 };
    const pairings: AnchorPairing[] = [];
    for (let a = 0; a < loaded.length; a++) {
      for (let b = a + 1; b < loaded.length; b++) {
        const key = `init:${memberName(loaded[a])}:${memberName(loaded[b])}`;
        const base = allocateBase(key, games, usedSeeds({ ...empty, pairings }, readLog()));
        const opponent: Anchor = { ...loaded[b], rating: 0, se: 0, added: 'init' };
        const [s] = await playAgainst(side, join(PACKAGE, loaded[a].checkpoint), [opponent], [base], games, workers, `anchors ${memberName(loaded[a])}`);
        checkCounts(simulationCounts(s.games), simulations, 'anchors init');
        pairings.push({ a: memberName(loaded[a]), b: memberName(loaded[b]), games, score: s.games.reduce((t, g) => t + g.points, 0), seedBase: base });
      }
    }
    const ratings = fitAnchors(members, pairings, pin);
    const file: AnchorsFile = {
      simulations,
      gamesPerMember,
      pin,
      members: loaded.map((m, i) => ({ run: m.run, generation: m.generation, checkpoint: m.checkpoint, rating: ratings[i].rating, se: ratings[i].se, added: 'init' })),
      pairings,
      date: today(),
      seconds: Math.round((Date.now() - started) / 1000),
    };
    writeJson(ANCHORS, file);
    process.stdout.write(`anchors made in ${file.seconds} s: ${file.members.map((m) => `${memberName(m)} ${m.rating.toFixed(0)}±${m.se.toFixed(0)}`).join(', ')}\n`);
  });
}

/** [Z11-84]: one more anchor, rated against the others' fixed ratings on games of its own. */
export async function anchorsAdd(member: { run: string; generation: number }, games: number, workers: number): Promise<void> {
  await withLock('anchors add', async () => {
    const file = readAnchors();
    if (file.members.some((m) => memberName(m) === memberName(member))) throw new Error(`${memberName(member)} is already an anchor`);
    const loaded = loggedMember(member);
    const scratch = join(RUNS, 'anchors');
    mkdirSync(scratch, { recursive: true });
    const side = { binary: buildRelease(), config: anchorConfig(join(scratch, 'config.json'), loggedMember(file.pin).config, file.simulations) };
    const started = Date.now();
    const pairings: AnchorPairing[] = [];
    const bases: number[] = [];
    for (const m of file.members) {
      const used = usedSeeds({ ...file, pairings: [...file.pairings, ...pairings] }, readLog());
      bases.push(allocateBase(`add:${memberName(member)}:${memberName(m)}`, games, used));
      pairings.push({ a: memberName(member), b: memberName(m), games, score: 0, seedBase: bases[bases.length - 1] });
    }
    const series = await playAgainst(side, join(PACKAGE, loaded.checkpoint), file.members, bases, games, workers, `anchors add ${memberName(member)}`);
    checkCounts(simulationCounts(series.flatMap((s) => s.games)), file.simulations, 'anchors add');
    series.forEach((s, i) => (pairings[i].score = s.games.reduce((t, g) => t + g.points, 0)));
    const results = Object.fromEntries(series.map((s) => [memberName(s.anchor), s.result]));
    const rated = rateAgainst(file, results, bases[0]);
    file.members.push({ run: member.run, generation: member.generation, checkpoint: loaded.checkpoint, rating: rated.rating, se: rated.se, added: today() });
    file.pairings.push(...pairings);
    writeJson(ANCHORS, file);
    process.stdout.write(`anchor ${memberName(member)} added at ${rated.rating.toFixed(0)}±${rated.se.toFixed(0)} in ${Math.round((Date.now() - started) / 1000)} s\n`);
  });
}

/** [Z11-84]: a logged milestone rated against the anchors, appended to the log as a `rating` entry. */
export async function anchorsRate(checkpoint: string, workers: number): Promise<void> {
  await withLock('anchors rate', async () => {
    const { run, generation } = parseMilestonePath(checkpoint);
    const file = readAnchors();
    const { config } = loggedMember({ run, generation });
    const scratch = join(RUNS, 'anchors');
    mkdirSync(scratch, { recursive: true });
    const side = { binary: buildRelease(), config: anchorConfig(join(scratch, 'rate-config.json'), config, file.simulations) };
    const log = readLog();
    const played = await playAnchored(side, milestoneCheckpoint(run, generation), `rate:${run}/${generation}`, file, log, workers);
    const r = played.record;
    appendLog({
      kind: 'rating',
      run,
      date: today(),
      generation,
      anchored: r,
      results: played.results,
      seconds: played.seconds,
      reason: `rated ${r.rating.toFixed(0)} ±${r.se.toFixed(0)} against the anchors over ${r.gamesPerMember} games an anchor` +
        (r.beyond ? `; more than ${BEYOND} above the strongest anchor` : ''),
    });
    process.stdout.write(`${run}/${generation}: ${r.rating.toFixed(1)} ±${r.se.toFixed(1)} against the anchors\n`);
  });
}

/**
 * [Z11-73]: seeds the pool with a round robin among `members`, `games` a
 * pairing at `simulations`, the first member the anchor at 0 Elo. Writes
 * `milestones/pool.json`, to be committed. Refuses when a pool exists.
 */
export async function poolInit(
  members: { run: string; generation: number }[],
  games: number,
  simulations: number,
  workers: number,
): Promise<void> {
  await withLock('pool init', async () => {
    if (existsSync(POOL)) throw new Error('milestones/pool.json exists: the pool is seeded once');
    if (members.length < 2) throw new Error('a pool needs at least two members');
    const seeded = members.map((m) => {
      const checkpoint = `milestones/${m.run}/${m.generation}/checkpoint.bin`;
      if (!existsSync(milestoneCheckpoint(m.run, m.generation))) throw new Error(`${checkpoint} is not committed`);
      return { ...m, checkpoint };
    });
    // The anchor's config as its committed log entry holds it, so the pool is
    // seeded from the repository alone, never from git-ignored `runs/`.
    const anchorEntry = readLog().find(
      (e) => e.kind === 'milestone' && e.run === members[0].run && e.generation === members[0].generation,
    ) as MilestoneEntry | undefined;
    if (anchorEntry === undefined) throw new Error(`no logged milestone ${memberName(members[0])}`);
    const config = anchorEntry.config as RunConfig;
    const scratch = join(RUNS, 'pool-seed');
    mkdirSync(scratch, { recursive: true });
    const configPath = join(scratch, 'config.json');
    writeJson(configPath, { ...config, milestoneSimulations: simulations });
    const side = { binary: buildRelease(), config: configPath };
    const { pairings, seconds } = await playSeedRoundRobin(side, seeded, games, simulations, workers);
    const index = new Map(seeded.map((m, i) => [memberName(m), i]));
    const ratings = fitPool(
      seeded.length,
      pairings.map((q) => ({ a: index.get(q.a) ?? -1, b: index.get(q.b) ?? -1, games: q.games, score: q.score })),
      0,
    );
    const seed: PoolSeed = {
      simulations,
      gamesPerMember: games,
      anchor: { run: members[0].run, generation: members[0].generation },
      members: seeded.map((m, i) => ({ ...m, rating: ratings[i].rating, se: ratings[i].se })),
      date: today(),
      pairings,
      seconds,
    };
    writeJson(POOL, seed);
    process.stdout.write(
      `pool seeded in ${seconds} s: ${seed.members.map((m) => `${memberName(m)} ${m.rating.toFixed(0)}±${m.se.toFixed(0)}`).join(', ')}\n`,
    );
  });
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
    const latencyFile = join(LATENCY, `${latencyRun(name, config)}.json`);
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
    // [0012 T12-34]: a ship match an interruption left unplayed is played
    // first, before a stop or a done can turn the loop away: it settles
    // `master`, not the run's course.
    const bin = buildRelease();
    if (config.yardstick === 'anchors' && anchorsExist()) {
      const file = readAnchors();
      const side = { binary: bin, config: anchorConfig(join(p.dir, 'anchors-config.json'), config, file.simulations) };
      await catchUpShips(name, side, file, opts.workers);
      warnOwedElsewhere(name, file);
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
        const step =
          config.yardstick === 'pool' ? poolMilestoneStep : config.yardstick === 'anchors' ? anchoredMilestoneStep : milestoneStep;
        decision = (await step(name, next, config, state, bin, opts.workers)).decision;
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
