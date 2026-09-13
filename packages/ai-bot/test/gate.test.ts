/**
 * The committed gate result [A8-30], [A8-31], [A8-32].
 *
 * The lane itself is on demand and takes an hour; what the fast suite can
 * check is that the file it wrote is internally consistent and says what it
 * claims — above all that `passed` follows from the numbers beside it, because
 * that field is what decides whether the interface offers `expert` at all
 * ([A8-33]).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WIDE_SEEDS } from 'bot/arena';
import { manifest } from './support/fixtures.js';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(PACKAGE, 'gate', 'baseline.json');

interface Baseline {
  winrate: number;
  lowerBound: number;
  bySeat: [number, number];
  nullWinrate: number;
  nullBySeat: [number, number];
  threshold: number;
  passed: boolean;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  seeds: number[];
  sharp: { tier: string; milliseconds: number };
  simulations: number;
  commit: string;
  checkpointSha256: string;
  upstreamCommit: string;
  machine: Record<string, unknown>;
  digest: string;
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;

describe('the gate result [A8-32]', () => {
  it('[A8-32] is committed, whether it passed or failed', () => {
    // Intent 0006 asks that a copy which does not clear the bar be written
    // down, so the file's presence is not conditional on the answer.
    expect(existsSync(BASELINE)).toBe(true);
    expect(baseline.commit).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
    expect(baseline.checkpointSha256).toBe(manifest().checkpoint.sha256);
    expect(baseline.upstreamCommit).toBe(manifest().upstream.commit);
    expect(baseline.machine['platform']).toBeTypeOf('string');
    expect(baseline.simulations).toBe(100);
  });

  it('[A8-32] records `passed` as exactly what the numbers beside it say', () => {
    expect(baseline.threshold).toBe(0.6);
    expect(baseline.passed).toBe(baseline.winrate >= 0.6 && baseline.nullWinrate < 0.6);
  });

  it('[A8-31] measured the wide list against sharp at its shipped budget', () => {
    expect(baseline.seeds).toEqual([...WIDE_SEEDS]);
    expect(baseline.games).toBe(baseline.seeds.length);
    expect(baseline.sharp.tier).toBe('sharp');
    // [0005 M5-8]: the fail-safe pushed out of reach, not relied upon.
    expect(baseline.sharp.milliseconds).toBeGreaterThan(60_000);
  });

  it('[A8-31] reports the Wilson bound, both seats, and the null beside them', () => {
    expect(baseline.wins + baseline.losses + baseline.draws).toBe(baseline.games);
    expect(baseline.winrate).toBeCloseTo((baseline.wins + baseline.draws / 2) / baseline.games, 12);
    // A one-sided lower bound is below the estimate it bounds, and both are
    // rates.
    expect(baseline.lowerBound).toBeLessThanOrEqual(baseline.winrate);
    for (const rate of [baseline.winrate, baseline.lowerBound, ...baseline.bySeat, baseline.nullWinrate]) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
    // The seats are measured separately, which is what makes an imbalance
    // visible rather than averaged away.
    expect(baseline.bySeat).toHaveLength(2);
    expect(baseline.nullBySeat).toHaveLength(2);
  });

  it('[A8-32] carries a digest of the numbers it was written from', () => {
    // Not a security measure: it is what makes a hand-edited winrate show up
    // as an inconsistency rather than as a result.
    const digest = createHash('sha256')
      .update(JSON.stringify([baseline.winrate, baseline.nullWinrate, baseline.seeds]))
      .digest('hex')
      .slice(0, 16);
    expect(baseline.digest).toBe(digest);
  });
});
