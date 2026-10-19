/**
 * Their native library, built from the cached tree ([G13-6], [G13-7]).
 *
 * One build serves every budget: `AZUL_SEARCH_MAX_SIMULATIONS` enters only
 * their `valid_config` and continuation, so at 65 536 it plays below 4096 as
 * their README's build does. `native` and `anytime` are their own options.
 * cmake is the pinned wheel in the host's environment, so nothing is
 * installed on the machine.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, repoDir } from './release.js';

export const THEIR_CAP = 65_536;
export const BUILD_OPTIONS = ['native', 'anytime'] as const;
export type BuildOption = (typeof BUILD_OPTIONS)[number];

export const VENV_SH = join(HERE, 'host', 'venv.sh');
export const VENV = join(HERE, 'host', '.venv');
const CMAKE = join(VENV, 'bin', 'cmake');

export interface Built {
  /** The shared library their `ctypes` binding loads. */
  library: string;
  options: BuildOption[];
  /** Extra compiler flags the preflight found this machine needs, recorded in every result. */
  cxxFlags: string[];
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
}

function has(cmd: string): boolean {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The host's environment, built once by `venv.sh` ([G13-7]). */
export function ensureVenv(log: (s: string) => void = () => {}): void {
  if (existsSync(join(VENV, 'bin', 'python')) && existsSync(CMAKE)) return;
  if (!has('uv')) throw new Error('the host needs uv (https://docs.astral.sh/uv/) to build its environment');
  log('building the host environment (grzhx/host/.venv) from its pinned requirements');
  execFileSync('bash', [VENV_SH, '-c', 'pass'], { stdio: ['ignore', 'inherit', 'inherit'] });
}

/** Their `CMAKE_CXX_STANDARD`, read from their `CMakeLists.txt`. */
export function theirStandard(cache: string): string {
  const text = readFileSync(join(repoDir(cache), 'CMakeLists.txt'), 'utf8');
  const m = /CMAKE_CXX_STANDARD\s+(\d+)/.exec(text);
  if (!m) throw new Error('their CMakeLists.txt names no CMAKE_CXX_STANDARD');
  return m[1];
}

function tryScratch(dir: string, standard: string, flags: string[]): string | null {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'CMakeLists.txt'),
    `cmake_minimum_required(VERSION 3.20)\nproject(preflight CXX)\nset(CMAKE_CXX_STANDARD ${standard})\nset(CMAKE_CXX_STANDARD_REQUIRED ON)\nadd_library(preflight STATIC preflight.cpp)\n`,
  );
  writeFileSync(join(dir, 'preflight.cpp'), '#include <algorithm>\nint preflight() { return std::max(1, 2); }\n');
  try {
    const define = flags.length ? [`-DCMAKE_CXX_FLAGS=${flags.join(' ')}`] : [];
    run(CMAKE, ['-S', dir, '-B', join(dir, 'build'), ...define]);
    run(CMAKE, ['--build', join(dir, 'build')]);
    return null;
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n');
  }
}

/**
 * [G13-7]: cmake and uv are there, and a scratch CMake project with their
 * C++ standard, including `<algorithm>`, compiles as CMake will drive their
 * build. A Command Line Tools install whose own `include/c++/v1` is partial
 * shadows the SDK's complete one; then the SDK's headers are named
 * explicitly, and the flag is returned so every result records it.
 */
export function preflight(cache: string): string[] {
  if (!existsSync(CMAKE)) throw new Error(`no cmake at ${CMAKE}: the host environment is incomplete; delete grzhx/host/.venv and rerun`);
  const standard = theirStandard(cache);
  const dir = join(cache, 'preflight');
  const plain = tryScratch(dir, standard, []);
  if (plain === null) return [];
  if (process.platform === 'darwin') {
    let sdk = '';
    try {
      sdk = run('xcrun', ['--show-sdk-path']).trim();
    } catch {
      /* no SDK to fall back on */
    }
    const headers = join(sdk, 'usr/include/c++/v1');
    if (sdk && existsSync(join(headers, 'algorithm'))) {
      const flags = ['-isystem', headers];
      if (tryScratch(dir, standard, flags) === null) return flags;
    }
  }
  throw new Error(`the C++ compiler cannot build a C++${standard} file including <algorithm> under CMake:\n${plain}`);
}

export const buildDir = (cache: string, options: BuildOption[]): string =>
  join(cache, `build-${options.length ? [...options].sort().join('+') : 'plain'}`);

/** [G13-6]: their library, built once per set of options. */
export function buildLibrary(cache: string, options: BuildOption[], log: (s: string) => void = () => {}): Built {
  ensureVenv(log);
  const cxxFlags = preflight(cache);
  const dir = buildDir(cache, options);
  const library = join(dir, process.platform === 'darwin' ? 'libazul.dylib' : 'libazul.so');
  const stamp = join(dir, 'grzhx-build.json');
  const args = [
    '-S', repoDir(cache), '-B', dir,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DAZUL_SEARCH_MAX_SIMULATIONS=${THEIR_CAP}`,
    `-DAZUL_NATIVE=${options.includes('native') ? 'ON' : 'OFF'}`,
    `-DAZUL_ANYTIME=${options.includes('anytime') ? 'ON' : 'OFF'}`,
    ...(cxxFlags.length ? [`-DCMAKE_CXX_FLAGS=${cxxFlags.join(' ')}`] : []),
  ];
  const want = JSON.stringify(args.slice(2));
  if (existsSync(library) && existsSync(stamp) && readFileSync(stamp, 'utf8') === want) return { library, options, cxxFlags };
  log(`building their library (${options.length ? options.join('+') : 'plain'}) in ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  run(CMAKE, args);
  run(CMAKE, ['--build', dir, '--config', 'Release', '--parallel', '--target', 'azul']);
  if (!existsSync(library)) throw new Error(`their build produced no ${library}`);
  writeFileSync(stamp, want);
  return { library, options, cxxFlags };
}
