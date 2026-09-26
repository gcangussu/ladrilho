/**
 * The command line and the report: exit codes [C10-21], no clock in a report
 * [C10-22], the report's shape [C10-23], and `replay` [C10-24].
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as engine from 'engine';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';
import { CHECKER, PACKAGE } from './support/harness.js';
import { MUTATIONS, cleanScratch, mutatedEngine, scratchDir } from './support/mutations.js';

afterAll(cleanScratch);

/** Runs a command, capturing what it prints. */
async function command(argv: string[], deps = { engine, checker: CHECKER }) {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
  const err = vi.spyOn(console, 'error').mockImplementation((...a) => void lines.push(a.join(' ')));
  try {
    const status = await main(argv, deps);
    return { status, out: lines.join('\n') };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe('exit codes [C10-21]', () => {
  it('exits 0 and says so when the engines agree', async () => {
    const { status, out } = await command(['check', '--games', '6', '--seed', '3']);
    expect(status).toBe(0);
    expect(out).toMatch(/^no disagreement in 6 games \(\d+ plies\)$/m);
  });

  it('exits 1 after writing a report when they disagree', async () => {
    const dir = scratchDir('crosscheck-cli-');
    const mutated = await mutatedEngine(MUTATIONS[1]);
    const { status, out } = await command(['check', '--games', '40', '--out', dir], { engine: mutated, checker: CHECKER });
    expect(status).toBe(1);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(out).toContain(join(dir, readdirSync(dir)[0]));
  });

  it('exits 2, and writes nothing, when the tool fails rather than an engine', async () => {
    const dir = scratchDir('crosscheck-cli-');
    const missing = await command(['check', '--games', '2', '--out', dir], { engine, checker: '/nonexistent/checker' });
    expect(missing.status).toBe(2);
    expect(readdirSync(dir)).toHaveLength(0);
    expect((await command(['check', '--steer', 'sideways'])).status).toBe(2);
    expect((await command(['check', '--start', 'short:81'])).status).toBe(2);
    expect((await command(['launch'])).status).toBe(2);
  });
});

describe('the report [C10-23]', () => {
  it('holds the game input cut at the disagreement, both engines’ records, and provenance', async () => {
    const dir = scratchDir('crosscheck-report-');
    const mutated = await mutatedEngine(MUTATIONS[2]);
    await command(['check', '--games', '40', '--seed', '9', '--out', dir], { engine: mutated, checker: CHECKER });
    const [name] = readdirSync(dir);
    const report = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    expect(name).toBe(`crosscheck-9-${report.run.game}.json`);
    expect(Object.keys(report)).toEqual([
      'schema', 'commit', 'run', 'start', 'shuffles', 'actions', 'probes', 'at', 'fields', 'said', 'before',
    ]);
    expect(report.schema).toBe(1);
    expect(report.commit).toMatch(/^([0-9a-f]{40}(-dirty)?|unknown)$/);
    expect(Object.keys(report.run)).toEqual(['seed', 'game', 'steer', 'start', 'cap']);
    expect(report.actions).toHaveLength(report.at);
    expect(report.probes).toHaveLength(report.at + 1);
    // No shuffle past what either engine had consumed at the disagreement.
    const used = Math.max(report.said.typescript.shufflesUsed, report.said.rust.shufflesUsed);
    expect(report.shuffles).toHaveLength(used);
    expect(report.fields.length).toBeGreaterThan(0);
    for (const f of report.fields) expect(Object.keys(f)).toEqual(['path', 'typescript', 'rust']);
    expect(report.before.status).toBe(0);
    // [C10-22] no clock reaches a report.
    expect(JSON.stringify(report)).not.toMatch(/perSecond|seconds|time/i);
  });
});

describe('replay [C10-24]', () => {
  it('reproduces a report, and exits 0 once the disagreement is gone', async () => {
    const dir = scratchDir('crosscheck-replay-');
    const mutated = await mutatedEngine(MUTATIONS[0]);
    await command(['check', '--games', '40', '--out', dir], { engine: mutated, checker: CHECKER });
    const path = join(dir, readdirSync(dir)[0]);
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const again = await command(['replay', path], { engine: mutated, checker: CHECKER });
    expect(again.status).toBe(1);
    expect(again.out).toContain(`disagreement at record ${report.at}`);
    // The engine fixed: the same report no longer reproduces.
    expect((await command(['replay', path])).status).toBe(0);
  });
});

describe('no clock but the throughput figure [C10-22]', () => {
  it('reads the clock in one place, for plies per second', () => {
    const dir = join(PACKAGE, 'src');
    const readers = readdirSync(dir).filter((f) =>
      /\b(performance\.now|Date\.now|new Date)\b/.test(readFileSync(join(dir, f), 'utf8')),
    );
    expect(readers).toEqual(['run.ts']);
    const run = readFileSync(join(dir, 'run.ts'), 'utf8');
    expect(run.match(/performance\.now\(\)/g)).toHaveLength(2);
  });
});
