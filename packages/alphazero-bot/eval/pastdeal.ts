/**
 * The past-deal refinement's lanes ([0011 Z11-97] to [Z11-99]) and what they
 * decide about `master` ([0012 T12-36], [T12-37]).
 *
 * - `past-deal fit <checkpoint>`: the constants fitted to a checkpoint, as
 *   `milestones/<run>/<generation>/pastdeal.json`, for a person to commit.
 * - `past-deal match <checkpoint>`: `master` with the refinement against
 *   `master` without it, at the default count, by [T12-34]'s test; on an
 *   accept, `shipped.json` names the file.
 * - `past-deal drop <run>:<generation> --reason …`: ships `master` without it.
 * - `climb <checkpoint> --to <n> --latency <file>`: one step of the climb, `n`
 *   simulations against the default, neither refined, with whether `n` keeps
 *   the budget by the latency lane's figures. The steps decide the
 *   configurations the interface offers ([T12-37]).
 *
 * Each match is a pure function of its seeds and players, so it runs under
 * load; only the latency lane needs the machine idle.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { MASTER_SIMULATIONS } from '../web/settings.js';
import { allocateBase, anchorsExist, readAnchors, usedSeeds } from './anchors.js';
import type { RunConfig } from './config.js';
import { alphazero, buildRelease } from './crate.js';
import type { ClimbEntry, LogEntry, MilestoneEntry, PastDealEntry } from './decision.js';
import { readJson, sha256File, writeJson } from './files.js';
import { withLock } from './lock.js';
import { appendLog, readLog } from './log.js';
import { PACKAGE, RUNS, milestoneCheckpoint, parseMilestonePath } from './paths.js';
import { memberName } from './pool.js';
import { SHIPPED, SHIP_TEST, bounds, currentMaster, llr, playSequential, scoreOf, writeShipped } from './ship.js';
import { keepsBudget, slower, type PassFigures } from './web-budget.js';

/** Where a milestone's refinement settings live. */
export function pastDealPath(m: { run: string; generation: number }): string {
  return join(PACKAGE, 'milestones', m.run, String(m.generation), 'pastdeal.json');
}

/** The panel the fit reads ([0011 Z11-83]). */
export const PANEL = join(PACKAGE, 'panel', 'positions.bin');

function today(): string {
  return new Date().toISOString();
}

function loggedConfig(m: { run: string; generation: number }, log: readonly LogEntry[]): RunConfig {
  const entry = log.find((e) => e.kind === 'milestone' && e.run === m.run && e.generation === m.generation) as MilestoneEntry | undefined;
  if (entry === undefined) throw new Error(`no logged milestone ${memberName(m)}`);
  return entry.config as RunConfig;
}

/** `m`'s logged config at `simulations` with the shipped proof cap: what `play` reads ([0011 Z11-60]). */
function playConfig(m: { run: string; generation: number }, log: readonly LogEntry[], simulations: number): string {
  const dir = join(RUNS, 'master');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${m.run}-${m.generation}-${simulations}.json`);
  const shipped = readJson<{ endgameNodes: number }>(SHIPPED);
  writeJson(path, { ...loggedConfig(m, log), playSimulations: simulations, playEndgameNodes: shipped.endgameNodes });
  return path;
}

function requireMaster(checkpoint: string, log: readonly LogEntry[]): { run: string; generation: number } {
  const m = parseMilestonePath(checkpoint);
  const master = currentMaster(log);
  if (master === null || memberName(master) !== memberName(m)) {
    throw new Error(`${memberName(m)} is not master${master === null ? '' : ` (${memberName(master)} is)`}: the refinement and the climb are about the player that ships`);
  }
  return m;
}

/** `past-deal fit <checkpoint>` ([Z11-97]): runs the binary's fit on the panel. */
export function pastDealFit(checkpoint: string, threads: number = Math.max(1, Math.floor(cpus().length / 2))): void {
  const m = parseMilestonePath(checkpoint);
  const out = pastDealPath(m);
  const text = alphazero(buildRelease(), [
    'past-deal-fit',
    milestoneCheckpoint(m.run, m.generation),
    '--panel',
    PANEL,
    '--out',
    out,
    '--threads',
    String(threads),
  ]);
  process.stdout.write(text);
  process.stdout.write(`wrote ${out}, to be committed\n`);
}

/** `past-deal match <checkpoint>` ([Z11-98]). */
export async function pastDealMatch(checkpoint: string, workers: number): Promise<void> {
  await withLock('past-deal match', async () => {
    const log = readLog();
    const m = requireMaster(checkpoint, log);
    const file = pastDealPath(m);
    if (!existsSync(file)) throw new Error(`no ${file}: run \`past-deal fit\` first`);
    const sha256 = sha256File(file);
    const fitted = (JSON.parse(readFileSync(file, 'utf8')) as { checkpointSha256: string }).checkpointSha256;
    if (fitted !== sha256File(milestoneCheckpoint(m.run, m.generation))) throw new Error(`${file} was not fitted to ${memberName(m)}`);
    const simulations = MASTER_SIMULATIONS.default;
    const binary = buildRelease();
    const config = playConfig(m, log, simulations);
    const ck = milestoneCheckpoint(m.run, m.generation);
    const key = `pastdeal:${memberName(m)}/${simulations}/${sha256}`;
    const base = allocateBase(key, SHIP_TEST.maxGames / 2, usedSeeds(anchorsExist() ? readAnchors() : null, log));
    const match = await playSequential(
      { binary, checkpoint: ck, config, search: 'play', pastDeal: file },
      { binary, checkpoint: ck, config, search: 'play' },
      base,
      workers,
      `past-deal on ${memberName(m)} at ${simulations}`,
    );
    const last = match.looks[match.looks.length - 1];
    const { games, score } = scoreOf(last);
    const entry: PastDealEntry = {
      kind: 'pastDeal',
      run: m.run,
      date: today(),
      generation: m.generation,
      decision: match.decision,
      sha256,
      simulations,
      seedBase: match.seedBase,
      test: SHIP_TEST,
      looks: match.looks,
      seconds: match.seconds,
      reason:
        `${memberName(m)} with its pastdeal.json against itself without, at ${simulations} simulations: ${games} games, ` +
        `${(100 * score).toFixed(1)}%, LLR ${llr(last).toFixed(2)} in ${bounds().map((b) => b.toFixed(2)).join('..')}: ` +
        (match.decision === 'accept' ? 'master ships with it.' : 'master ships without it.'),
    };
    appendLog(entry);
    writeShipped({ ...readJson<Record<string, unknown>>(SHIPPED), pastDeal: match.decision === 'accept' ? { sha256 } : null });
    process.stdout.write(`${entry.reason}\n`);
  });
}

/** `past-deal drop <run>:<generation> --reason …` ([T12-36]): `master` ships without the refinement, on a person's word. */
export async function pastDealDrop(m: { run: string; generation: number }, reason: string): Promise<void> {
  await withLock('past-deal drop', () => {
    const log = readLog();
    requireMaster(milestoneCheckpoint(m.run, m.generation), log);
    if (reason.length < 20) throw new Error('a drop needs its reason, at least a sentence');
    appendLog({ kind: 'pastDeal', run: m.run, date: today(), generation: m.generation, decision: 'drop', sha256: null, reason });
    writeShipped({ ...readJson<Record<string, unknown>>(SHIPPED), pastDeal: null });
    process.stdout.write(`master ${memberName(m)} ships without the past-deal refinement: ${reason}\n`);
  });
}

/** The latency lane's `--json` record, as the climb reads it. */
interface LatencyRecord {
  shipped: { run: string; generation: number; checkpointSha256: string };
  pastDeal: string;
  counts: { simulations: number; passes: PassFigures[] }[];
}

/** `climb <checkpoint> --to <n> --latency <file>` ([Z11-99]): one step from the default the climb has reached. */
export async function climb(checkpoint: string, to: number, latency: string, workers: number): Promise<void> {
  await withLock('climb', async () => {
    const log = readLog();
    const m = requireMaster(checkpoint, log);
    const reached = climbed(log, m);
    if (reached.ended) throw new Error(`${memberName(m)}'s climb has ended at ${reached.default}${reached.deep === null ? '' : `, deep ${reached.deep}`}`);
    const from = reached.default;
    if (!(Number.isInteger(to) && to > from && to <= MASTER_SIMULATIONS.max)) {
      throw new Error(`--to must be a count above the default, ${from}, and at most ${MASTER_SIMULATIONS.max}`);
    }
    const record = JSON.parse(readFileSync(latency, 'utf8')) as LatencyRecord;
    if (record.shipped.run !== m.run || record.shipped.generation !== m.generation) {
      throw new Error(`${latency} timed ${memberName(record.shipped)}, not ${memberName(m)}`);
    }
    const timed = record.counts.find((c) => c.simulations === to);
    if (timed === undefined) throw new Error(`${latency} did not time ${to} simulations`);
    const figs = slower(timed.passes);
    const binary = buildRelease();
    const ck = milestoneCheckpoint(m.run, m.generation);
    const key = `climb:${memberName(m)}/${from}/${to}`;
    const base = allocateBase(key, SHIP_TEST.maxGames / 2, usedSeeds(anchorsExist() ? readAnchors() : null, log));
    const match = await playSequential(
      { binary, checkpoint: ck, config: playConfig(m, log, to), search: 'play' },
      { binary, checkpoint: ck, config: playConfig(m, log, from), search: 'play' },
      base,
      workers,
      `climb ${from} to ${to} on ${memberName(m)}`,
    );
    const last = match.looks[match.looks.length - 1];
    const { games, score } = scoreOf(last);
    const fits = keepsBudget(figs);
    const entry: ClimbEntry = {
      kind: 'climb',
      run: m.run,
      date: today(),
      generation: m.generation,
      from,
      to,
      latency: { p95: Math.round(figs.p95), p99: Math.round(figs.p99), max: Math.round(figs.max), pastDeal: record.pastDeal },
      fits,
      decision: match.decision,
      seedBase: match.seedBase,
      test: SHIP_TEST,
      looks: match.looks,
      seconds: match.seconds,
      reason:
        `${to} simulations against ${from} on ${memberName(m)}: ${games} games, ${(100 * score).toFixed(1)}%, ` +
        `LLR ${llr(last).toFixed(2)}; at ${to}, p95 ${figs.p95.toFixed(0)} ms, p99 ${figs.p99.toFixed(0)} ms, max ${figs.max.toFixed(0)} ms: ` +
        (match.decision === 'reject' ? 'no stronger, so the climb stops.' : fits ? 'stronger and in budget: the next default.' : 'stronger, over budget: deep.'),
    };
    appendLog(entry);
    process.stdout.write(`${entry.reason}\n`);
  });
}

/** What the climb's records decide ([T12-37]): the default, `deep` if any, and whether it has ended. */
export interface Configurations {
  default: number;
  deep: number | null;
  ended: boolean;
}

/** Where every climb starts: the default intent 0010 measured. */
export const CLIMB_FROM = 10_000;

/**
 * [T12-37]: the configurations `master`'s climb decides. From 10 000, each
 * step accepted within budget is the next default; the first step accepted
 * over budget is `deep`, and ends the climb; a rejected step ends it with no
 * `deep`. Every step climbs from the default of its time. With no step yet,
 * 10 000 stands.
 */
export function climbed(log: readonly LogEntry[], master: { run: string; generation: number }): Configurations {
  let current = CLIMB_FROM;
  let deep: number | null = null;
  let ended = false;
  for (const e of log) {
    if (e.kind !== 'climb' || e.run !== master.run || e.generation !== master.generation) continue;
    if (ended) throw new Error(`a climb step from ${e.from} after the climb ended`);
    if (e.from !== current) throw new Error(`a climb step from ${e.from}, not the default of its time, ${current}`);
    if (e.decision === 'reject') ended = true;
    else if (e.fits) current = e.to;
    else {
      deep = e.to;
      ended = true;
    }
  }
  return { default: current, deep, ended };
}

/**
 * [T12-36]: why `shipped.json`'s refinement is not settled for `master`;
 * empty when it is. Non-null only beside an accepting match for the same
 * checkpoint, file and default count; null only beside a rejecting match at
 * the default, or a drop, for `master`.
 */
export function pastDealFaults(
  log: readonly LogEntry[],
  shipped: { run: string; generation: number; pastDeal: { sha256: string } | null },
  simulations: number,
): string[] {
  const mine = log.filter(
    (e): e is PastDealEntry => e.kind === 'pastDeal' && e.run === shipped.run && e.generation === shipped.generation,
  );
  const last = mine[mine.length - 1];
  const name = memberName(shipped);
  if (shipped.pastDeal !== null) {
    if (last === undefined || last.decision !== 'accept' || last.sha256 !== shipped.pastDeal.sha256) {
      return [`shipped.json names a pastdeal.json no accepting match on ${name} played`];
    }
    if (last.simulations !== simulations) return [`the refinement was accepted at ${last.simulations} simulations, not the default ${simulations}`];
    return [];
  }
  if (last === undefined) {
    return [`master ${name} has no past-deal decision: \`past-deal fit\` then \`past-deal match\`, or \`past-deal drop --reason\``];
  }
  if (last.decision === 'accept') return [`an accepting match on ${name} is not in shipped.json`];
  if (last.decision === 'reject' && last.simulations !== simulations) {
    return [`the refinement was rejected at ${last.simulations} simulations, not the default ${simulations}: play it again`];
  }
  return [];
}
