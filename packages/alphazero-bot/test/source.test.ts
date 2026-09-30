/**
 * The source check ([Z11-47]): the package's shape ([Z11-1], [Z11-2],
 * [Z11-4]), nothing taken from the expert ([Z11-3]), no clock in the crate's
 * library ([Z11-18]), the test profile ([Z11-64]), and the build flag
 * ([Z11-2]).
 *
 * Each clause is a function run against sources it exists to reject, so what
 * the check covers is legible rather than asserted. Words the clauses search
 * for are assembled from fragments, so this file never matches itself.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACKAGE } from '../eval/paths.js';

interface Source {
  path: string;
  text: string;
}

function walk(dir: string, out: Source[] = []): Source[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'target', '.venv', '__pycache__', 'runs', '.pytest_cache'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|rs|py|toml|json|sh|in|txt|md)$/.test(name)) {
      out.push({ path: relative(PACKAGE, p), text: readFileSync(p, 'utf8') });
    }
  }
  return out;
}

const SOURCES = walk(PACKAGE);
const read = (p: string): string => readFileSync(join(PACKAGE, p), 'utf8');

/** `//` comments removed, line by line, as `engine-rs`'s check does. */
function code(text: string): string {
  return text
    .split('\n')
    .map((l) => l.split('//')[0])
    .join('\n');
}

const EXPERT = ['ai', '-bot'].join('');
const UI = ['u', 'i'].join('');
const ORIGINAL = ['alpha', '-zero-', 'general'].join('');

/** [Z11-1]: what TypeScript may import. */
function importFaults(files: Source[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((f) => /\.(ts|mjs)$/.test(f.path))) {
    for (const m of f.text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      const root = spec.split('/')[0];
      if (root === EXPERT || root === UI) out.push(`${f.path} imports ${spec}`);
      if (root === 'bot' && !/^(eval|test)\//.test(f.path)) out.push(`${f.path} imports bot outside the lanes and tests`);
      if (spec.startsWith('.') && posix.normalize(posix.join(posix.dirname(f.path), spec)).startsWith('..')) {
        out.push(`${f.path} reaches outside the package: ${spec}`);
      }
    }
  }
  return out;
}

/** [Z11-1]: the manifest's dependencies. */
function manifestFaults(pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): string[] {
  const out: string[] = [];
  if (pkg.name !== 'alphazero-bot') out.push(`the package is named ${pkg.name}`);
  const deps = Object.entries(pkg.dependencies ?? {});
  if (deps.length !== 1 || deps[0][0] !== 'engine' || deps[0][1] !== 'workspace:*') out.push('runtime dependencies other than engine');
  for (const d of Object.keys(pkg.devDependencies ?? {})) {
    if (d === EXPERT || d === UI) out.push(`devDependency ${d}`);
  }
  return out;
}

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

/**
 * [Z11-2]'s list: the general-purpose crates the crate may use. Anything that
 * is the player itself — network, search, view, formats — depends on the
 * engine alone.
 */
const GENERAL_CRATES = ['clap', 'hex', 'rand', 'rand_distr', 'rand_xoshiro', 'serde', 'serde_json', 'sha2'] as const;
const TEST_CRATES = ['proptest', 'tempfile'] as const;

/** [Z11-2]: the crate's manifest. */
function cargoFaults(toml: string): string[] {
  const out: string[] = [];
  const pkg = section(toml, '[package]') ?? [];
  for (const want of ['name = "azul_alphazero"', 'edition = "2024"', 'publish = false']) {
    if (!pkg.includes(want)) out.push(`[package] lacks ${want}`);
  }
  const bins = toml.split('\n').filter((l) => l.trim() === '[[bin]]').length;
  const binSection = section(toml, '[[bin]]') ?? [];
  if (bins !== 1 || !binSection.includes('name = "alphazero"')) out.push('not exactly one binary named alphazero');
  if (toml.split('\n').filter((l) => l.trim() === '[lib]').length > 1) out.push('more than one library');
  if (/\[\[(example|bench)\]\]/.test(toml)) out.push('targets other than the library and the binary');
  const deps = section(toml, '[dependencies]') ?? [];
  const engine = deps.filter((d) => d.startsWith('azul_engine'));
  if (engine.length !== 1 || !/^azul_engine\s*=\s*\{\s*path\s*=\s*"\.\.\/engine-rs"\s*\}$/.test(engine[0])) {
    out.push('azul_engine is not a dependency by path ../engine-rs');
  }
  const check = (header: string, allowed: readonly string[]): void => {
    for (const line of section(toml, header) ?? []) {
      const name = line.split('=')[0].trim();
      if (name !== 'azul_engine' && !allowed.includes(name)) out.push(`${header} names ${name}, which is not on the list`);
      if (name !== 'azul_engine' && /\b(path|git)\s*=/.test(line)) out.push(`${header} takes ${name} from outside crates.io`);
    }
  };
  check('[dependencies]', GENERAL_CRATES);
  check('[dev-dependencies]', TEST_CRATES);
  const build = section(toml, '[build-dependencies]');
  if (build !== null && build.length > 0) out.push('[build-dependencies] is not empty');
  if (/\[target\./.test(toml)) out.push('platform-specific dependencies');
  return out;
}

/** [Z11-64]: debug assertions on, at `opt-level = 2`, in the test profile. */
function profileFaults(toml: string): string[] {
  const s = section(toml, '[profile.test]');
  if (s === null) return ['no [profile.test]'];
  const out: string[] = [];
  if (!s.includes('opt-level = 2')) out.push('[profile.test] is not opt-level = 2');
  if (!s.includes('debug-assertions = true')) out.push('[profile.test] does not keep debug assertions on');
  return out;
}

/** The one flag [Z11-2] builds the crate with. */
const X86_64 = `[target.'cfg(target_arch = "x86_64")']`;
const AVX2 = 'rustflags = ["-C", "target-feature=+avx2"]';

/**
 * [Z11-2]: `.cargo/config.toml` builds with AVX2 on x86_64 and nothing else —
 * the one section, holding the one line, and no flags anywhere outside it.
 */
function buildFlagFaults(config: string | null): string[] {
  if (config === null) return ['no .cargo/config.toml'];
  const s = section(config, X86_64);
  if (s === null) return [`no ${X86_64} in .cargo/config.toml`];
  const out: string[] = [];
  if (s.length !== 1 || s[0] !== AVX2) out.push(`${X86_64} is not exactly ${AVX2}`);
  const headers = config.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('['));
  if (headers.length !== 1) out.push(`.cargo/config.toml has sections besides ${X86_64}: ${headers.join(', ')}`);
  return out;
}

/** [Z11-2]: every cargo invocation in the scripts is locked. */
function lockedFaults(scripts: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    for (const part of cmd.split(/&&|\|\||;|\|/)) {
      const p = part.trim();
      if (p.startsWith('cargo ') && !p.split(/\s+/).includes('--locked')) out.push(`script ${name}: ${p}`);
    }
  }
  return out;
}

/** [Z11-3]: nothing from the expert or the program it ports. */
function expertFaults(files: Source[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.text.includes(ORIGINAL)) out.push(`${f.path} names the original program`);
    if (f.text.includes(['packages', EXPERT].join('/'))) out.push(`${f.path} names the expert's path`);
    if (new RegExp(`(from|import|require\\()\\s*\\(?\\s*['"]${EXPERT}`).test(f.text)) out.push(`${f.path} imports the expert`);
  }
  return out;
}

const CLOCKS = [['Inst', 'ant'].join(''), ['System', 'Time'].join('')];

/**
 * The crate's library: every `.rs` under `src/` but `main.rs` and the modules
 * only it declares ([Z11-47]).
 */
function libraryFiles(files: Source[]): Source[] {
  const rs = files.filter((f) => f.path.startsWith('src/') && f.path.endsWith('.rs'));
  const main = rs.find((f) => f.path === 'src/main.rs');
  const lib = rs.find((f) => f.path === 'src/lib.rs');
  const declared = (f: Source | undefined) =>
    new Set([...(f?.text ?? '').matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)].map((m) => `src/${m[1]}.rs`));
  const binOnly = new Set([...declared(main)].filter((p) => !declared(lib).has(p)));
  return rs.filter((f) => f.path !== 'src/main.rs' && !binOnly.has(f.path));
}

/** [Z11-18], [Z11-47]: no clock read in the library. */
function clockFaults(files: Source[]): string[] {
  const out: string[] = [];
  for (const f of libraryFiles(files)) {
    const words = code(f.text).split(/[^A-Za-z0-9_]+/);
    for (const c of CLOCKS) if (words.includes(c)) out.push(`${f.path} reads a clock (${c})`);
  }
  return out;
}

const ASYNC = [['as', 'ync'].join(''), ['aw', 'ait'].join(''), ['Fut', 'ure'].join('')];
const UNSAFE = ['un', 'safe'].join('');

/** [Z11-2] as [0009 R9-4] and [0009 R9-6] read: no async, unsafe forbidden. */
function rustFaults(files: Source[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((f) => f.path.startsWith('src/') && f.path.endsWith('.rs'))) {
    const words = code(f.text).split(/[^A-Za-z0-9_]+/);
    for (const w of ASYNC) if (words.includes(w)) out.push(`${f.path}: ${w}`);
    if (words.includes(UNSAFE) && !f.text.includes(`#![forbid(${UNSAFE}_code)]`)) out.push(`${f.path}: ${UNSAFE}`);
  }
  for (const root of ['src/lib.rs', 'src/main.rs']) {
    const f = files.find((x) => x.path === root);
    if (f === undefined || !f.text.includes(`#![forbid(${UNSAFE}_code)]`)) out.push(`${root} does not forbid ${UNSAFE} code`);
  }
  return out;
}

const SCRIPTS: Record<string, RegExp> = {
  test: /^cargo test --locked && vitest run$/,
  typecheck: /^tsc --noEmit && cargo clippy --locked --all-targets -- -D warnings$/,
  'test:train': /pytest/,
  train: /cli\.mjs train$/,
  'stop-simulation': /cli\.mjs stop-simulation$/,
  milestone: /cli\.mjs milestone$/,
  gate: /cli\.mjs gate$/,
  latency: /cli\.mjs latency$/,
  throughput: /cli\.mjs throughput$/,
};

describe('the source check [Z11-47]', () => {
  const pkg = JSON.parse(read('package.json'));
  const toml = read('Cargo.toml');
  const cargoConfig = existsSync(join(PACKAGE, '.cargo/config.toml')) ? read('.cargo/config.toml') : null;

  it('finds the package as it is [Z11-1], [Z11-2], [Z11-3], [Z11-64]', () => {
    expect(importFaults(SOURCES)).toEqual([]);
    expect(manifestFaults(pkg)).toEqual([]);
    expect(cargoFaults(toml)).toEqual([]);
    expect(profileFaults(toml)).toEqual([]);
    expect(buildFlagFaults(cargoConfig)).toEqual([]);
    expect(lockedFaults(pkg.scripts)).toEqual([]);
    expect(expertFaults(SOURCES)).toEqual([]);
    expect(clockFaults(SOURCES)).toEqual([]);
    expect(rustFaults(SOURCES)).toEqual([]);
    expect(existsSync(join(PACKAGE, 'Cargo.lock'))).toBe(true);
    const lock = read('Cargo.lock');
    const packages = [...lock.matchAll(/^name = "([^"]+)"/gm)].map((m) => m[1]);
    for (const c of ['azul_engine', ...GENERAL_CRATES, ...TEST_CRATES]) expect(packages, c).toContain(c);
    // No async runtime slipped in beside them ([0009 R9-4]).
    expect(packages.filter((n) => /^(tokio|smol|futures|async-std)/.test(n))).toEqual([]);
    expect(read('rust-toolchain.toml')).toBe(readFileSync(join(PACKAGE, '../engine-rs/rust-toolchain.toml'), 'utf8'));
    expect(libraryFiles(SOURCES).map((f) => f.path)).not.toContain('src/commands.rs');
    expect(libraryFiles(SOURCES).map((f) => f.path)).toContain('src/search.rs');
  });

  it('has the scripts [Z11-4] names', () => {
    for (const [name, want] of Object.entries(SCRIPTS)) expect(pkg.scripts[name], name).toMatch(want);
  });

  it('rejects the imports [Z11-1] forbids', () => {
    const bad = [
      { path: 'eval/x.ts', text: `import { createExpert } from '${EXPERT}';` },
      { path: 'eval/x.ts', text: `import { mount } from '${UI}';` },
      { path: 'tools/x.mjs', text: "import { tier } from 'bot/arena';" },
      { path: 'eval/x.ts', text: `import { apply } from '${['..', '..', 'engine', 'src', 'apply.js'].join('/')}';` },
      { path: 'test/support/x.ts', text: `import { apply } from '${['..', '..', '..', 'engine', 'src'].join('/')}';` },
      { path: 'eval/x.ts', text: `const m = await import('${EXPERT}/gate');` },
    ];
    for (const f of bad) expect(importFaults([f]), f.text).not.toEqual([]);
    expect(importFaults([{ path: 'eval/x.ts', text: "import { tier } from 'bot/arena';" }])).toEqual([]);
    expect(importFaults([{ path: 'test/support/x.ts', text: `import { due } from '${['..', '..', 'eval', 'decision.js'].join('/')}';` }])).toEqual([]);
    expect(manifestFaults({ ...pkg, dependencies: { engine: 'workspace:*', bot: 'workspace:*' } })).not.toEqual([]);
    expect(manifestFaults({ ...pkg, devDependencies: { [EXPERT]: 'workspace:*' } })).not.toEqual([]);
  });

  it('rejects the manifests [Z11-2] and [Z11-64] forbid', () => {
    const variants = [
      toml.replace('edition = "2024"', 'edition = "2021"'),
      toml.replace('publish = false', ''),
      toml.replace('name = "azul_alphazero"', 'name = "other"'),
      toml.replace('name = "alphazero"', 'name = "az"'),
      `${toml}\n[[bin]]\nname = "second"\n`,
      `${toml}\n[[example]]\nname = "x"\n`,
      toml.replace('[dependencies]\n', '[dependencies]\nndarray = "0.16"\n'),
      toml.replace('[dev-dependencies]\n', '[dev-dependencies]\ncriterion = "0.5"\n'),
      toml.replace('[dependencies]\n', '[dependencies]\nbot = { path = "../bot" }\n'),
      toml.replace('sha2 = ', 'sha2 = { git = "https://example.com/sha2" }\nx = '),
      toml.replace('azul_engine = { path = "../engine-rs" }\n', ''),
      `${toml}\n[build-dependencies]\ncc = "1"\n`,
      toml.replace('path = "../engine-rs"', 'git = "https://example.com/engine"'),
    ];
    for (const v of variants) expect(cargoFaults(v), v).not.toEqual([]);
    expect(profileFaults(toml.replace('opt-level = 2', 'opt-level = 0'))).not.toEqual([]);
    expect(profileFaults(toml.replace('debug-assertions = true', 'debug-assertions = false'))).not.toEqual([]);
    expect(profileFaults(toml.replace('[profile.test]', '[profile.bench]'))).not.toEqual([]);
    expect(lockedFaults({ x: 'cargo test && vitest run' })).not.toEqual([]);
    expect(lockedFaults({ x: 'vitest run && cargo build --release' })).not.toEqual([]);
  });

  // Mutations, seen red ([Z11-48]), each in a copy with its anchor confirmed:
  // the line's check weakened to `s.length > 1`, so the missing-line,
  // `+avx2,+fma`, `native` and `x86-64-v3` fixtures pass it; and the sections'
  // check weakened to `headers.length < 1`, so the added `[build]` fixture
  // passes it. Each fails this case; the live package passes either way.
  it('rejects the build flags [Z11-2] forbids', () => {
    const config = cargoConfig ?? '';
    expect(config).toContain(AVX2);
    const variants: (string | null)[] = [
      null,
      '',
      config.replace(AVX2, ''),
      config.replace(AVX2, AVX2.replace('+avx2', '+avx2,+fma')),
      config.replace(AVX2, AVX2.replace('target-feature=+avx2', 'target-cpu=native')),
      config.replace(AVX2, AVX2.replace('target-feature=+avx2', 'target-cpu=x86-64-v3')),
      config.replace(X86_64, '[build]'),
      config.replace('target_arch = "x86_64"', 'target_arch = "aarch64"'),
      `${config}\n[build]\nrustflags = ["-C", "target-cpu=native"]\n`,
      config.replace(AVX2, `${AVX2}\nrustdocflags = ["-C", "target-cpu=native"]`),
    ];
    for (const v of variants) expect(buildFlagFaults(v), String(v)).not.toEqual([]);
  });

  it('rejects what [Z11-3] forbids, in any language', () => {
    const bad = [
      { path: 'eval/x.ts', text: `import { network } from '${EXPERT}';` },
      { path: 'train/x.py', text: `WEIGHTS = "../../packages/${EXPERT}/src/weights.ts"` },
      { path: 'src/x.rs', text: `// ported from ${ORIGINAL}` },
      { path: 'tests/x.rs', text: `const P: &str = "packages/${EXPERT}";` },
    ];
    for (const f of bad) expect(expertFaults([f]), f.text).not.toEqual([]);
  });

  it('rejects a clock read in the library, and allows one in the binary', () => {
    const lib = { path: 'src/lib.rs', text: 'pub mod search;' };
    const main = { path: 'src/main.rs', text: `mod commands;\nuse std::time::${CLOCKS[0]};` };
    const commands = { path: 'src/commands.rs', text: `let t = ${CLOCKS[0]}::now();` };
    expect(clockFaults([lib, main, commands])).toEqual([]);
    for (const c of CLOCKS) {
      const search = { path: 'src/search.rs', text: `fn f() { let t = std::time::${c}::now(); }` };
      expect(clockFaults([lib, main, commands, search]), c).not.toEqual([]);
    }
    // A module declared by both is the library's.
    const shared = { path: 'src/commands.rs', text: `let t = ${CLOCKS[1]}::now();` };
    expect(clockFaults([{ path: 'src/lib.rs', text: 'mod commands;' }, main, shared])).not.toEqual([]);
    // A clock named only in a comment reads nothing.
    expect(clockFaults([lib, { path: 'src/search.rs', text: `// no ${CLOCKS[0]} here` }])).toEqual([]);
  });

  it('rejects async and unsafe code in the crate', () => {
    const roots = [
      { path: 'src/lib.rs', text: `#![forbid(${UNSAFE}_code)]` },
      { path: 'src/main.rs', text: `#![forbid(${UNSAFE}_code)]` },
    ];
    expect(rustFaults(roots)).toEqual([]);
    expect(rustFaults([...roots, { path: 'src/x.rs', text: `pub ${ASYNC[0]} fn f() {}` }])).not.toEqual([]);
    expect(rustFaults([...roots, { path: 'src/x.rs', text: `fn f() { ${UNSAFE} { } }` }])).not.toEqual([]);
    expect(rustFaults([roots[0]])).not.toEqual([]);
  });
});
