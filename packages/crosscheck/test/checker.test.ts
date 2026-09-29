/**
 * The checker [C10-12]..[C10-15], and the package it lives in [C10-1],
 * [C10-2], [C10-4].
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as engine from 'engine';
import { describe, expect, it } from 'vitest';
import { Checker, gameMessage } from '../src/checker.js';
import { type GameInput, invent } from '../src/game.js';
import { REJECTED, SEAM_MISUSED, START_REJECTED, describe as decode, equalWords } from '../src/record.js';
import { CHECKER, PACKAGE, REPO } from './support/harness.js';

const played = invent(engine, 2, 0, { steer: 'uniform', start: { kind: 'new' }, cap: 30 });

async function withChecker<T>(f: (c: Checker) => Promise<T>): Promise<T> {
  const c = new Checker(CHECKER);
  try {
    return await f(c);
  } finally {
    await c.close();
  }
}

/** Runs the checker on raw bytes and returns how it ended. */
function raw(bytes: Buffer): { status: number | null; stderr: string } {
  const r = spawnSync(CHECKER, [], { input: bytes });
  return { status: r.status, stderr: r.stderr.toString() };
}

function framed(words: number[]): Buffer {
  const b = Buffer.alloc(4 + 4 * words.length);
  b.writeUInt32LE(words.length, 0);
  words.forEach((w, i) => b.writeUInt32LE(w >>> 0, 4 + 4 * i));
  return b;
}

describe('the protocol [C10-12]', () => {
  it('lays a game message out as the spec lists it', () => {
    const input: GameInput = { start: null, shuffles: [[1, 2], [3]], actions: [7, 9], probes: [200, 201, 202] };
    expect([...gameMessage(5, input)]).toEqual([5, 0, 0, 2, 2, 1, 2, 1, 3, 2, 7, 9, 3, 200, 201, 202]);
  });

  it('answers with one record per record the TypeScript engine produced, equal word for word', async () => {
    const rust = await withChecker((c) => c.replay(0, played.input));
    expect(rust).toHaveLength(played.records.length);
    rust.forEach((r, i) => expect(equalWords(r, played.records[i]), `record ${i}`).toBe(true));
  });

  it('answers the same game message identically, holding nothing between games [C10-15]', async () => {
    const other = invent(engine, 2, 1, { steer: 'floor', start: { kind: 'new' }, cap: 30 });
    const [a, b] = await withChecker(async (c) => {
      const first = await c.ask(gameMessage(0, played.input));
      await c.ask(gameMessage(1, other.input));
      return [first, await c.ask(gameMessage(0, played.input))];
    });
    expect(equalWords(a, b)).toBe(true);
  });
});

describe('the recorded shuffler [C10-13]', () => {
  it('reports an index the input holds no order for as status 3, and stops', async () => {
    const rust = await withChecker((c) => c.replay(0, { ...played.input, shuffles: [] }));
    expect(rust).toHaveLength(1);
    expect(rust[0][0]).toBe(SEAM_MISUSED);
  });

  it('reports an order that is not a permutation of the bag as status 3, and never writes it', async () => {
    const wrong = { ...played.input, shuffles: [new Array(100).fill(0)] };
    const rust = await withChecker((c) => c.replay(0, wrong));
    expect(rust).toHaveLength(1);
    expect(rust[0][0]).toBe(SEAM_MISUSED);
    // The engine dealt from its own, unshuffled bag — colours in order, drawn
    // from the end — so the first display holds four of colour 4.
    expect(decode(rust[0])['factories[0][4]']).toBe(4);
  });
});

describe('rejection [C10-14]', () => {
  it('describes the unchanged position with status 1 and emits nothing after', async () => {
    const legal = new Set(engine.legalActions(engine.newGame(0, (bag, i) => bag.splice(0, 100, ...(played.input.shuffles[i] as never[])))));
    const illegal = [...Array(180).keys()].find((a) => !legal.has(a))!;
    const input = { ...played.input, actions: [illegal, ...played.input.actions], probes: [0, ...played.input.probes] };
    const rust = await withChecker((c) => c.replay(0, input));
    expect(rust).toHaveLength(2);
    expect(rust[1][0]).toBe(REJECTED);
    const before = decode(rust[0]);
    const after = decode(rust[1]);
    delete before.status;
    delete after.status;
    delete before.probe;
    delete after.probe;
    delete before.probeLegal;
    delete after.probeLegal;
    expect(after).toEqual(before);
  });

  it('answers a start the engine refuses with one status-2 record', async () => {
    const start = engine.toCanonical(engine.newGame(0, () => {}));
    start.tilesLeft = 3;
    const rust = await withChecker((c) => c.replay(0, { start, shuffles: [], actions: [], probes: [0] }));
    expect(rust).toHaveLength(1);
    expect([...rust[0]]).toEqual([START_REJECTED]);
  });
});

describe('the checker never panics [C10-2]', () => {
  const cases: [string, Buffer][] = [
    ['a truncated message', framed([1, 0, 0])],
    ['a start kind past 1', framed([0, 0, 7, 0, 0, 1, 0])],
    ['an action past 255', framed([0, 0, 0, 0, 1, 300, 2, 0, 0])],
    ['a probe count that does not match', framed([0, 0, 0, 0, 0, 5, 0])],
    ['a length prefix past any game', Buffer.from([0xff, 0xff, 0xff, 0x7f])],
    ['a frame cut short', Buffer.from([8, 0, 0, 0, 1, 2])],
  ];
  for (const [name, bytes] of cases) {
    it(`exits 2 with a message on ${name}`, () => {
      const { status, stderr } = raw(bytes);
      expect(status).toBe(2);
      expect(stderr).toMatch(/^checker: /);
      expect(stderr).not.toMatch(/panicked/);
    });
  }

  it('exits 0 on an empty input', () => {
    expect(raw(Buffer.alloc(0)).status).toBe(0);
  });

  it('is synchronous and safe, as 0009 [R9-4] and [R9-6] require of the crate', () => {
    const source = readFileSync(join(PACKAGE, 'checker', 'src', 'main.rs'), 'utf8');
    expect(source).toMatch(/^#!\[forbid\(unsafe_code\)\]$/m);
    expect(source).not.toMatch(/\basync\b|\.await\b|\bimpl\s+Future\b|\bstd::thread\b/);
    const lock = readFileSync(join(PACKAGE, 'checker', 'Cargo.lock'), 'utf8');
    expect(lock).not.toMatch(/name = "(tokio|async-std|smol|futures|futures-[^"]*|async-[^"]*)"/);
  });
});

describe('the package [C10-1], [C10-4]', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));

  it('depends on the workspace engine and nothing else at run time', () => {
    expect(pkg.name).toBe('crosscheck');
    expect(pkg.dependencies).toEqual({ engine: 'workspace:*' });
  });

  it('pins the checker to the crate alone, locked, on the engine’s own toolchain', () => {
    const cargo = readFileSync(join(PACKAGE, 'checker', 'Cargo.toml'), 'utf8');
    expect(cargo).toMatch(/^name = "azul_crosscheck"$/m);
    const sections = [...cargo.matchAll(/^\[([^\]]*dependencies[^\]]*)\]$/gm)].map((m) => m[1]);
    expect(sections).toEqual(['dependencies']);
    const deps = cargo.split('[dependencies]')[1].split(/^\[/m)[0].trim();
    expect(deps).toBe('azul_engine = { path = "../../engine-rs" }');
    const lock = readFileSync(join(PACKAGE, 'checker', 'Cargo.lock'), 'utf8');
    expect([...lock.matchAll(/^name = "([^"]+)"$/gm)].map((m) => m[1]).sort()).toEqual(['azul_crosscheck', 'azul_engine']);
    expect(readFileSync(join(PACKAGE, 'checker', 'rust-toolchain.toml'))).toEqual(
      readFileSync(join(REPO, 'packages', 'engine-rs', 'rust-toolchain.toml')),
    );
  });

  it('has the four scripts, every cargo call locked', () => {
    expect(Object.keys(pkg.scripts).sort()).toEqual(['check', 'replay', 'test', 'typecheck']);
    for (const script of Object.values<string>(pkg.scripts)) {
      for (const call of script.matchAll(/cargo \w+[^&]*/g)) expect(call[0]).toMatch(/--locked/);
    }
    expect(pkg.scripts.typecheck).toMatch(/tsc --noEmit/);
    expect(pkg.scripts.typecheck).toMatch(/clippy.*-D warnings/);
    expect(pkg.scripts.check).toMatch(/--release/);
  });
});
