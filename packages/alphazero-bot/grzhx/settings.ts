/**
 * Every setting of both players, its default, and its syntax ([G13-21] to
 * [G13-26]). `play`, `timing` and `info` resolve settings here and nowhere
 * else ([G13-30]).
 *
 * Their search's defaults are not copied: the host reads them from the
 * actor's record and their dataclasses at run time ([G13-23]), and their own
 * library judges the values when the host configures each cell ([G13-25]).
 * What is checked here is what can be checked without them: that a key is
 * one of theirs or ours, and that its value has the right type.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG, MILESTONES, PACKAGE, milestoneCheckpoint } from '../eval/paths.js';
import { BUILD_OPTIONS, THEIR_CAP, type BuildOption } from './build.js';

/** 0011's `MAX_SIMULATIONS`: the most `playSimulations` may be. */
export const OUR_CAP = 65_535;

export type Budget = { kind: 'sims'; n: number } | { kind: 'ms'; n: number };
/** A budget, or `null` for the side's default count ([G13-24]). */
export type BudgetSpec = Budget | null;

export class SettingError extends Error {}

function whole(text: string, what: string, min: number, max: number): number {
  const n = Number(text);
  if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new SettingError(`${what} must be a whole number from ${min} to ${max}, not "${text}"`);
  }
  return n;
}

function decimal(text: string, what: string): number {
  const n = Number(text);
  if (text.trim() === '' || !Number.isFinite(n)) throw new SettingError(`${what} must be a number, not "${text}"`);
  return n;
}

/** `--us` and `--them`: `<n>`, `sims:<n>` or `ms:<n>`, comma-separated. Absent: the default count. */
export function parseBudgets(text: string | undefined, side: 'us' | 'them'): BudgetSpec[] {
  if (text === undefined) return [null];
  const cap = side === 'us' ? OUR_CAP : THEIR_CAP;
  const out: BudgetSpec[] = [];
  for (const item of text.split(',').map((x) => x.trim()).filter((x) => x !== '')) {
    const m = /^(?:(sims|ms):)?(.+)$/.exec(item)!;
    if (m[1] === 'ms') out.push({ kind: 'ms', n: whole(m[2], `--${side} ms:`, 0, 3_600_000) });
    else out.push({ kind: 'sims', n: whole(m[2], `--${side} simulations`, side === 'them' ? 2 : 1, cap) });
  }
  if (out.length === 0) throw new SettingError(`--${side} names no budget`);
  return out;
}

export function budgetLabel(b: BudgetSpec): string {
  return b === null ? 'default' : b.kind === 'ms' ? `ms:${b.n}` : String(b.n);
}

/** `--us-set k=v` and `--them-set k=v`, repeatable: the last of a key wins. */
export function parseSets(items: readonly string[], side: 'us' | 'them'): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    const i = item.indexOf('=');
    if (i <= 0) throw new SettingError(`--${side}-set takes key=value, not "${item}"`);
    out.set(item.slice(0, i).trim(), item.slice(i + 1).trim());
  }
  return out;
}

// ---- ours ([G13-22]) -------------------------------------------------------

export interface OurSettings {
  /** `run/generation` of a logged milestone. */
  checkpoint: string;
  cpuct: number;
  fpu: number;
  /** The endgame proof's node cap; 0 is off ([0011 Z11-76]). */
  endgame: number;
  /** The most simulations a clocked move may run ([G13-27]). */
  ceiling: number;
}

export interface OurResolved {
  settings: OurSettings;
  source: Record<keyof OurSettings | 'simulations', string>;
  /** The milestone's checkpoint file. */
  checkpointPath: string;
  /** The milestone's logged config, which `serve` is handed a copy of. */
  config: Record<string, unknown>;
  /** `--us`'s default: the milestone's `playSimulations` ([G13-24]). */
  defaultSimulations: number;
}

const OUR_KEYS = ['checkpoint', 'cpuct', 'fpu', 'endgame', 'ceiling'] as const;

interface Shipped {
  run: string;
  generation: number;
  endgameNodes: number;
}

export function readShipped(): Shipped {
  return JSON.parse(readFileSync(join(PACKAGE, 'web', 'shipped.json'), 'utf8')) as Shipped;
}

function milestoneConfig(run: string, generation: number): Record<string, unknown> {
  const entries = JSON.parse(readFileSync(LOG, 'utf8')) as { kind: string; run: string; generation: number; config: Record<string, unknown> }[];
  const entry = entries.find((e) => e.kind === 'milestone' && e.run === run && e.generation === generation);
  if (entry === undefined) throw new SettingError(`${run}/${generation} is not a logged milestone in milestones/log.json`);
  return entry.config;
}

/** [G13-22]: our settings, defaults included, and where each came from. */
export function resolveOurs(sets: Map<string, string>): OurResolved {
  for (const k of sets.keys()) {
    if (!(OUR_KEYS as readonly string[]).includes(k)) throw new SettingError(`unknown setting of ours: "${k}" (ours are ${OUR_KEYS.join(', ')})`);
  }
  const shipped = readShipped();
  const given = sets.get('checkpoint');
  let run = shipped.run;
  let generation = shipped.generation;
  if (given !== undefined) {
    const m = /^([A-Za-z0-9_-]+)\/(\d+)$/.exec(given);
    if (!m) throw new SettingError(`checkpoint must be run/generation, a logged milestone, not "${given}"`);
    run = m[1];
    generation = Number(m[2]);
  }
  const checkpointPath = milestoneCheckpoint(run, generation);
  if (!checkpointPath.startsWith(MILESTONES) || !existsSync(checkpointPath)) throw new SettingError(`no milestone checkpoint at ${checkpointPath}`);
  const config = milestoneConfig(run, generation);
  const num = (k: 'cpuct' | 'fpu', logged: unknown): [number, string] =>
    sets.has(k) ? [decimal(sets.get(k)!, k), 'given'] : [Number(logged), "the milestone's logged config"];
  const [cpuct, cpuctFrom] = num('cpuct', config.cpuct);
  const [fpu, fpuFrom] = num('fpu', config.fpu);
  const endgame = sets.has('endgame') ? whole(sets.get('endgame')!, 'endgame', 0, 1_000_000_000) : shipped.endgameNodes;
  const ceiling = sets.has('ceiling') ? whole(sets.get('ceiling')!, 'ceiling', 1, OUR_CAP) : OUR_CAP;
  const playSimulations = Number(config.playSimulations);
  if (!Number.isInteger(playSimulations) || playSimulations < 1) throw new SettingError(`${run}/${generation}'s config has no playSimulations: give --us`);
  return {
    settings: { checkpoint: `${run}/${generation}`, cpuct, fpu, endgame, ceiling },
    source: {
      checkpoint: given !== undefined ? 'given' : 'web/shipped.json',
      cpuct: cpuctFrom,
      fpu: fpuFrom,
      endgame: sets.has('endgame') ? 'given' : "web/shipped.json's endgame cap",
      ceiling: sets.has('ceiling') ? 'given' : "OUR_CAP, 0011's MAX_SIMULATIONS",
      simulations: "the milestone's playSimulations",
    },
    checkpointPath,
    config,
    defaultSimulations: playSimulations,
  };
}

/**
 * [G13-22]: the config `serve` is handed for one budget: the milestone's,
 * with `cpuct`, `fpu` and `playEndgameNodes` replaced and `playSimulations`
 * the count, or the ceiling under a clock. Nothing else changes.
 */
export function ourConfig(ours: OurResolved, budget: BudgetSpec): Record<string, unknown> {
  const s = ours.settings;
  const simulations = budget === null ? ours.defaultSimulations : budget.kind === 'ms' ? s.ceiling : budget.n;
  return { ...ours.config, cpuct: s.cpuct, fpu: s.fpu, playEndgameNodes: s.endgame, playSimulations: simulations };
}

// ---- theirs ([G13-23]) -----------------------------------------------------

/** Their settings by our names; the host maps each to their field ([G13-23]). */
export const THEIR_WHOLE = ['candidates', 'maxDepth', 'chanceInitial', 'chanceCap', 'qMode', 'subtreeReuse', 'cacheCapacity', 'symmetricCache', 'trees', 'threads', 'torchThreads', 'chunk'] as const;
export const THEIR_DECIMAL = ['valueScale', 'maxvisitInit', 'gumbelScale', 'qFloor', 'chanceCoefficient', 'chanceExponent', 'chanceSensitivity', 'afterstatePrior'] as const;

export interface TheirGiven {
  /** Only what was given; the host resolves the rest. */
  settings: Record<string, number>;
  build: BuildOption[];
}

/** [G13-21]: their keys and value types; their library judges the ranges ([G13-25]). */
export function parseTheirs(sets: Map<string, string>): TheirGiven {
  const settings: Record<string, number> = {};
  let build: BuildOption[] = [];
  for (const [k, v] of sets) {
    if ((THEIR_WHOLE as readonly string[]).includes(k)) {
      const floor = ['trees', 'threads', 'torchThreads'].includes(k) ? 1 : k === 'chunk' ? 2 : 0;
      const ceiling = k === 'chunk' ? THEIR_CAP : 1 << 30;
      settings[k] = whole(v, k, floor, ceiling);
    } else if ((THEIR_DECIMAL as readonly string[]).includes(k)) {
      settings[k] = decimal(v, k);
    } else if (k === 'build') {
      const parts = v === '' || v === 'none' ? [] : v.split('+');
      for (const p of parts) {
        if (!(BUILD_OPTIONS as readonly string[]).includes(p)) throw new SettingError(`build takes ${BUILD_OPTIONS.join(', ')} joined by +, not "${p}"`);
      }
      build = [...new Set(parts as BuildOption[])].sort();
    } else {
      throw new SettingError(`unknown setting of theirs: "${k}" (theirs are ${[...THEIR_WHOLE, ...THEIR_DECIMAL, 'build'].join(', ')})`);
    }
  }
  return { settings, build };
}

/** [G13-25]: what can be refused before the host is asked. */
export function checkTheirBudgets(budgets: readonly BudgetSpec[], given: TheirGiven): void {
  for (const b of budgets) {
    if (b?.kind === 'ms' && (given.settings.trees ?? 1) > 1) {
      throw new SettingError('a clock of theirs takes trees 1: their timed search is one root ([G13-25])');
    }
  }
}

/**
 * [G13-35]: ⌊logical cores ÷ t⌋, `t` the larger of their `threads` and
 * `torchThreads`, less one when `t` is 1.
 */
export function defaultWorkers(logicalCores: number, threads: number, torchThreads: number): number {
  const t = Math.max(1, threads, torchThreads);
  return Math.max(1, Math.floor(logicalCores / t) - (t === 1 ? 1 : 0));
}
