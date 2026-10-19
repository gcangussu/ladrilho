/**
 * `grzhx timing` ([G13-47], [G13-48]): how long each player takes per move at
 * a range of look-ahead counts, on this machine, so someone can pick counts
 * that give each side about the same time and still get a match that
 * repeats; and the README table rendered from it.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromCanonical, toJSON, type AzulJSON } from 'engine';
import { corpusBlocks, parseBlock } from '../eval/blocks.js';
import { writeJson } from '../eval/files.js';
import { importArgs } from './convert.js';
import { framedPosition, readSplitAnswer, type Host } from './processes.js';
import { HERE } from './release.js';
import { ourConfig, type OurResolved } from './settings.js';

export const TIMING_PATH = join(HERE, 'timing.json');
export const README_PATH = join(HERE, 'README.md');
export const DEFAULT_OURS = [500, 1000, 2000, 4000, 8000, 11300, 16000];
export const DEFAULT_THEIRS = [128, 256, 512, 1024, 2048, 4096, 8192];

export interface Stats {
  median: number;
  p90: number;
  mean: number;
  max: number;
}

export interface TimingRow {
  side: 'ours' | 'theirs';
  simulations: number;
  ms: Stats;
}

export interface Timing {
  measured: string;
  machine: { cpu: string; logicalCores: number; os: string };
  ours: { checkpoint: string; sha256: string; settings: Record<string, unknown> };
  theirs: { commit: string; build: string[]; cxxFlags: string[]; settings: Record<string, unknown> };
  positions: number;
  rows: TimingRow[];
  movesPerGame: { games: number; mean: number; max: number };
}

export function stats(xs: readonly number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  const r = (x: number): number => Math.round(x * 10) / 10;
  return { median: r(at(0.5)), p90: r(at(0.9)), mean: r(s.reduce((a, b) => a + b, 0) / s.length), max: r(s[s.length - 1]) };
}

/** Every tenth non-terminal position of the latency corpus ([0011 Z11-38]). */
export function timingPositions(): AzulJSON[] {
  const all = corpusBlocks().map((b) => toJSON(fromCanonical(parseBlock(b), 0)));
  return all.filter((j) => !j.isTerminal).filter((_, i) => i % 10 === 0);
}

/** Our move times at `simulations`: one `play` per position, so every search is fresh. */
export function timeOurs(binary: string, ours: OurResolved, simulations: number, positions: readonly AzulJSON[]): number[] {
  const config = join(tmpdir(), `azul-grzhx-timing-${process.pid}-${simulations}.json`);
  writeFileSync(config, JSON.stringify(ourConfig(ours, { kind: 'sims', n: simulations })));
  return positions.map((p, i) => {
    const r = spawnSync(binary, ['play', ours.checkpointPath, '--config', config, '--search', 'play', '--split-ms'], { input: framedPosition(p) });
    if (r.status !== 0) throw new Error(`play at ${simulations} simulations, position ${i}: ${r.stderr.toString()}`);
    return readSplitAnswer(r.stdout).searchMs;
  });
}

/** Their move times: one fresh search of each imported position, through the host's `time`. */
export async function timeTheirs(host: Host, cell: number, positions: readonly AzulJSON[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < positions.length; i++) {
    const a = await host.ask<{ ms: number }>({ type: 'time', cell, index: i, imported: importArgs(positions[i]) }, 600_000, `timing position ${i}`);
    out.push(a.ms);
  }
  return out;
}

const fmt = (x: number): string => (x >= 100 ? x.toFixed(0) : x.toFixed(1));

/** [G13-48]: the README's table, from `timing.json` alone. */
export function renderTable(t: Timing): string {
  const lines = [
    '<!-- timing -->',
    '| side | simulations | median ms | p90 ms | mean ms |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...t.rows.map((r) => `| ${r.side} | ${r.simulations.toLocaleString('en-US')} | ${fmt(r.ms.median)} | ${fmt(r.ms.p90)} | ${fmt(r.ms.mean)} |`),
    '',
    `A player makes ${t.movesPerGame.mean.toFixed(1)} moves in a game on average, ${t.movesPerGame.max} at most (${t.movesPerGame.games} games).`,
    `Measured ${t.measured} on ${t.machine.cpu}, ${t.machine.logicalCores} logical cores, ${t.machine.os}: ${t.positions} positions of the latency corpus, one move at a time, each search fresh, single-threaded.`,
    'Ours is `' + t.ours.checkpoint + '`; theirs is generation 2300 at `' + t.theirs.commit.slice(0, 12) + '`.',
    '',
    'A cell takes about `games × moves per game × (our mean + their mean) ÷ workers`.',
    '<!-- /timing -->',
  ];
  return lines.join('\n');
}

/** The README with its timing table replaced by `t`'s. */
export function withTable(readme: string, t: Timing): string {
  const start = readme.indexOf('<!-- timing -->');
  const end = readme.indexOf('<!-- /timing -->');
  if (start < 0 || end < start) throw new Error('grzhx/README.md has no <!-- timing --> … <!-- /timing --> block');
  return readme.slice(0, start) + renderTable(t) + readme.slice(end + '<!-- /timing -->'.length);
}

/** The table between the README's markers, as committed. */
export function committedTable(readme: string): string {
  const start = readme.indexOf('<!-- timing -->');
  const end = readme.indexOf('<!-- /timing -->');
  return readme.slice(start, end + '<!-- /timing -->'.length);
}

export function writeTiming(t: Timing): void {
  writeJson(TIMING_PATH, t);
  writeFileSync(README_PATH, withTable(readFileSync(README_PATH, 'utf8'), t));
}
