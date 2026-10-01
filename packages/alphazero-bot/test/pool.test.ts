/** The champions' pool ([Z11-73]) and a milestone against it ([Z11-74]). */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LogEntry, MilestoneEntry } from '../eval/decision.js';
import { fitPool, performance, settle, verdict } from '../eval/elo.js';
import { readLog } from '../eval/log.js';
import { PACKAGE, binary } from '../eval/paths.js';
import { POOL, currentPool, playPoolMilestone, readSeed, weakestOf, type Member, type PoolRecord, type PoolSeed } from '../eval/pool.js';

const FIXTURE = 'test/fixtures/checkpoint.bin';

function member(run: string, generation: number, rating: number): Member {
  return { run, generation, checkpoint: FIXTURE, rating, se: 10 };
}

function seed(members: Member[], gamesPerMember = 2): PoolSeed {
  return {
    simulations: 12,
    gamesPerMember,
    anchor: { run: members[0].run, generation: members[0].generation },
    members,
    date: 'd',
    pairings: [],
    seconds: 0,
  };
}

function poolEntry(run: string, generation: number, rating: number, replaced: PoolRecord['replaced']): LogEntry {
  return {
    kind: 'milestone',
    run,
    date: 'd',
    generation,
    results: {},
    ladderHash: 'h',
    progress: rating,
    previousProgress: null,
    freshStart: { fresh: true, why: 'first' },
    gate: { due: false, ran: false, outcome: null },
    decision: 'continue',
    reason: 'a pool milestone',
    pool: { rating, se: 12, replaced } as PoolRecord,
  } as MilestoneEntry;
}

describe('the pool as it stands [Z11-73]', () => {
  /** Mutation, seen red: a replacement applied without removing the member it replaced. */
  it('is the seed with every logged replacement applied in log order', () => {
    const s = seed([member('third', 90, 0), member('fourth', 50, 40), member('fourth', 70, 80)]);
    const log = [
      poolEntry('fifth', 10, 60, { run: 'third', generation: 90 }),
      poolEntry('fifth', 20, 55, null),
      poolEntry('fifth', 30, 95, { run: 'fourth', generation: 50 }),
    ];
    const now = currentPool(s, log);
    expect(now.map((m) => `${m.run}/${m.generation}`)).toEqual(['fourth/70', 'fifth/10', 'fifth/30']);
    expect(now.find((m) => m.run === 'fifth' && m.generation === 30)).toMatchObject({
      checkpoint: 'milestones/fifth/30/checkpoint.bin',
      rating: 95,
    });
    expect(weakestOf(now)).toMatchObject({ run: 'fifth', generation: 10 });
    expect(() => currentPool(s, [poolEntry('fifth', 10, 60, { run: 'nobody', generation: 1 })])).toThrow(/not in the pool/);
  });
});

function config(): string {
  const dir = mkdtempSync(join(tmpdir(), 'az-pool-'));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      width: 16, blocks: 1, seed: 1, playSimulations: 32, milestoneSimulations: 12, selfPlaySimulations: 8,
      cpuct: 1.25, fpu: 0.25, alpha: 0.3, epsilon: 0.25, tempPlies: 10, tau: 1, threads: 1,
      gamesPerGeneration: 10, maxGenerationMinutes: 30,
    }),
  );
  return path;
}

describe('a pool milestone [Z11-74]', () => {
  const side = { binary: binary('debug'), config: config() };
  const challenger = join(PACKAGE, FIXTURE);

  function consistent(r: PoolRecord, results: Record<string, { games: number; winrate: number }>, members: Member[]): void {
    const played = members.map((m) => {
      const s = results[`${m.run}/${m.generation}`];
      return { opponent: m.rating, games: s.games, score: s.winrate * s.games };
    });
    expect(r.rating).toBeCloseTo(performance(played).rating, 9);
    for (const m of members) expect(results[`${m.run}/${m.generation}`].games).toBe(r.gamesPerMember + r.extraPerMember);
    expect(r.weakest).toMatchObject({ run: weakestOf(members).run, generation: weakestOf(members).generation });
  }

  /**
   * Mutations, seen red: no extra games when within two standard errors; the
   * settling rating taken from the first games alone.
   */
  it('plays a third more games against every champion when within two standard errors, then the higher rating decides', async () => {
    // Every side the same network: the challenger lands within its own wide error of 0.
    const members = [member('a', 1, 0), member('b', 1, 0)];
    const m = await playPoolMilestone(side, challenger, seed(members, 3), members, 1);
    expect(m.record.verdict).toBe('more');
    expect(m.record.extraPerMember).toBe(1);
    consistent(m.record, m.results, members);
    expect(m.record.settled).toBe(settle({ rating: m.record.rating, se: m.record.se }, 0));
    expect(m.record.replaced === null).toBe(m.record.settled === 'keep');
    expect(Object.keys(m.simulations)).toEqual(['12']);
  });

  /** Mutation, seen red: the place taken from the strongest champion instead of the weakest. */
  it('takes the weakest champion’s place outright beyond two standard errors', async () => {
    const members = [member('a', 1, 0), member('b', 1, -3000), member('c', 1, 10)];
    const m = await playPoolMilestone(side, challenger, seed(members, 2), members, 1);
    expect(m.record.verdict).toBe(verdict({ rating: m.record.rating, se: m.record.se }, -3000));
    expect(m.record.verdict).toBe('replace');
    expect(m.record.extraPerMember).toBe(0);
    expect(m.record.replaced).toEqual({ run: 'b', generation: 1 });
    consistent(m.record, m.results, members);
  });
});

describe('the committed pool [Z11-73]', () => {
  it('anchors its first member at 0, refits from its own pairings, and applies the log cleanly', () => {
    if (!existsSync(POOL)) return;
    const s = readSeed();
    expect(s.members[0]).toMatchObject({ ...s.anchor, rating: 0 });
    for (const m of s.members) {
      expect(existsSync(join(PACKAGE, m.checkpoint)), m.checkpoint).toBe(true);
      expect(existsSync(join(PACKAGE, m.checkpoint.replace(/\.bin$/, '.parity'))), m.checkpoint).toBe(true);
    }
    const index = new Map(s.members.map((m, i) => [`${m.run}/${m.generation}`, i]));
    const refit = fitPool(
      s.members.length,
      s.pairings.map((p) => ({ a: index.get(p.a) ?? -1, b: index.get(p.b) ?? -1, games: p.games, score: p.score })),
      0,
    );
    refit.forEach((r, i) => expect(r.rating).toBeCloseTo(s.members[i].rating, 6));
    expect(currentPool(s, readLog()).length).toBe(s.members.length);
  });
});
