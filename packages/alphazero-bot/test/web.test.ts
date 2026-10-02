/**
 * The master opponent's web build (spec 0012): the web crate's shape, the
 * payload and the milestone it carries, the browser entry point, and the one
 * thing all of it exists for — that the module in the bundle plays the moves
 * the crate plays.
 *
 * Each source-check clause is a function run against sources it exists to
 * reject, as in `source.test.ts`, and for the same reason: what the check
 * covers is then legible rather than asserted. Words the clauses search for
 * are assembled from fragments, so this file never matches itself.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { apply, fromCanonical, legalActions, newGame, toJSON } from 'engine';
import { describe, expect, it } from 'vitest';
import { canonicalWords as laneWords, frame, readAnswer } from '../eval/chooser.js';
import { alphazero } from '../eval/crate.js';
import { corpusBlocks, parseBlock } from '../eval/blocks.js';
import { LOG, PACKAGE, REPO, binary } from '../eval/paths.js';
import { SOURCE_PATHS, ladderPaths } from '../eval/provenance.js';
import { shippedMilestone } from '../tools/web.mjs';
import { canonicalWords as webWords } from '../web/canonical.js';
import { CPUCT, FPU, SHIPPED as PAYLOAD_SHIPPED } from '../web/dist/payload.js';
import { MASTER_SIMULATIONS, SHIPPED, createMaster, moduleBytes, validSimulations } from '../web/index.js';

interface Source {
  path: string;
  text: string;
}

const WEB = join(PACKAGE, 'web');
const read = (p: string): string => readFileSync(join(PACKAGE, p), 'utf8');

/** `web/`'s own sources: not its build output, not the generated payload. */
function webSources(dir = WEB, out: Source[] = []): Source[] {
  for (const name of readdirSync(dir)) {
    if (['target', 'dist', 'node_modules'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) webSources(p, out);
    else if (/\.(rs|ts|toml)$/.test(name)) out.push({ path: relative(PACKAGE, p), text: readFileSync(p, 'utf8') });
  }
  return out;
}

const SOURCES = webSources();

/** Comments removed: block comments whole, keeping their lines, then `//` line by line. */
const code = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.split('//')[0])
    .join('\n');

/** The lines of a TOML `[section]`, up to the next header, comments dropped. */
function section(toml: string, header: string): string[] | null {
  const lines = toml.split('\n');
  const at = lines.findIndex((l) => l.trim() === header);
  if (at < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const t = l.trim();
    if (t.startsWith('[')) break;
    if (t !== '' && !t.startsWith('#')) out.push(t);
  }
  return out;
}

/** [T12-1]: the web crate's manifest. */
function manifestFaults(toml: string): string[] {
  const out: string[] = [];
  const pkg = section(toml, '[package]') ?? [];
  for (const want of ['name = "azul_alphazero_web"', 'edition = "2024"', 'publish = false']) {
    if (!pkg.includes(want)) out.push(`[package] lacks ${want}`);
  }
  if (!(section(toml, '[lib]') ?? []).includes('crate-type = ["cdylib", "rlib"]')) out.push('the library is not a cdylib and an rlib');
  if (/\[\[(bin|example|bench)\]\]/.test(toml)) out.push('targets other than the library');
  const deps = (section(toml, '[dependencies]') ?? []).slice().sort();
  const want = ['azul_alphazero = { path = ".." }', 'azul_engine = { path = "../../engine-rs" }'];
  if (JSON.stringify(deps) !== JSON.stringify(want)) out.push(`[dependencies] is ${deps.join('; ')}`);
  for (const h of ['[dev-dependencies]', '[build-dependencies]']) {
    if ((section(toml, h) ?? []).length > 0) out.push(`${h} is not empty`);
  }
  if (/\[target\.[^\]]*dependencies\]/.test(toml)) out.push('platform-specific dependencies');
  const release = section(toml, '[profile.release]') ?? [];
  if (!release.includes('codegen-units = 1') || !release.includes('lto = "fat"')) out.push('[profile.release] is not the crate\'s');
  return out;
}

const WASM = '[target.wasm32-unknown-unknown]';
const SIMD = 'rustflags = ["-C", "target-feature=+simd128"]';

/** [T12-2]: one section, holding one line. */
function configFaults(config: string): string[] {
  const out: string[] = [];
  const s = section(config, WASM);
  if (s === null || s.length !== 1 || s[0] !== SIMD) out.push(`${WASM} is not exactly ${SIMD}`);
  const headers = config.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('['));
  if (headers.length !== 1) out.push(`sections besides ${WASM}: ${headers.join(', ')}`);
  return out;
}

const CHOOSE = ['choose', '_memoised('].join('');
const PLAYER_CODE = [
  ['impl ', 'Evaluator'].join(''),
  ['.for', 'ward('].join(''),
  ['for', 'ward_batch('].join(''),
  ['masked', '_softmax('].join(''),
  ['Search', '::new'].join(''),
];

/** [T12-3]: no player code in the web crate; its one path to a move. */
function playerCodeFaults(files: Source[]): string[] {
  const out: string[] = [];
  const rs = files.filter((f) => f.path.startsWith('web/src/') && f.path.endsWith('.rs'));
  for (const f of rs) for (const p of PLAYER_CODE) if (code(f.text).includes(p)) out.push(`${f.path}: ${p}`);
  if (!rs.some((f) => code(f.text).includes(CHOOSE))) out.push(`no ${CHOOSE} in the web crate`);
  return out;
}

const UNSAFE = ['un', 'safe'].join('');

/** [T12-5]: `unsafe` in `exports.rs` alone, each block explained, the root denying it. */
function unsafeFaults(files: Source[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((f) => f.path.startsWith('web/src/') && f.path.endsWith('.rs'))) {
    const lines = code(f.text).split('\n');
    const uses = lines.filter((l) => new RegExp(`\\b${UNSAFE}\\b`).test(l) && !l.includes(`${UNSAFE}_code`));
    if (f.path !== 'web/src/exports.rs' && uses.length > 0) out.push(`${f.path} uses ${UNSAFE}`);
    if (f.path === 'web/src/exports.rs') {
      const raw = f.text.split('\n');
      raw.forEach((l, i) => {
        if (new RegExp(`\\b${UNSAFE}\\s*\\{`).test(code(l)) && !raw.slice(Math.max(0, i - 3), i + 1).some((p) => p.includes('// SAFETY:'))) {
          out.push(`${f.path}:${i + 1}: an ${UNSAFE} block without a SAFETY comment`);
        }
      });
    }
  }
  const lib = files.find((f) => f.path === 'web/src/lib.rs')?.text ?? '';
  if (!lib.includes(`#![deny(${UNSAFE}_code)]`)) out.push(`web/src/lib.rs does not deny ${UNSAFE} code`);
  const allowed = [...lib.matchAll(new RegExp(`#\\[allow\\(${UNSAFE}_code\\)\\]\\s*\\n\\s*(?:pub\\s+)?mod\\s+(\\w+)`, 'g'))].map((m) => m[1]);
  const allows = lib.split(`#[allow(${UNSAFE}_code)]`).length - 1;
  if (allows !== 1 || allowed[0] !== 'exports') out.push(`${UNSAFE} is allowed somewhere other than mod exports`);
  return out;
}

const FORBIDDEN_TS = [
  'document.',
  'window.',
  ['local', 'Storage'].join(''),
  ['session', 'Storage'].join(''),
  ['indexed', 'DB'].join(''),
  ['fet', 'ch('].join(''),
  ['XMLHttp', 'Request'].join(''),
  ['Web', 'Socket'].join(''),
  ['Date', '.now'].join(''),
  ['new ', 'Date'].join(''),
  ['performance', '.now'].join(''),
  ['instantiate', 'Streaming'].join(''),
  ['compile', 'Streaming'].join(''),
];

/** [T12-12], [T12-17]: what the entry point may import and touch. */
function entryFaults(files: Source[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((f) => f.path.startsWith('web/') && f.path.endsWith('.ts'))) {
    for (const m of f.text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!(spec === 'engine' || spec.startsWith('./'))) out.push(`${f.path} imports ${spec}`);
    }
    for (const w of FORBIDDEN_TS) if (code(f.text).includes(w)) out.push(`${f.path}: ${w}`);
  }
  return out;
}

/** The relative imports a TypeScript file makes, resolved to package paths. */
function importsOf(path: string): string[] {
  const text = read(path);
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)].map((m) =>
    relative(PACKAGE, join(PACKAGE, path, '..', m[1].replace(/\.js$/, '.ts'))),
  );
}

/** Every package file `path` reaches through relative imports. */
function reach(path: string, seen = new Set<string>()): Set<string> {
  for (const p of importsOf(path)) {
    if (!seen.has(p)) {
      seen.add(p);
      reach(p, seen);
    }
  }
  return seen;
}

describe('the web crate [T12-1], [T12-2], [T12-3], [T12-5]', () => {
  const toml = read('web/Cargo.toml');
  const config = read('web/.cargo/config.toml');

  // Mutation, seen red ([T12-29]), in a copy with its anchor confirmed: the web
  // crate calling the crate's unmemoised `choose` in place of its memoised one
  // fails [T12-3]'s clause here, though it plays the same moves.
  it('is as the spec says', () => {
    expect(manifestFaults(toml)).toEqual([]);
    expect(configFaults(config)).toEqual([]);
    expect(playerCodeFaults(SOURCES)).toEqual([]);
    expect(unsafeFaults(SOURCES)).toEqual([]);
    const lock = read('web/Cargo.lock');
    const crates = [...lock.matchAll(/^name = "([^"]+)"/gm)].map((m) => m[1]);
    expect(crates).toContain('azul_alphazero_web');
    // Locked in every script that builds it.
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.test).toContain('cargo test --locked --manifest-path web/Cargo.toml');
    expect(read('tools/web.mjs')).toContain("'build', '--locked'");
  });

  it('rejects the manifests [T12-1] forbids', () => {
    const variants = [
      toml.replace('name = "azul_alphazero_web"', 'name = "web"'),
      toml.replace('edition = "2024"', 'edition = "2021"'),
      toml.replace('publish = false', ''),
      toml.replace('crate-type = ["cdylib", "rlib"]', 'crate-type = ["cdylib"]'),
      toml.replace('[dependencies]\n', '[dependencies]\nwasm-bindgen = "0.2"\n'),
      toml.replace('azul_engine = { path = "../../engine-rs" }', ''),
      `${toml}\n[dev-dependencies]\nproptest = "1"\n`,
      `${toml}\n[build-dependencies]\ncc = "1"\n`,
      `${toml}\n[[bin]]\nname = "x"\n`,
      toml.replace('lto = "fat"', 'lto = "thin"'),
    ];
    for (const v of variants) expect(manifestFaults(v), v).not.toEqual([]);
  });

  it('rejects the build flags [T12-2] forbids', () => {
    const variants = [
      '',
      config.replace(SIMD, ''),
      config.replace('+simd128', '+simd128,+relaxed-simd'),
      config.replace(WASM, '[build]'),
      `${config}\n[build]\nrustflags = ["-C", "target-cpu=native"]\n`,
    ];
    for (const v of variants) expect(configFaults(v), v).not.toEqual([]);
  });

  it('rejects player code, and a crate that never calls the crate [T12-3]', () => {
    const lib = { path: 'web/src/lib.rs', text: `fn f() { ${CHOOSE}&n, &s, &c, &mut m); }` };
    expect(playerCodeFaults([lib])).toEqual([]);
    for (const p of PLAYER_CODE) {
      expect(playerCodeFaults([lib, { path: 'web/src/x.rs', text: `fn g() { ${p} }` }]), p).not.toEqual([]);
    }
    expect(playerCodeFaults([{ path: 'web/src/lib.rs', text: 'fn f() { choose(&n, &s, &c); }' }])).not.toEqual([]);
    // Named only in a comment, it plays nothing.
    expect(playerCodeFaults([{ path: 'web/src/lib.rs', text: `// ${CHOOSE}` }])).not.toEqual([]);
  });

  it(`rejects ${UNSAFE} code outside its one module [T12-5]`, () => {
    const lib = { path: 'web/src/lib.rs', text: `#![deny(${UNSAFE}_code)]\n\n#[allow(${UNSAFE}_code)]\npub mod exports;\n` };
    const exports = { path: 'web/src/exports.rs', text: `// SAFETY: fine\nlet x = ${UNSAFE} { f() };\n` };
    expect(unsafeFaults([lib, exports])).toEqual([]);
    expect(unsafeFaults([lib, { ...exports, text: `let x = ${UNSAFE} { f() };\n` }])).not.toEqual([]);
    expect(unsafeFaults([lib, exports, { path: 'web/src/other.rs', text: `fn f() { ${UNSAFE} { g() } }` }])).not.toEqual([]);
    expect(unsafeFaults([{ ...lib, text: lib.text.replace(`#![deny(${UNSAFE}_code)]`, '') }, exports])).not.toEqual([]);
    expect(unsafeFaults([{ ...lib, text: `${lib.text}\n#[allow(${UNSAFE}_code)]\nmod other;\n` }, exports])).not.toEqual([]);
  });

  it('pins the wasm target in the toolchain [T12-8]', () => {
    expect(read('rust-toolchain.toml')).toContain('targets = ["wasm32-unknown-unknown"]');
  });
});

describe('the entry point [T12-12], [T12-15], [T12-17]', () => {
  it('imports and touches only what it may', () => {
    expect(entryFaults(SOURCES)).toEqual([]);
    const bad = [
      { path: 'web/x.ts', text: "import { chooseMove } from 'bot';" },
      { path: 'web/x.ts', text: "import { canonicalWords } from '../eval/chooser.js';" },
      ...FORBIDDEN_TS.map((w) => ({ path: 'web/x.ts', text: `const x = ${w}y);` })),
    ];
    for (const f of bad) expect(entryFaults([f]), f.text).not.toEqual([]);
    // Named only in a comment, it touches nothing.
    expect(entryFaults([{ path: 'web/x.ts', text: `/** never ${FORBIDDEN_TS[11]} */\nconst x = 1;` }])).toEqual([]);
  });

  it('keeps the payload out of the settings module, which reaches nothing [T12-15]', () => {
    expect([...reach('web/settings.ts')]).toEqual([]);
    // The walk itself, seen to find the payload where it is.
    expect([...reach('web/index.ts')]).toContain('web/dist/payload.ts');
  });
});

describe('the settings [T12-16]', () => {
  it('has the default and the range', () => {
    expect(MASTER_SIMULATIONS).toEqual({ default: 10_000, min: 100, max: 200_000 });
    for (const n of [100, 10_000, 200_000]) expect(validSimulations(n), String(n)).toBe(true);
    for (const n of [99, 200_001, 1000.5, Number.NaN, '1000', null, undefined]) expect(validSimulations(n), String(n)).toBe(false);
  });
});

interface LogEntry {
  kind: string;
  run: string;
  generation: number;
  pool?: { rating?: number };
}

/** [T12-10]: the logged milestone with the highest pool rating, ties to the earlier. */
function strongest(log: LogEntry[]): { run: string; generation: number } | null {
  let best: LogEntry | null = null;
  for (const e of log) {
    if (e.kind !== 'milestone' || typeof e.pool?.rating !== 'number') continue;
    if (best === null || e.pool.rating > (best.pool?.rating as number)) best = e;
  }
  return best === null ? null : { run: best.run, generation: best.generation };
}

describe('the shipped milestone [T12-9], [T12-10], [T12-11]', () => {
  const shipped = JSON.parse(read('web/shipped.json'));

  it('is a committed, logged milestone whose files match', () => {
    const dir = `milestones/${shipped.run}/${shipped.generation}`;
    const tracked = execFileSync('git', ['ls-files', dir], { cwd: PACKAGE, encoding: 'utf8' }).split('\n');
    expect(tracked).toContain(`${dir}/checkpoint.bin`);
    expect(tracked).toContain(`${dir}/checkpoint.parity`);
    expect(() => shippedMilestone(shipped)).not.toThrow();
  });

  // Mutation, seen red ([T12-29]), in a copy with its anchor confirmed:
  // `shipped.json` naming third/90, with its own sha256s, fails this case.
  it('is the strongest by training\'s own record', () => {
    // A stronger milestone committed without naming it here fails this case:
    // the swap is the one-line edit that belongs in the same commit.
    const log = JSON.parse(readFileSync(LOG, 'utf8')) as LogEntry[];
    expect({ run: shipped.run, generation: shipped.generation }).toEqual(strongest(log));
    const m = (run: string, generation: number, rating?: number): LogEntry => ({
      kind: 'milestone', run, generation, ...(rating === undefined ? {} : { pool: { rating } }),
    });
    expect(strongest([m('a', 10, 5), m('a', 20, 7), m('b', 10, 7), m('c', 1)])).toEqual({ run: 'a', generation: 20 });
    expect(strongest([m('c', 1)])).toBeNull();
  });

  it('refuses files that do not match, and a milestone nobody logged [T12-7]', () => {
    expect(() => shippedMilestone({ ...shipped, checkpointSha256: '0'.repeat(64) })).toThrow(/does not match/);
    expect(() => shippedMilestone({ ...shipped, paritySha256: '0'.repeat(64) })).toThrow(/does not match/);
    expect(() => shippedMilestone({ ...shipped, generation: 999_999 })).toThrow(/no checkpoint/);
  });

  it('is what the payload carries, with the logged search settings [T12-7]', () => {
    expect(PAYLOAD_SHIPPED).toEqual(shipped);
    expect(SHIPPED).toEqual(shipped);
    const log = JSON.parse(readFileSync(LOG, 'utf8'));
    const entry = log.find((e: LogEntry) => e.kind === 'milestone' && e.run === shipped.run && e.generation === shipped.generation);
    expect([CPUCT, FPU]).toEqual([entry.config.cpuct, entry.config.fpu]);
  });

  it('is no source path of training [T12-11]', () => {
    const web = 'packages/alphazero-bot/web';
    expect(SOURCE_PATHS.filter((p) => p.startsWith(web) || web.startsWith(p))).toEqual([]);
    expect(ladderPaths(REPO).filter((p) => p.includes('/web/'))).toEqual([]);
  });
});

describe('the copy of canonicalWords [T12-14]', () => {
  // Mutation, seen red ([T12-29]), in a copy with its anchor confirmed: the web
  // copy writing `tilesLeft` before `roundIndex` fails at corpus position 0.
  it('writes every corpus position as the lanes\' adapter does, and as the corpus holds it', () => {
    const blocks = corpusBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(2000);
    for (const [i, w] of blocks.entries()) {
      const c = parseBlock(w);
      const mine = webWords(c);
      expect(mine, `position ${i}`).toEqual(laneWords(c));
      expect(Uint32Array.from(mine.map((x) => x >>> 0)), `position ${i}`).toEqual(w);
    }
  });
});

/** A game played to its end with the first legal move each ply. */
function finished() {
  const s = newGame(5);
  while (legalActions(s).length > 0) apply(s, legalActions(s)[0]);
  return toJSON(s);
}

/** The slice of `WebAssembly` the checks use; Node's types declare less of it. */
interface ModuleApi {
  Module: {
    new (bytes: Uint8Array): object;
    imports(m: object): { name: string }[];
    exports(m: object): { name: string }[];
  };
}
const WebAssemblyApi = (globalThis as unknown as { WebAssembly: ModuleApi }).WebAssembly;

describe('the module [T12-6], [T12-12], [T12-13], [T12-28]', () => {
  it('imports nothing', () => {
    const module = new WebAssemblyApi.Module(moduleBytes());
    expect(WebAssemblyApi.Module.imports(module)).toEqual([]);
    const names = WebAssemblyApi.Module.exports(module).map((e) => e.name);
    for (const n of ['memory', 'alloc', 'load', 'words_ptr', 'choose', 'value', 'error_ptr', 'error_len']) expect(names).toContain(n);
  });

  it('refuses a parity file with one byte flipped', async () => {
    const parity = new Uint8Array(readFileSync(join(PACKAGE, 'milestones', SHIPPED.run, String(SHIPPED.generation), 'checkpoint.parity')));
    await expect(createMaster(parity)).resolves.toBeDefined();
    parity[parity.length - 1] ^= 0x40;
    await expect(createMaster(parity)).rejects.toThrow(/parity/);
  });

  it('chooses a legal move at any valid setting, and refuses the rest', async () => {
    const master = await createMaster();
    const position = toJSON(newGame(3));
    const choice = master.choose(position, 100);
    expect(position.legalActions).toContain(choice.action);
    expect(choice.simulations).toBe(100);
    expect(Math.abs(choice.value)).toBeLessThanOrEqual(1);
    // [T12-25]'s measure: the module's own memory, which a search grows and
    // never gives back. Node's `arrayBuffers` read 0 here, so the lane uses this.
    const held = master.memoryBytes();
    expect(held).toBeGreaterThan(0);
    master.choose(position, 5000);
    expect(master.memoryBytes()).toBeGreaterThanOrEqual(held);
    for (const n of [99, 200_001, 1000.5]) expect(() => master.choose(position, n), String(n)).toThrow(RangeError);
    expect(() => master.choose(finished(), 100)).toThrow(/terminal/);
  });
});

describe('the same moves as the crate [T12-27]', () => {
  // Mutations ([T12-29]), each in a copy with its anchor confirmed: the web
  // crate's `load` storing cpuct and fpu swapped turns this red at the first
  // position; `Seeded::new(1)` in its `choose` leaves it green, as the spec's
  // table records it must. Every one of the 50 positions is compared, so a
  // single drifted move fails this case.
  it('chooses what `alphazero play` chooses, on 50 corpus positions at 800 simulations', { timeout: 600_000 }, async () => {
    const shipped = JSON.parse(read('web/shipped.json'));
    const log = JSON.parse(readFileSync(LOG, 'utf8'));
    const entry = log.find((e: LogEntry) => e.kind === 'milestone' && e.run === shipped.run && e.generation === shipped.generation);
    const dir = mkdtempSync(join(tmpdir(), 'az-web-'));
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ ...entry.config, milestoneSimulations: 800 }));
    const checkpoint = join(PACKAGE, 'milestones', shipped.run, String(shipped.generation), 'checkpoint.bin');
    const master = await createMaster();
    let compared = 0;
    for (const w of corpusBlocks().filter((_, i) => i % 40 === 0)) {
      const position = toJSON(fromCanonical(parseBlock(w), 0));
      if (position.legalActions.length === 0) continue;
      const native = readAnswer(alphazero(binary('debug'), ['play', checkpoint, '--config', config, '--search', 'milestone'], frame(Array.from(w))));
      const mine = master.choose(position, 800);
      expect(mine.action, `corpus position ${compared}`).toBe(native.action);
      expect(Math.abs(mine.value - native.value)).toBeLessThanOrEqual(1e-5);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(50);
  });
});

