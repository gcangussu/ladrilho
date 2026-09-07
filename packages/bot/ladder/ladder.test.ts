/**
 * The gating lane [M5-12], [M5-13], [M5-17] and the blunder audit [M5-19].
 *
 * Run by `pnpm -F bot ladder`, not by `pnpm test`. Strength measurement is slow
 * by nature: [B4-60] budgets the fast suite at 30 seconds and [M5-20] budgets
 * this at five minutes, and running them together would make one of those
 * numbers a lie.
 *
 * **This lane measures the ordering, not the shipped opponent.** The tiers run
 * at reduced node budgets [M5-17], because `sharp` at its shipped 400 000 is
 * about 1.2 seconds a move and forty seventy-ply games of that is an hour. What
 * a reduced lane still catches is the thing most worth catching — a change that
 * inverts the ladder or breaks a tier outright. The shipped numbers are
 * [M5-16]'s wide lane, run on demand.
 *
 * Nothing here is flaky. [0004 B4-30] makes the bot deterministic and [M5-4]
 * fixes the seeds, so a threshold either holds or does not, identically on every
 * machine.
 *
 * Each threshold is set against its **null** — the same player against itself
 * over the same seeds — and `run` asserts the result beats it. A threshold
 * below its null gates nothing, which is not hypothetical: `steady vs easy` at
 * ≥ 60% was cleared by substituting `easy` for `steady`, because two identical
 * players split 62.5% on seat advantage alone.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apply, newGame, toJSON } from 'engine';
import {
  GATING_SEEDS,
  RANDOM_CHOOSER_SEED,
  greedy,
  match,
  summarise,
  tier,
  uniformRandom,
  audit,
  type Chooser,
  type AuditCorpus,
} from '../arena/index.js';

/**
 * The lane's budget [M5-17]. `steady` and `sharp` get the *same* number — which
 * is also `steady`'s shipped budget — so the difference between them is the
 * horizon alone: [0004 B4-32]'s central claim, measured rather than asserted.
 *
 * Raised from 6000 after measuring. At 6000 `sharp` beat `steady` 62.5% against
 * a 60% threshold: one game of margin on forty, and the two tiers picked the
 * same move 77% of the time. At 20 000 it is 66.3% against a 40.0% self-play
 * null, which is a gap worth gating on.
 */
const LANE_NODES = 20_000;

/**
 * The wall-clock fail-safe is pushed out of reach for every chooser in this
 * lane [0004 B4-28].
 *
 * Not a convenience. [M5-8] fails a match containing a curtailed search, and
 * rightly — a curtailed search is the one case [0004 B4-30] does not cover, so
 * a match holding one is not reproducible. But that makes the *default*
 * fail-safe a load sensor: run this lane beside anything else and `sharp`
 * exceeds four seconds on a starved core, the match throws, and the gate fails
 * for a reason that has nothing to do with the bot. Measured — three of these
 * seven failed exactly that way when the lane shared a machine with the fast
 * suite.
 *
 * The node budget is the bound that means something here, and it is the one
 * [M5-13]'s numbers were measured against.
 */
const NO_CLOCK = 3_600_000;

const easy = (): Chooser => tier({ tier: 'easy', milliseconds: NO_CLOCK });
const steady = (): Chooser =>
  tier({ tier: 'steady', nodes: LANE_NODES, milliseconds: NO_CLOCK });
const sharp = (): Chooser => tier({ tier: 'sharp', nodes: LANE_NODES, milliseconds: NO_CLOCK });

/**
 * Play a match and print it beside its **null**: the same player against itself
 * over the same seeds.
 *
 * The null is the number that says whether a threshold discriminates. Without
 * it `steady vs easy ≥ 60%` looked like a gate and was not — `easy vs easy` is
 * 62.5% over these seeds, so substituting `easy` for `steady` passed it. That
 * 62.5% is not noise either: two identical deterministic players split only by
 * seat, and seat 0 wins about 70% of the time, so a self-play match measures
 * Azul's first-player advantage and nothing else.
 */
function run(label: string, a: Chooser, b: Chooser, nullPlayer?: () => Chooser): number {
  const result = match({ a, b, seeds: GATING_SEEDS });
  // A number nobody can drill into is a number nobody can act on [M5-6].
  process.stderr.write(`${summarise(label, result)}\n`);
  if (nullPlayer !== undefined) {
    const baseline = match({ a: nullPlayer(), b: nullPlayer(), seeds: GATING_SEEDS });
    process.stderr.write(
      `  null (self-play): ${(100 * baseline.winrate).toFixed(1)}% — ` +
        `the number this gate has to beat to mean anything\n`,
    );
    // Asserted, not merely printed. A printed number nobody checks drifts
    // unnoticed, which is exactly how `steady vs easy ≥ 60%` got past review:
    // the threshold held while the null sat above it. If a future change makes
    // one tier play like the one below it, this fails even where the threshold
    // happens to survive.
    expect(
      result.winrate,
      `${label}: ${(100 * result.winrate).toFixed(1)}% does not beat its own null of ` +
        `${(100 * baseline.winrate).toFixed(1)}% — this gate is measuring the seat, not the player`,
    ).toBeGreaterThan(baseline.winrate);
  }
  if (result.lostSeeds.length > 0) {
    process.stderr.write(`  lost: ${result.lostSeeds.join(', ')}\n`);
  }
  return result.winrate;
}

describe('the ladder [M5-12], [M5-13]', () => {
  it('[M5-13] easy beats uniform random at least 95% of the time', () => {
    expect(run('easy vs random', easy(), uniformRandom(RANDOM_CHOOSER_SEED))).toBeGreaterThanOrEqual(
      0.95,
    );
  });

  it('[M5-13] steady beats easy at least 70% of the time', () => {
    // 70, not 60: `easy vs easy` over these seeds is 62.5%, so a 60% bar is
    // cleared by substituting `easy` for `steady` and gates nothing. Measured
    // 88.8% at this lane's budget.
    expect(run('steady vs easy', steady(), easy(), easy)).toBeGreaterThanOrEqual(0.7);
  });

  it('[M5-13] [M5-17] sharp beats steady at least 55% of the time, at the same budget', () => {
    // Same node budget on both sides, so the whole difference is the horizon.
    // The threshold sits between the measured null (40.0%) and the measured
    // value (66.3%) rather than just above the null.
    expect(run('sharp vs steady', sharp(), steady(), steady)).toBeGreaterThanOrEqual(0.55);
  });

  it('[M5-13] sharp beats easy at least 80% of the time', () => {
    // 92.5% measured against the same 62.5% null, so 80% discriminates.
    expect(run('sharp vs easy', sharp(), easy(), easy)).toBeGreaterThanOrEqual(0.8);
  });

  it('[M5-12] every tier beats the floor', () => {
    for (const [label, chooser] of [
      ['steady vs random', steady()],
      ['sharp vs random', sharp()],
    ] as const) {
      expect(run(label, chooser, uniformRandom(RANDOM_CHOOSER_SEED))).toBeGreaterThanOrEqual(0.95);
    }
  });

  /**
   * Compared on **moves**, not on a winrate.
   *
   * A match between two identical deterministic players measures nothing about
   * either of them: every game is decided by the deal and by which seat the
   * first chooser drew. Run as a match it comes out at 62.5% — which is not a
   * defect in `greedy`, it is Azul's first-player advantage, visible in the
   * per-seat split this lane prints (seat 0 takes about 70% of self-play games,
   * seat 1 about 55%). An earlier version asserted 0.5 and failed for exactly
   * that reason.
   *
   * The claim [M5-10] actually makes is that the reference and `easy` are
   * interchangeable *today*, so move-for-move agreement is the thing to assert.
   * If it ever fails, `easy` has been redefined and [M5-10] requires the
   * reference to stay put — the ladder above would then be measuring a moved
   * goalpost, and [M5-15]'s baseline needs regenerating with it.
   */
  it('[M5-10] greedy and easy choose the same move, game after game', () => {
    const reference = greedy();
    const tierEasy = easy();
    let compared = 0;
    for (const seed of GATING_SEEDS.slice(0, 12)) {
      const s = newGame(seed);
      while (!s.isTerminal) {
        const position = toJSON(s);
        expect(reference(position).action, `seed ${seed}`).toBe(tierEasy(position).action);
        compared++;
        apply(s, position.legalActions[0]);
      }
    }
    expect(compared, 'no positions were compared').toBeGreaterThan(400);
  });
});

/**
 * The blunder audit's gate [M5-19].
 *
 * Separate from the ladder because it asks a different question: a winrate
 * cannot see a blunder, and a player can win a match while still throwing a
 * round away. Regret is measured against the committed reference values
 * [M5-31], never recomputed — a reference regenerated alongside the bot
 * measures the bot against itself.
 */
describe('the blunder audit [M5-19]', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const corpus = JSON.parse(
    readFileSync(join(HERE, '..', 'arena', 'audit-corpus.json'), 'utf8'),
  ) as AuditCorpus;

  /**
   * Run at the **shipped** budget, unlike the ladder matches above.
   *
   * The corpus is 34 positions, so a full-budget pass is about 14 million nodes
   * — seconds, not the hour forty full-budget games would cost. [M5-19] is a
   * claim about the opponent that ships, and there is no reason to make it
   * about a reduced one when the honest measurement is affordable.
   */
  it('[M5-19] sharp gives up no won game, and bleeds few points', () => {
    const report = audit(corpus, tier({ tier: 'sharp', milliseconds: NO_CLOCK }));
    process.stderr.write(
      `audit: mean ${report.meanRegret.toFixed(3)}, p95 ${report.p95Regret.toFixed(2)}, ` +
        `max ${report.maxRegret.toFixed(2)} over ${report.scored} scored positions ` +
        `(${report.decisiveBlunders.length} decisive, ${report.condemned.length} condemned, ` +
        `${report.heldOn} held on, ${report.hopeless} hopeless, ${report.positions} total)\n`,
    );
    for (const entry of report.decisiveBlunders) {
      process.stderr.write(`  gave up a won game: seed ${entry.seed} ply ${entry.ply}\n`);
    }
    for (const entry of report.condemned) {
      // A lead, not a verdict: the reference condemned this move and did not
      // finish searching the alternatives [M5-31].
      process.stderr.write(
        `  condemned (alternatives unfinished): seed ${entry.seed} ply ${entry.ply}\n`,
      );
    }
    for (const entry of report.worst.slice(0, 3)) {
      process.stderr.write(
        `  seed ${entry.seed} ply ${entry.ply}: gave up ${entry.regret.toFixed(2)}\n`,
      );
    }
    expect(report.decisiveBlunders).toHaveLength(0);
    // 1.5, not 2: `easy` measures 1.728 over this corpus, so a 2-point bar is
    // cleared by a one-ply player and gates nothing.
    expect(report.meanRegret).toBeLessThanOrEqual(1.5);
    // No maximum clause. Uniform random measures 17.33, so any bar loose enough
    // to admit the shipped opponent's 13.66 is one a random player also clears
    // — it would be a decoration, not a gate. The maximum is printed above and
    // the open question in 0005 is where it is pursued.
    expect(report.scored).toBeGreaterThan(10);
  });
});
