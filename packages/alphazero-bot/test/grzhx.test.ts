/**
 * The grzhx harness without their files ([G13-50]): settings, the
 * translation held to its fixture, the deal's order, what `serve` is handed,
 * the grid and its seeds, and whole matches played against a fake host and a
 * fake `serve`, which mirror the game on our own engine. What needs their
 * cache, environment and build is `test:grzhx` ([G13-51]).
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apply, clone, fromJSON, newGame, outcome, Rng, toCanonical, toJSON, type AzulState } from 'engine';
import { canonicalWords as chooserWords, frame as chooserFrame } from '../eval/chooser.js';
import { dealTiles, FLOOR_PLACES, importArgs, NO_TILE } from '../grzhx/convert.js';
import { cellsFor, jobsFor, moveTimeout, runMatch, type Cell } from '../grzhx/match.js';
import { framedPosition, Serve, type HostLike, type OurAnswer, type ServeLike } from '../grzhx/processes.js';
import { readPin, HERE } from '../grzhx/release.js';
import type { ConvertFixture } from '../grzhx/replay.js';
import {
  checkParity, checkTheirBudgets, defaultWorkers, ourConfig, parseBudgets, parseSets, parseTheirs, resolveOurs, SettingError,
} from '../grzhx/settings.js';
import { table, type Summary } from '../grzhx/summary.js';
import { committedTable, renderTable, TIMING_PATH, README_PATH, type Timing } from '../grzhx/timing.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'azul-grzhx-test-'));

describe('settings [G13-21] [G13-22] [G13-25] [G13-34] [G13-35]', () => {
  it('reads budgets, and refuses what is not one', () => {
    expect(parseBudgets(undefined, 'us')).toEqual([null]);
    expect(parseBudgets('500, sims:1000,ms:250', 'us')).toEqual([{ kind: 'sims', n: 500 }, { kind: 'sims', n: 1000 }, { kind: 'ms', n: 250 }]);
    expect(() => parseBudgets('x', 'us')).toThrow(SettingError);
    expect(() => parseBudgets('1.5', 'them')).toThrow(SettingError);
    expect(() => parseBudgets('65536', 'us')).toThrow(/65535/);
    expect(parseBudgets('65536', 'them')).toEqual([{ kind: 'sims', n: 65536 }]);
    expect(() => parseBudgets('65537', 'them')).toThrow(/65536/);
    expect(() => parseBudgets('1', 'them')).toThrow(SettingError);
  });

  it('refuses an unknown key or a value of the wrong type, naming the key', () => {
    expect(() => resolveOurs(parseSets(['simulations=5'], 'us'))).toThrow(/simulations/);
    expect(() => resolveOurs(parseSets(['cpuct=fast'], 'us'))).toThrow(/cpuct/);
    expect(() => resolveOurs(parseSets(['checkpoint=nowhere'], 'us'))).toThrow(/run\/generation/);
    expect(() => parseTheirs(parseSets(['temperature=1'], 'them'))).toThrow(/temperature/);
    expect(() => parseTheirs(parseSets(['trees=0'], 'them'))).toThrow(/trees/);
    expect(() => parseTheirs(parseSets(['candidates=1.5'], 'them'))).toThrow(/candidates/);
    expect(() => parseTheirs(parseSets(['qFloor=low'], 'them'))).toThrow(/qFloor/);
    expect(() => parseTheirs(parseSets(['build=fast'], 'them'))).toThrow(/build/);
    expect(() => parseSets(['novalue'], 'them')).toThrow(/key=value/);
    expect(parseTheirs(parseSets(['candidates=8', 'qFloor=0.5', 'build=anytime+native'], 'them'))).toEqual({
      settings: { candidates: 8, qFloor: 0.5 },
      build: ['anytime', 'native'],
    });
  });

  it('refuses a clock of theirs with more than one tree before the host is asked', () => {
    const trees = parseTheirs(parseSets(['trees=2'], 'them'));
    expect(() => checkTheirBudgets([{ kind: 'ms', n: 100 }], trees)).toThrow(/trees 1/);
    expect(() => checkTheirBudgets([{ kind: 'sims', n: 100 }], trees)).not.toThrow();
  });

  it("defaults to the shipped milestone and hands serve its config with only our settings replaced", () => {
    const ours = resolveOurs(parseSets(['fpu=0.5', 'endgame=0', 'ceiling=900'], 'us'));
    const shipped = JSON.parse(readFileSync(join(HERE, '..', 'web', 'shipped.json'), 'utf8')) as { run: string; generation: number };
    expect(ours.settings.checkpoint).toBe(`${shipped.run}/${shipped.generation}`);
    expect(ours.source.fpu).toBe('given');
    expect(ours.source.cpuct).toBe("the milestone's logged config");
    const counted = ourConfig(ours, { kind: 'sims', n: 777 });
    expect(counted).toEqual({ ...ours.config, cpuct: ours.config.cpuct, fpu: 0.5, playEndgameNodes: 0, playSimulations: 777 });
    expect(ourConfig(ours, { kind: 'ms', n: 50 }).playSimulations).toBe(900);
    expect(ourConfig(ours, null).playSimulations).toBe(ours.config.playSimulations);
  });

  it('refuses a checkpoint without its parity file [G13-34]', () => {
    const dir = scratch();
    const ckpt = join(dir, 'checkpoint.bin');
    writeFileSync(ckpt, 'x');
    expect(() => checkParity(ckpt)).toThrow(/parity/);
    writeFileSync(join(dir, 'checkpoint.parity'), 'y');
    expect(() => checkParity(ckpt)).not.toThrow();
  });

  it('runs logical cores less one games at once, or cores over their threads [G13-35]', () => {
    expect(defaultWorkers(8, 1, 1)).toBe(7);
    expect(defaultWorkers(8, 4, 1)).toBe(2);
    expect(defaultWorkers(8, 1, 3)).toBe(2);
    expect(defaultWorkers(1, 1, 1)).toBe(1);
    expect(defaultWorkers(2, 8, 1)).toBe(1);
  });
});

describe('the translation [G13-14] [G13-15] [G13-46]', () => {
  // [G13-46]. Mutations, seen red (CLAUDE.md), each in a copy with its anchor
  // confirmed: in `convert.ts`, the floor count without the marker, the lid
  // left out of the discard counts, and the round sent 0-based. Each was also
  // seen to fail `verify`, the translation's real check: this fixture only
  // holds it to what it was.
  it('makes of every recorded position what their engine accepted and matched', () => {
    const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'convert.json'), 'utf8')) as ConvertFixture;
    expect(fixture.pin).toBe(readPin().commit);
    expect(fixture.plies.length).toBeGreaterThan(100);
    for (const [i, p] of fixture.plies.entries()) {
      expect(importArgs(p.position as unknown as ReturnType<typeof toJSON>), `ply ${i}`).toEqual(p.imported);
    }
    let refilling = 0;
    for (const [i, d] of fixture.deals.entries()) {
      expect(dealTiles(d.bagBefore, d.factories), `deal ${i}`).toEqual(d.tiles);
      const n = d.bagBefore.reduce((a, b) => a + b, 0);
      if (n > 0 && n < 20 && n % 4 !== 0) refilling++;
    }
    expect(refilling).toBeGreaterThan(0);
  });

  it('counts the marker on a full floor as their seven places allow', () => {
    const s = newGame(3);
    const j = toJSON(s);
    j.players[0].floor = [3, 2, 2, 0, 0];
    j.players[0].floorMarker = true;
    j.markerInCenter = false;
    expect(importArgs(j).floor_counts[0]).toBe(FLOOR_PLACES);
    j.players[0].floor = [3, 2, 1, 0, 0];
    expect(importArgs(j).floor_counts[0]).toBe(7);
    j.players[0].floor = [3, 2, 0, 0, 0];
    expect(importArgs(j).floor_counts[0]).toBe(6);
    expect(importArgs(j).next_start).toBe(0);
  });

  // Mutation, seen red: in `dealTiles`, the refilling factory's own tiles
  // listed before the old bag's (its two loops swapped).
  it("lists the old bag's last tiles first in the factory being filled when it ran out", () => {
    // Two tiles left in the bag, a blue and a yellow: the first factory takes them, then refills.
    const factories = [[1, 1, 1, 1, 0], [0, 2, 0, 0, 2], [4, 0, 0, 0, 0], [0, 0, 0, 4, 0], [1, 1, 1, 1, 0]];
    const tiles = dealTiles([1, 1, 0, 0, 0], factories);
    expect(tiles.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(tiles).toHaveLength(20);
    // No refill: each factory's tiles in colour order.
    expect(dealTiles([4, 4, 4, 4, 4], [[2, 2, 0, 0, 0], [0, 0, 4, 0, 0], [0, 0, 0, 4, 0], [0, 0, 0, 0, 4], [2, 2, 0, 0, 0]]).slice(0, 8)).toEqual([0, 0, 1, 1, 2, 2, 2, 2]);
    // A short deal leaves its empty places for last.
    expect(dealTiles([0, 0, 0, 0, 0], [[1, 1, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]).slice(0, 5)).toEqual([0, 1, NO_TILE, NO_TILE, NO_TILE]);
    expect(() => dealTiles([0, 0, 0, 0, 1], [[1, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]])).toThrow(/does not follow/);
  });
});

describe('what serve is handed [G13-16]', () => {
  // Mutation, seen red: in `framedPosition`, the block of a state whose bag
  // is the rebuilt one reversed, which is not what `fromJSON(position, 0)` makes.
  it('frames two states that differ only in the bag\'s order and the seed to the same bytes, from counts', () => {
    const a = newGame(5);
    const b = clone(a);
    b.bag.reverse();
    b.rng = new Rng(99);
    expect(b.bag).not.toEqual(a.bag);
    expect(toJSON(b)).toEqual(toJSON(a));
    const bytes = framedPosition(toJSON(a));
    expect(framedPosition(toJSON(b))).toEqual(bytes);
    // The bytes are chooser.ts's block of the state rebuilt from counts on seed 0 ...
    expect(bytes).toEqual(chooserFrame(chooserWords(toCanonical(fromJSON(toJSON(a), 0)))));
    // ... and not the live state's, whose bag is in its shuffled order.
    expect(bytes).not.toEqual(chooserFrame(chooserWords(toCanonical(a))));
  });
});

describe('the grid and its seeds [G13-31] [G13-32] [G13-38]', () => {
  it('plays every deal from both seats, and the same deals in every cell', () => {
    const jobs = jobsFor(3, 5, 40);
    expect(jobs).toHaveLength(3 * 6);
    for (let cell = 0; cell < 3; cell++) {
      expect(jobs.filter((j) => j.cell === cell).map((j) => [j.seed, j.ourSeat])).toEqual([
        [40, 0], [40, 1], [41, 0], [41, 1], [42, 0], [42, 1],
      ]);
    }
    const cells = cellsFor([{ kind: 'sims', n: 1 }, null], [{ kind: 'ms', n: 5 }], '/x');
    expect(cells.map((c) => [c.us, c.them])).toEqual([['1', 'ms:5'], ['default', 'ms:5']]);
  });

  it('gives a move ten minutes, or its clock and a minute', () => {
    expect(moveTimeout(null)).toBe(600_000);
    expect(moveTimeout({ kind: 'sims', n: 9 })).toBe(600_000);
    expect(moveTimeout({ kind: 'ms', n: 900_000 })).toBe(960_000);
  });
});

/** A host that plays their side on our own engine, and fails where told. */
class FakeHost implements HostLike {
  private s: AzulState | null = null;
  private seed = 0;
  private seat = 0;
  private legal: number[] = [];
  private plyNo = 0;
  constructor(private readonly faults: { disagreeAt?: [number, number, number]; failAt?: [number, number]; hangAt?: [number, number] } = {}) {}

  async ask<T>(req: Record<string, unknown>, timeoutMs: number, what: string): Promise<T> {
    const r = (x: unknown): Promise<T> => Promise.resolve(x as T);
    switch (req.type) {
      case 'configure':
        return r({ cells: (req.cells as { id: number }[]).map((c) => ({ id: c.id, settings: {}, source: {} })) });
      case 'game':
        this.seed = req.seed as number;
        this.seat = req.seat as number;
        this.s = newGame(this.seed);
        return r({ ok: true });
      case 'deal':
        return r({ ok: true });
      case 'ply': {
        this.plyNo = req.ply as number;
        this.legal = req.legal as number[];
        const d = this.faults.disagreeAt;
        if (d && d[0] === this.seed && d[1] === this.seat && d[2] === this.plyNo) return r({ disagreement: 'a fake difference', details: { why: 'told to' } });
        return r({ ok: true });
      }
      case 'move': {
        const f = this.faults.failAt;
        if (f && f[0] === this.seed && f[1] === this.seat) throw new Error(`${what}: the fake host died`);
        const h = this.faults.hangAt;
        if (h && h[0] === this.seed && h[1] === this.seat) {
          return new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer in ${timeoutMs} ms`)), timeoutMs));
        }
        return r({ action: this.legal[0], simulations: 7, value: 0.25, ms: 3 });
      }
      case 'step': {
        const s = this.s!;
        const round = s.roundIndex;
        apply(s, req.action as number);
        const o = outcome(s);
        return r({ scores: s.scores.slice(), roundFinished: s.isTerminal || s.roundIndex !== round, terminated: s.isTerminal, winner: o === null ? null : o === 1 ? 0 : o === -1 ? 1 : -1 });
      }
      default:
        throw new Error(`the fake host has no ${String(req.type)}`);
    }
  }

  close(): void {}
}

/** Our side: the last legal move, with fixed figures. */
class FakeServe implements ServeLike {
  async choose(position: ReturnType<typeof toJSON>): Promise<OurAnswer> {
    return { action: position.legalActions[position.legalActions.length - 1], simulations: 11, value: 0.5, searchMs: 2, proofMs: 1 };
  }
  close(): void {}
}

async function fakeMatch(opts: { workers: number; games?: number; faults?: ConstructorParameters<typeof FakeHost>[0]; timeoutMs?: number }) {
  const dir = scratch();
  const out = join(dir, 'match');
  const cells: Cell[] = cellsFor([{ kind: 'sims', n: 11 }], [{ kind: 'sims', n: 7 }, { kind: 'sims', n: 8 }], `${out}.configs`);
  const result = await runMatch({
    cells, ours: resolveOurs(new Map()), theirSettings: {}, hostPaths: { repo: '', library: '', actor: '', actorSha256: '' }, binary: '',
    games: opts.games ?? 4, seed: 10, workers: opts.workers, out, header: { pin: 'fake', repeatable: true }, log: () => {},
    start: { host: () => new FakeHost(opts.faults), serve: () => new FakeServe() },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  const lines = readFileSync(`${out}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  return { result, lines, out, json: JSON.parse(readFileSync(`${out}.json`, 'utf8')) as Record<string, unknown> };
}

describe('a match against a fake host and a fake serve [G13-29] [G13-33] [G13-36] [G13-37] [G13-38] [G13-39] [G13-40] [G13-42]', () => {
  it('plays the same games whatever --workers is, a line per game after a header', async () => {
    const one = await fakeMatch({ workers: 1 });
    const three = await fakeMatch({ workers: 3 });
    const games = (ls: Record<string, unknown>[]) => ls.filter((l) => l.kind === 'game').map((l) => JSON.stringify(l)).sort();
    expect(one.lines[0].kind).toBe('header');
    expect(games(one.lines)).toHaveLength(8);
    expect(games(three.lines)).toEqual(games(one.lines));
    expect(one.result.stopped).toBe(false);
  });

  it('records each move, our proof apart, and summarises from the lines [G13-29] [G13-39] [G13-41]', async () => {
    const { lines, json } = await fakeMatch({ workers: 2 });
    expect(table(json as unknown as Summary).split('\n')[0]).toBe('Their player ran on the CPU, which is not how its author trained or measured it.');
    const game = lines.find((l) => l.kind === 'game') as { record: { moves: Record<string, unknown>[]; scores: number[]; winner: number; plies: number } };
    const ours = game.record.moves.find((m) => m.side === 'ours')!;
    const theirs = game.record.moves.find((m) => m.side === 'theirs')!;
    expect(ours).toMatchObject({ simulations: 11, ms: 2, proofMs: 1, value: 0.5 });
    expect(theirs).toMatchObject({ simulations: 7, ms: 3, value: 0.25 });
    expect(game.record.plies).toBe(game.record.moves.length);
    const cell = (json.cells as Record<string, unknown>[])[0] as { ours: Record<string, number>; theirs: Record<string, number>; dealPairsCounted: number };
    expect(cell.ours.meanMs).toBe(2);
    expect(cell.ours.meanProofMs).toBe(1);
    expect(cell.theirs.meanSimulations).toBe(7);
    expect(cell.dealPairsCounted).toBe(2);
  });

  it('leaves a deal pair with a disagreement out, reported, and plays on [G13-19] [G13-40]', async () => {
    const { lines, json, result } = await fakeMatch({ workers: 2, faults: { disagreeAt: [11, 1, 4] } });
    expect(result.stopped).toBe(false);
    const d = lines.find((l) => (l as { disagreement?: unknown }).disagreement !== undefined) as { disagreement: { report: string; ply: number } };
    expect(d.disagreement.ply).toBe(4);
    const report = JSON.parse(readFileSync(d.disagreement.report, 'utf8')) as Record<string, unknown>;
    expect(report).toMatchObject({ seed: 11, ourSeat: 1, ply: 4, comparison: 'a fake difference', pin: 'fake' });
    expect((report.moves as number[]).length).toBe(4);
    const cells = json.cells as { dealPairsCounted: number; dealPairsLeftOut: { seed: number }[] }[];
    for (const c of cells) {
      expect(c.dealPairsCounted).toBe(1);
      expect(c.dealPairsLeftOut.map((x) => x.seed)).toEqual([11]);
    }
  });

  it('stops on a host that dies, keeping the games written, and still writes its summary [G13-36] [G13-37] [G13-42]', async () => {
    const { lines, json, result } = await fakeMatch({ workers: 1, faults: { failAt: [11, 0] } });
    expect(result.stopped).toBe(true);
    expect(result.error?.message).toMatch(/fake host died/);
    expect(json.stopped).toBe(true);
    expect(lines.filter((l) => l.kind === 'game')).toHaveLength(2);
  });

  it('stops on a move left unanswered past its timeout, naming where [G13-38]', async () => {
    const { result } = await fakeMatch({ workers: 1, faults: { hangAt: [10, 1] }, timeoutMs: 50 });
    expect(result.stopped).toBe(true);
    expect(result.error?.message).toMatch(/seed 10, our seat 1, ply \d+.*no answer/);
  });
});

describe('a real process that fails [G13-36] [G13-38]', () => {
  const script = (body: string): string => {
    const p = join(scratch(), 'fake-serve.sh');
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const position = toJSON(newGame(1));

  it('is a failed read, not a crash: one that never answers, one that exits, one that is missing', async () => {
    const silent = new Serve(script('sleep 30'), 'c', 'k', null);
    await expect(silent.choose(position, 100, 'silent')).rejects.toThrow(/silent: no answer/);
    silent.close();
    const quitter = new Serve(script('echo gone >&2; exit 3'), 'c', 'k', null);
    await expect(quitter.choose(position, 5000, 'quitter')).rejects.toThrow(/quitter: (the process ended|write EPIPE)/);
    quitter.close();
    const missing = new Serve(join(scratch(), 'no-such-binary'), 'c', 'k', null);
    await expect(missing.choose(position, 5000, 'missing')).rejects.toThrow(/missing: .*ENOENT/);
    missing.close();
  });
});

describe('the README and the fairness note [G13-48] [G13-49]', () => {
  // Mutation, seen red: one figure of `timing.json` edited after the table was rendered.
  it('carries exactly the table timing.json renders to', () => {
    expect(existsSync(TIMING_PATH), 'grzhx/timing.json: run `grzhx timing`').toBe(true);
    const timing = JSON.parse(readFileSync(TIMING_PATH, 'utf8')) as Timing;
    expect(committedTable(readFileSync(README_PATH, 'utf8'))).toBe(renderTable(timing));
  });

  it('names the pinned commit and release', () => {
    const pin = readPin();
    const fairness = readFileSync(join(HERE, 'FAIRNESS.md'), 'utf8');
    expect(fairness).toContain(pin.commit);
    expect(fairness).toContain(pin.release);
  });
});
