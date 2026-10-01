/**
 * The chooser adapter ([Z11-31]) through the arena's `match`, on the debug
 * binary `cargo test` leaves behind and the fixture checkpoint.
 *
 * The adapter is a new caller of `match` and of `play`: CLAUDE.md's rule is
 * that each seam's own tests get a case in the new configuration, so a whole
 * game is played through it here, not only a move.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, clone, fromJSON, newGame, toCanonical, toJSON } from 'engine';
import { WIDE_SEEDS } from 'bot/arena';
import { describe, expect, it } from 'vitest';
import { alphazeroChooser, canonicalWords, frame, readAnswer } from '../eval/chooser.js';
import { alphazero } from '../eval/crate.js';
import { LADDER } from '../eval/decision.js';
import { checkCounts, runMilestone } from '../eval/milestone.js';
import { PACKAGE, binary, parseMilestonePath } from '../eval/paths.js';
import { playOne, type Entrant } from '../eval/series.js';

const checkpoint = join(PACKAGE, 'test/fixtures/checkpoint.bin');

function config(): string {
  const dir = mkdtempSync(join(tmpdir(), 'az-config-'));
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

const player = { binary: binary('debug'), checkpoint, config: config() };

describe('the adapter [Z11-31]', () => {
  it('plays a legal move from the view alone, reporting its simulations as nodes', () => {
    const s = newGame(7);
    const seen: number[] = [];
    const play = alphazeroChooser({ ...player, search: 'milestone' }, (a) => seen.push(a.simulations))(toJSON(s));
    expect(play).toMatchObject({ nodes: 12, depth: 0, complete: false, curtailed: false });
    expect(seen).toEqual([12]);
  });

  it('plays whole games through match, each seat, every move at the configured count', () => {
    const subject: Entrant = { kind: 'alphazero', player: { ...player, search: 'play' } };
    for (const index of [0, 1]) {
      const g = playOne({ subject, opponent: { kind: 'uniformRandom' }, seeds: WIDE_SEEDS.slice(0, 2) }, index);
      expect(g.plies).toBeGreaterThan(20);
      expect(Object.keys(g.simulations)).toEqual(['32']);
      expect(g.work[0].nodes).toBe(32 * g.simulations['32']);
      expect([0, 0.5, 1]).toContain(g.points);
    }
  });

  it('answers every move of a game as a one-shot play does [Z11-72]', () => {
    let s = newGame(11);
    const chooser = alphazeroChooser({ ...player, search: 'milestone' });
    try {
      for (let ply = 0; ply < 30; ply++) {
        const position = toJSON(s);
        const words = frame(canonicalWords(toCanonical(fromJSON(position, 0))));
        const alone = readAnswer(alphazero(player.binary, ['play', checkpoint, '--config', player.config, '--search', 'milestone'], words));
        const play = chooser(position);
        expect(play.action, `ply ${ply}`).toBe(alone.action);
        expect(play.nodes).toBe(alone.simulations);
        s = clone(s);
        apply(s, play.action);
      }
    } finally {
      chooser.close();
    }
  });

  it('plays a game with a trained player in each seat, a process each [Z11-72]', () => {
    const az: Entrant = { kind: 'alphazero', player: { ...player, search: 'milestone' } };
    const g = playOne({ subject: az, opponent: az, seeds: WIDE_SEEDS.slice(0, 1) }, 0);
    expect(g.plies).toBeGreaterThan(20);
    expect(Object.keys(g.simulations)).toEqual(['12']);
    expect(g.work[1].nodes).toBeGreaterThan(0);
  });

  // Mutations, seen red ([Z11-48]), each in a copy with its anchor confirmed:
  // in the worker of `eval/chooser.ts`, a process's exit not reported
  // (`fail(...)` in its 'close' handler removed), which leaves the move
  // waiting until its deadline; and a process that cannot start not reported
  // (its 'error' handler emptied).
  it('throws, and does not wait, when its process cannot answer [Z11-72]', () => {
    const position = toJSON(newGame(5));
    const missing = alphazeroChooser({
      ...player,
      checkpoint: join(tmpdir(), 'no-such-checkpoint.bin'),
      search: 'play',
      answerMilliseconds: 5000,
    });
    expect(() => missing(position)).toThrow(/alphazero serve exited 2: .*no-such-checkpoint/);
    expect(() => missing(position)).toThrow(/exited 2/);
    missing.close();
    const absent = alphazeroChooser({ ...player, binary: join(tmpdir(), 'no-such-alphazero'), search: 'play', answerMilliseconds: 5000 });
    expect(() => absent(position)).toThrow(/could not start/);
    absent.close();
  });

  it('frames the canonical block the crate reads [Z11-23]', () => {
    const bytes = frame(canonicalWords(toCanonical(newGame(3))));
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe((bytes.length - 4) / 4);
    expect(() => readAnswer(new Uint8Array(12))).toThrow(/four words/);
  });
});

describe('a milestone [Z11-32]', () => {
  it('plays every rung, and refuses a count that is not the configured one [Z11-34]', async () => {
    const cheap: Entrant = { kind: 'uniformRandom' };
    const m = await runMilestone(player, 12, 1, WIDE_SEEDS.slice(0, 1), {
      uniformRandom: cheap, greedy: cheap, steady: cheap, sharp: cheap,
    });
    expect(Object.keys(m.rungs)).toEqual([...LADDER]);
    for (const r of LADDER) expect(m.rungs[r].games).toBe(1);
    expect(Object.keys(m.simulations)).toEqual(['12']);
    expect(() => checkCounts({ '12': 30, '11': 1 }, 12, 'milestone')).toThrow(/11/);
    await expect(
      runMilestone(player, 800, 1, WIDE_SEEDS.slice(0, 1), { uniformRandom: cheap, greedy: cheap, steady: cheap, sharp: cheap }),
    ).rejects.toThrow(/not 800/);
  });

  it('reads its run and generation from the checkpoint path [Z11-4]', () => {
    expect(parseMilestonePath('/x/packages/alphazero-bot/milestones/first/30/checkpoint.bin')).toEqual({ run: 'first', generation: 30 });
    expect(() => parseMilestonePath('/x/runs/first/checkpoints/30.bin')).toThrow();
  });
});
