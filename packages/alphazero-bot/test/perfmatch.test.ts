/**
 * The performance match ([Z11-101]): its summary on games made by hand, and
 * a lane of two identical builds, on the debug binary and the fixture
 * checkpoint.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { playPerfMatch, summarise, type PerfGame, type PerfPly } from '../eval/perfmatch.js';
import { PACKAGE, binary } from '../eval/paths.js';

/** One game of `moves`, the new build in `newSeat`, seat 0 moving first and the seats alternating. */
function game(seed: number, newSeat: number, moves: [number, number][], scores = [40, 30]): PerfGame {
  const plies: PerfPly[] = moves.map(([newMs, oldMs], i) => {
    const mover = i % 2 === newSeat ? 'new' : 'old';
    return { mover, action: 10 + i, simulations: 100, value: 1000 + i, ms: mover === 'new' ? newMs : oldMs };
  });
  return { seed, newSeat, plies, scores };
}

describe('the performance match [Z11-101]', () => {
  // Mutation, seen red ([Z11-48]), in a copy with its anchor confirmed: in
  // `eval/perfmatch.ts`, the value left out of the comparison of two games
  // (`&& p.value === b.plies[i].value` removed), which lets a pair whose
  // values differ in one bit pass as one game.
  it('names a pair whose games differ in one value bit, and times the rest in pairs', () => {
    // Each position's time, [new, old]: the new build at half the old one's time.
    const moves: [number, number][] = [
      [50, 100],
      [100, 200],
      [25, 50],
    ];
    const games = [game(1, 0, moves), game(1, 1, moves), game(2, 0, moves), game(2, 1, moves)];
    const odd = structuredClone(game(3, 1, moves));
    odd.plies[1].value ^= 1;
    games.push(game(3, 0, moves), odd);
    const s = summarise(games);
    expect(s.differing).toEqual([3]);
    // Two clean pairs, three positions each, every one searched by both.
    expect(s.positions).toBe(6);
    expect(s.ratio).toBeCloseTo(0.5, 12);
    expect(s.interval).toEqual([s.ratio, s.ratio]);
    expect(s.medianRatio).toBeCloseTo(0.5, 12);
    expect(s.measured).toBe(6);
    expect(s.newFaster).toBe(6);
    expect(s.old).toMatchObject({ p50: 100, max: 200 });
    expect(s.new).toMatchObject({ p50: 50, max: 100 });
    // Seat 0 scored 40 to 30 in all six: the new build won the three it sat there.
    expect(s.newPoints).toBe(3);
    expect(s.firstSeatWins).toBe(6);
  });

  it('plays two identical builds to one game per seed, every position timed by both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'az-perf-'));
    const config = join(dir, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        width: 16, blocks: 1, seed: 1, playSimulations: 32, milestoneSimulations: 12, selfPlaySimulations: 8,
        cpuct: 1.25, fpu: 0.25, alpha: 0.3, epsilon: 0.25, tempPlies: 10, tau: 1, threads: 1,
        gamesPerGeneration: 10, maxGenerationMinutes: 30,
      }),
    );
    const player = { binary: binary('debug'), checkpoint: join(PACKAGE, 'test/fixtures/checkpoint.bin'), config, search: 'play' as const };
    const games = await playPerfMatch({ old: player, new: player }, [7, 8], 1);
    expect(games).toHaveLength(4);
    const s = summarise(games);
    expect(s.differing).toEqual([]);
    expect(s.positions).toBe(games.filter((g) => g.newSeat === 0).reduce((n, g) => n + g.plies.length, 0));
    for (const g of games) {
      expect(g.plies.every((p) => p.simulations === 32)).toBe(true);
      // The movers alternate with the seats, so each build moved in both games.
      expect(new Set(g.plies.map((p) => p.mover))).toEqual(new Set(['old', 'new']));
    }
    // One game from both seats: whatever it scored, the new build took one point a seed.
    expect(s.newPoints).toBe(2);
  });
});
