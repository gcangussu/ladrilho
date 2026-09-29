/**
 * Provenance ([Z11-63]): the commit, whether any source path had uncommitted
 * changes, and the ladder hash — every file that decides how the ladder plays.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { REPO } from './paths.js';

/** Directories hashed whole: the tiers and the engine every rung plays through. */
const LADDER_DIRS = ['packages/bot/src', 'packages/engine/src'];

/**
 * The files hashed one by one: the four arena files that play, and this
 * package's chooser adapter. The audit corpus and its generator are left out
 * on purpose — they measure `bot`, they do not play.
 */
const LADDER_FILES = [
  'packages/bot/arena/chooser.ts',
  'packages/bot/arena/match.ts',
  'packages/bot/arena/seeds.ts',
  'packages/bot/arena/index.ts',
  'packages/alphazero-bot/eval/chooser.ts',
];

/** The player's own sources, and the engine crate its every move is made on. */
const PLAYER_PATHS = [
  'packages/alphazero-bot/src',
  'packages/alphazero-bot/eval',
  'packages/alphazero-bot/train',
  'packages/alphazero-bot/Cargo.toml',
  'packages/alphazero-bot/Cargo.lock',
  'packages/alphazero-bot/rust-toolchain.toml',
  'packages/engine-rs/src',
  'packages/engine-rs/Cargo.toml',
  'packages/engine-rs/Cargo.lock',
  'packages/engine-rs/rust-toolchain.toml',
];

/**
 * Every source path: the ones hashed, and the player's. The loop's outputs —
 * `milestones/`, `gate/`, `latency/` and `runs/` — are none of them.
 */
export const SOURCE_PATHS: readonly string[] = [...LADDER_DIRS, ...LADDER_FILES, ...PLAYER_PATHS];

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
}

/** The ladder's files under `root`, repository-relative, `/`-separated. */
export function ladderPaths(root: string = REPO): string[] {
  const out: string[] = [];
  for (const d of LADDER_DIRS) if (existsSync(join(root, d))) walk(root, d, out);
  for (const f of LADDER_FILES) if (existsSync(join(root, f))) out.push(f);
  return out;
}

/** Ascending byte order of the UTF-8 path, which is not `localeCompare`'s. */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The sha256 over, per path in ascending byte order: the path, a NUL, the
 * file's length as a decimal string, a NUL, and its contents.
 */
export function hashFiles(root: string, paths: readonly string[]): string {
  const h = createHash('sha256');
  for (const p of [...paths].sort(byteOrder)) {
    const data = readFileSync(join(root, ...p.split('/')));
    h.update(p, 'utf8');
    h.update('\0');
    h.update(String(data.length), 'utf8');
    h.update('\0');
    h.update(data);
  }
  return h.digest('hex');
}

export function ladderHash(root: string = REPO): string {
  return hashFiles(root, ladderPaths(root));
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

/** Whether any source path has uncommitted changes, untracked files included. */
export function dirty(root: string = REPO): boolean {
  const present = SOURCE_PATHS.filter((p) => existsSync(join(root, p)));
  return git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...present]) !== '';
}

export interface Provenance {
  commit: string;
  dirty: boolean;
  ladderHash: string;
}

export function provenance(root: string = REPO): Provenance {
  let commit = 'unknown';
  let isDirty = true;
  try {
    commit = git(root, ['rev-parse', 'HEAD']);
    isDirty = dirty(root);
  } catch {
    // Recorded, never fatal: a failure here must not discard hours of play.
  }
  return { commit, dirty: isDirty, ladderHash: ladderHash(root) };
}

/** A path relative to the repository, `/`-separated, for the records. */
export function repoRelative(path: string): string {
  return relative(REPO, path).split(sep).join('/');
}
