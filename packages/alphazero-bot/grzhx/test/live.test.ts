/**
 * `pnpm -F alphazero-bot test:grzhx` ([G13-51]): what needs their cache, the
 * host's environment and their build, held to their own programs. Not in the
 * root suite, for the reason `test:train` is not.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { apply, clone, newGame, Rng, toJSON } from 'engine';
import { buildLibrary, VENV_SH } from '../build.js';
import { dealTiles } from '../convert.js';
import { playGame, type Move } from '../game.js';
import { Host, type HostPaths } from '../processes.js';
import { assetPath, defaultCacheDir, ensureRelease, fetchRelease, HERE, readPin, repoDir, type Pin } from '../release.js';
import { replay } from '../replay.js';

const FULL_BAG = [20, 20, 20, 20, 20];
const cache = defaultCacheDir();
let pin: Pin;
let paths: HostPaths;

beforeAll(async () => {
  pin = readPin();
  await ensureRelease(cache, pin);
  const built = buildLibrary(cache, pin, []);
  paths = { repo: repoDir(cache), library: built.library, actor: assetPath(cache, 'azul-generation-2300.pt'), actorSha256: pin.assets['azul-generation-2300.pt'] };
}, 1_200_000);

type Configured = { refused?: unknown; message?: string; cells?: { id: number; settings: Record<string, number>; source: Record<string, string> }[] };

async function hostWith(cells: Record<string, unknown>[]): Promise<{ host: Host; configured: Configured }> {
  const host = new Host(paths);
  const configured = await host.ask<Configured>({ type: 'configure', cells }, 600_000, 'configure');
  return { host, configured };
}

/** Their own search, driven by `reference.py` rather than the host. */
function reference(request: Record<string, unknown>): Record<string, unknown> {
  const out = execFileSync('bash', [VENV_SH, join(HERE, 'test', 'reference.py')], {
    input: JSON.stringify({ repo: paths.repo, library: paths.library, actor: paths.actor, ...request }),
    maxBuffer: 1 << 24,
  });
  return JSON.parse(out.toString()) as Record<string, unknown>;
}

/** A game through one host, their search on both seats; its moves and the events a reference replays. */
async function selfPlay(host: Host, seed: number, cell = 0) {
  const events: [string, unknown][] = [];
  const moves: Move[] = [];
  const s = newGame(seed);
  events.push(['deal', dealTiles(FULL_BAG, s.factories)]);
  const theirs = async (_p: unknown, ply: number): Promise<Move> => {
    const a = await host.ask<Move>({ type: 'move' }, 600_000, `self-play ply ${ply}`);
    return { ...a, side: 'theirs' };
  };
  const record = await playGame({ host, cell, matchSeed: 1, seed, ourSeat: 0, ours: theirs, theirs, timeoutMs: 600_000 });
  // The events again, from the moves, as the lockstep game saw them.
  const g = newGame(seed);
  record.moves.forEach((m, ply) => {
    events.push(['search', ply]);
    const before = toJSON(g);
    apply(g, m.action);
    events.push(['step', m.action]);
    if (!g.isTerminal && g.roundIndex !== before.round) events.push(['deal', dealTiles(before.bag, g.factories)]);
    moves.push(m);
  });
  return { record, events, moves };
}

describe('their release in the cache [G13-3] [G13-9]', () => {
  it('refuses an asset whose bytes are not the pinned ones, and keeps nothing of it', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'azul-grzhx-fetch-'));
    const altered: Pin = { ...pin, assets: { ...pin.assets, 'azul-generation-2300.json': '0'.repeat(64) } };
    await expect(fetchRelease(scratch, altered)).rejects.toThrow(/azul-generation-2300\.json: sha256 .* does not match pinned\.json/);
    expect(existsSync(join(scratch, 'repo'))).toBe(false);
    expect(existsSync(join(scratch, 'assets'))).toBe(false);
  }, 600_000);

  it('will not load an actor with one byte flipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'azul-grzhx-actor-'));
    const actor = join(dir, 'actor.pt');
    copyFileSync(paths.actor, actor);
    const bytes = readFileSync(actor);
    bytes[bytes.length - 100] ^= 1;
    writeFileSync(actor, bytes);
    const host = new Host({ ...paths, actor });
    await expect(host.ask({ type: 'hello' }, 300_000, 'hello')).rejects.toThrow(/G13-9/);
    host.close();
  }, 300_000);
});

describe('settings their library judges [G13-23] [G13-24] [G13-25]', () => {
  it('clamps candidates, zeroes reuse with trees or a clock, and refuses what their library refuses', async () => {
    const { host, configured } = await hostWith([
      { id: 0, budget: { kind: 'sims', n: 8 } },
      { id: 1, budget: { kind: 'sims', n: 64 }, settings: { trees: 2 } },
      { id: 2, budget: { kind: 'ms', n: 100 }, settings: { chunk: 12 } },
    ]);
    host.close();
    const [a, b, c] = configured.cells!;
    // [G13-23]: defaults read from the actor's record at run time, gumbel_scale as audit_ai.py plays it.
    expect(a.source.maxDepth).toBe("the actor's recorded search");
    expect(a.source.qMode).toBe("the actor's recorded tuning");
    expect(a.settings.gumbelScale).toBe(0);
    expect(a.settings.candidates).toBe(8);
    expect(a.settings.subtreeReuse).toBe(1);
    expect(b.settings.subtreeReuse).toBe(0);
    expect(c.settings.subtreeReuse).toBe(0);
    expect(c.settings.candidates).toBe(12);
    const refused = await hostWith([{ id: 0, budget: { kind: 'sims', n: 64 }, settings: { maxDepth: 0 } }]);
    refused.host.close();
    expect(refused.configured.refused).toBe(0);
  }, 600_000);
});

describe('their moves, held to their own programs [G13-11] [G13-12] [G13-13] [G13-17] [G13-20] [G13-33]', () => {
  // Mutation, seen red (CLAUDE.md), in a copy with its anchor confirmed: the
  // host playing the policy's most probable action in place of the search's
  // decision; the moves then differ from the reference's.
  it("plays a whole game with every comparison passing, the same moves twice, each the native action of their own PipelineSearch", async () => {
    const { host, configured } = await hostWith([{ id: 0, budget: { kind: 'sims', n: 256 } }]);
    try {
      const first = await selfPlay(host, 3);
      const second = await selfPlay(host, 3);
      expect(second.moves.map((m) => m.action)).toEqual(first.moves.map((m) => m.action));
      const ref = reference({ mode: 'pipeline', settings: { ...configured.cells![0].settings, simulations: 256 }, seeds: [1, 3, 0], events: first.events });
      expect(ref.actions).toEqual(first.moves.map((m) => m.action));
      for (const m of first.moves) expect(m.simulations).toBe(256);
    } finally {
      host.close();
    }
  }, 1_200_000);

  // Mutation, seen red: the host putting the imported state in place of the
  // lockstep game at every ply, so it searches a state of ply 0; every
  // seat's reused count is then 0.
  it('reuses its tree across moves when one search object plays each seat, as in a match', async () => {
    const hosts = await Promise.all([0, 1].map(() => hostWith([{ id: 0, budget: { kind: 'sims', n: 256 } }])));
    try {
      const seed = 4;
      const s = newGame(seed);
      for (const [seat, h] of hosts.entries()) {
        await h.host.ask({ type: 'game', cell: 0, matchSeed: 1, seed, seat }, 60_000, 'game');
        await h.host.ask({ type: 'deal', tiles: dealTiles(FULL_BAG, s.factories) }, 60_000, 'deal');
      }
      const reused: number[][] = [[], []];
      for (let ply = 0; !s.isTerminal; ply++) {
        const j = toJSON(s);
        const { importArgs } = await import('../convert.js');
        for (const h of hosts) expect(await h.host.ask({ type: 'ply', ply, imported: importArgs(j), legal: j.legalActions, scores: j.scores }, 60_000, 'ply')).toEqual({ ok: true });
        const mover = s.currentPlayer;
        const a = await hosts[mover].host.ask<{ action: number; reused: number }>({ type: 'move' }, 600_000, 'move');
        reused[mover].push(a.reused);
        const round = s.roundIndex;
        apply(s, a.action);
        for (const h of hosts) await h.host.ask({ type: 'step', action: a.action }, 60_000, 'step');
        if (!s.isTerminal && s.roundIndex !== round) {
          for (const h of hosts) await h.host.ask({ type: 'deal', tiles: dealTiles(j.bag, s.factories) }, 60_000, 'deal');
        }
      }
      for (const seat of [0, 1]) expect(reused[seat].slice(1).some((n) => n > 0), `seat ${seat}: ${reused[seat].join(',')}`).toBe(true);
    } finally {
      for (const h of hosts) h.host.close();
    }
  }, 1_200_000);

  it("votes over three trees exactly as their evaluate_tree_counts.py does", async () => {
    const { host, configured } = await hostWith([{ id: 0, budget: { kind: 'sims', n: 64 }, settings: { trees: 3 } }]);
    try {
      const seed = 5;
      const s = newGame(seed);
      await host.ask({ type: 'game', cell: 0, matchSeed: 1, seed, seat: 0 }, 60_000, 'game');
      const tiles = dealTiles(FULL_BAG, s.factories);
      await host.ask({ type: 'deal', tiles }, 60_000, 'deal');
      const { importArgs } = await import('../convert.js');
      const j = toJSON(s);
      await host.ask({ type: 'ply', ply: 0, imported: importArgs(j), legal: j.legalActions, scores: j.scores }, 60_000, 'ply');
      const a = await host.ask<{ action: number; trees: number[]; simulations: number }>({ type: 'move' }, 600_000, 'move');
      expect(a.trees).toHaveLength(3);
      expect(a.simulations).toBe(3 * 64);
      // The host's own seed for ply 0, recomputed the way the host mixes it.
      const seedOut = execFileSync('bash', [VENV_SH, '-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(HERE, 'host'))}); import host as H; print(H.mix(H.DOMAIN_MOVE, 1, ${seed}, 0, 0))`]).toString().trim();
      const ref = reference({ mode: 'trees', settings: { ...configured.cells![0].settings, simulations: 64 }, seeds: [1, seed, 0], seed: seedOut, events: [['deal', tiles]] });
      expect(a.action).toBe(ref.action);
    } finally {
      host.close();
    }
  }, 1_200_000);
});

describe('their clock [G13-28]', () => {
  /** `rank_search_actions`' choice from a tally: the most votes, ties to the lowest action. */
  const voted = (tally: Record<string, number>): number => {
    let best = -1;
    let most = -1;
    for (const [a, n] of Object.entries(tally).map(([a, n]) => [Number(a), n] as const).sort((x, y) => x[0] - y[0])) {
      if (n > most) {
        most = n;
        best = a;
      }
    }
    return best;
  };

  // Mutation, seen red: the chunk in flight at the clock counted in the vote,
  // its action and simulations recorded as a finished chunk's; it fails on a
  // chunk of 46 simulations where 256 are due. (With their cache on, no chunk
  // was ever cut, and the same mutation stayed green: hence the 5 s cell's.)
  it('plays the vote of the finished chunks, the first always run to its end', async () => {
    const { host } = await hostWith([
      { id: 0, budget: { kind: 'ms', n: 50 }, settings: { chunk: 256 } },
      // Their cache off: with it on, chunks after the first mostly hit it and finish
      // between deadline checks, so no chunk would ever be cut and abandoned.
      { id: 1, budget: { kind: 'ms', n: 5000 }, settings: { chunk: 256, cacheCapacity: 0 } },
    ]);
    try {
      for (const cell of [0, 1]) {
        const seed = 6 + cell;
        const s = newGame(seed);
        await host.ask({ type: 'game', cell, matchSeed: 1, seed, seat: 0 }, 60_000, 'game');
        await host.ask({ type: 'deal', tiles: dealTiles(FULL_BAG, s.factories) }, 60_000, 'deal');
        const { importArgs } = await import('../convert.js');
        const j = toJSON(s);
        await host.ask({ type: 'ply', ply: 0, imported: importArgs(j), legal: j.legalActions, scores: j.scores }, 60_000, 'ply');
        const a = await host.ask<{ action: number; chunks: number; simulations: number; overrun: number; chunkActions: number[]; chunkSimulations: number[]; tally: Record<string, number>; abandoned: boolean }>({ type: 'move' }, 600_000, 'move');
        // Every voting chunk ran its whole budget, by their search's own count: a chunk cut short would not.
        expect(a.chunkSimulations).toHaveLength(a.chunks);
        for (const n of a.chunkSimulations) expect(n).toBe(256);
        expect(a.chunkSimulations.reduce((x, y) => x + y, 0)).toBe(a.simulations);
        const sum = Object.values(a.tally).reduce((x, y) => x + y, 0);
        expect(sum, 'the tally counts each finished chunk once').toBe(a.chunks);
        expect(a.chunkActions).toHaveLength(a.chunks);
        const fromActions: Record<string, number> = {};
        for (const c of a.chunkActions) fromActions[c] = (fromActions[c] ?? 0) + 1;
        expect(a.tally).toEqual(fromActions);
        expect(a.action).toBe(voted(a.tally));
        if (cell === 0) {
          expect(a.chunks).toBe(1);
          expect(a.overrun).toBeGreaterThan(0);
        } else {
          expect(a.chunks).toBeGreaterThan(1);
          expect(a.abandoned, 'the clock cut a chunk short, and it took no part').toBe(true);
        }
      }
    } finally {
      host.close();
    }
  }, 1_200_000);
});

describe('replay [G13-43]', () => {
  // Mutation, seen red: a replayed move applied without our rules' check;
  // the illegal one then throws from our engine instead of reproducing.
  it('finds a clean game clean, and a report whose last move is illegal reproduces', async () => {
    const { host } = await hostWith([{ id: 0, budget: { kind: 'sims', n: 16 } }]);
    try {
      const seed = 8;
      const s = newGame(seed);
      const rng = new Rng(seed);
      const moves: number[] = [];
      while (!s.isTerminal) {
        const legal = toJSON(s).legalActions;
        const a = legal[rng.below(legal.length)];
        apply(s, a);
        moves.push(a);
      }
      expect((await replay(host, { seed, ourSeat: 0, moves })).reproduced).toBe(false);
      const t = newGame(seed);
      for (const a of moves.slice(0, 10)) apply(t, a);
      const illegal = [...Array(180).keys()].find((a) => !toJSON(t).legalActions.includes(a))!;
      const out = await replay(host, { seed, ourSeat: 1, moves: [...moves.slice(0, 10), illegal] });
      expect(out).toMatchObject({ reproduced: true, ply: 10 });
    } finally {
      host.close();
    }
  }, 1_200_000);
});

describe('a full floor that takes the marker [G13-15] [G13-17]', () => {
  // Mutation, seen red: `convert.ts`'s floor count without its cap at seven;
  // their import then refuses the next ply's position, and it reproduces.
  it('passes every comparison when the marker lands on a floor already holding seven tiles', async () => {
    // Steer games on our engine to the case, then replay one through the host.
    let found: { seed: number; moves: number[] } | null = null;
    for (let seed = 1; seed < 4000 && found === null; seed++) {
      const s = newGame(seed);
      const rng = new Rng(seed ^ 0xf100);
      const moves: number[] = [];
      while (!s.isTerminal && found === null) {
        const j = toJSON(s);
        const p = j.currentPlayer;
        const floor = j.players[p].floor.reduce((a, b) => a + b, 0);
        const centre = j.legalActions.filter((a) => (a / 30 | 0) === 5);
        let a: number;
        if (floor === 7 && j.markerInCenter && centre.length > 0) {
          // A take from the centre that leaves the round open, so the next ply's
          // import is of the state holding seven floor tiles and the marker.
          const open = centre.find((c) => {
            const t = clone(s);
            apply(t, c);
            return !t.isTerminal && t.roundIndex === s.roundIndex;
          });
          if (open !== undefined) {
            moves.push(open);
            found = { seed, moves: moves.slice() };
            break;
          }
        }
        // Prefer the floor, so floors fill before the centre is first taken.
        const toFloor = j.legalActions.filter((x) => x % 6 === 5 && (x / 30 | 0) !== 5);
        a = toFloor.length > 0 && rng.below(4) > 0 ? toFloor[rng.below(toFloor.length)] : j.legalActions[rng.below(j.legalActions.length)];
        apply(s, a);
        moves.push(a);
      }
    }
    expect(found, 'no steered game reached a full floor taking the marker').not.toBeNull();
    const { host } = await hostWith([{ id: 0, budget: { kind: 'sims', n: 16 } }]);
    try {
      // Replaying past the move: the comparisons run at the ply after it too.
      const s = newGame(found!.seed);
      for (const a of found!.moves) apply(s, a);
      // The case's state: the round still open, the taker's floor seven tiles and the marker.
      const taker = toJSON(s).players.find((p) => p.floorMarker)!;
      expect(s.isTerminal).toBe(false);
      expect(taker.floor.reduce((x, y) => x + y, 0)).toBe(7);
      const next = [toJSON(s).legalActions[0]];
      const out = await replay(host, { seed: found!.seed, ourSeat: 0, moves: [...found!.moves, ...next] });
      expect(out).toEqual({ reproduced: false, ply: null, comparison: null });
    } finally {
      host.close();
    }
  }, 1_200_000);
});
