/**
 * [C10-38]: a real mistake in a referee, caught every time the suite runs.
 *
 * Each mutation is applied to a *copy* of the TypeScript engine's sources,
 * made from the working tree into a scratch directory, never to the tree
 * itself; its anchor is asserted to have matched before the copy is written,
 * so a refactor that moves the code fails here loudly instead of leaving a
 * mutation that breaks nothing (`CLAUDE.md`, *Mutation testing*).
 *
 * [C10-39], recorded rather than run — it costs a build of the crate. On
 * 2026-09-26: `packages/engine-rs` was copied with `git archive HEAD` into a
 * scratch directory beside a copy of the checker; in the copy's
 * `src/apply.rs`, `AzulState::refill`, line 268, `self.lid[c] = 0;` inside the
 * lid-recycle loop was deleted, the anchor asserted to match exactly once
 * before the edit. The checker built there, run by `CROSSCHECK_CHECKER` over
 * the `mix` run of [C10-36] against the unmutated TypeScript engine,
 * disagreed in game 0 at record 60 on `lid[0]`..`lid[4]`, `census[0]`..
 * `census[4]` and the bag slots `encoded[0][168]`..`[172]` of both seats; the
 * unmutated checker agreed on all 40 games. Re-run it when `refill` moves.
 */

import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { replayReport, writeReport } from '../src/run.js';
import { CHECKER, EVERYDAY, runWith } from './support/harness.js';
import { MUTATIONS, cleanScratch, mutatedEngine, scratchDir } from './support/mutations.js';

afterAll(cleanScratch);

describe('the everyday run catches a broken referee [C10-38]', () => {
  for (const m of MUTATIONS) {
    it(m.name, async () => {
      const engine = await mutatedEngine(m);
      const { report } = await runWith(engine, EVERYDAY.mix);
      expect(report, 'the mutated engine went unnoticed').not.toBeNull();
      const paths = report!.fields.map((f) => f.path);
      expect(paths.some((p) => m.expect.test(p)), `fields: ${paths.join(', ')}`).toBe(true);
    });
  }
});

describe('a report reproduces [C10-41]', () => {
  it('replays from its game input to the same record and fields [C10-24]', async () => {
    const engine = await mutatedEngine(MUTATIONS[0]);
    const { report } = await runWith(engine, EVERYDAY.mix);
    expect(report).not.toBeNull();
    const dir = scratchDir('crosscheck-report-');
    const path = writeReport(dir, report!);
    const read = JSON.parse(readFileSync(path, 'utf8'));
    // From the file, not from the seed: the run block is provenance only.
    const again = await replayReport(engine, CHECKER, { ...read, run: { game: read.run.game } });
    expect(again).not.toBeNull();
    expect(again!.at).toBe(report!.at);
    expect(again!.fields).toEqual(report!.fields);
  });

  it('is the same game and the same disagreement when the run is repeated [C10-20]', async () => {
    const engine = await mutatedEngine(MUTATIONS[1]);
    const first = await runWith(engine, EVERYDAY.mix);
    const second = await runWith(engine, EVERYDAY.mix);
    expect(first.report).not.toBeNull();
    expect(second.report!.run.game).toBe(first.report!.run.game);
    expect(second.report!.at).toBe(first.report!.at);
    expect(second.report!.fields).toEqual(first.report!.fields);
  });
});
