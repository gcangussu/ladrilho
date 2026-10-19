/**
 * Their release, pinned and cached outside the repository ([G13-1] to [G13-5]).
 *
 * `pinned.json` names their commit and release and the sha256 of every file
 * the harness takes from them. The cache holds a clone of their repository at
 * that commit and the release's assets, each checked against the pin before
 * anything is built or loaded. Their repository carries no licence, so none
 * of it is ever copied into ours.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readJson, sha256, writeAtomic } from '../eval/files.js';
import { PACKAGE } from '../eval/paths.js';

/** The harness's own directory, in the suite and in the bundle alike. */
export const HERE = join(PACKAGE, 'grzhx');
export const PIN_PATH = join(HERE, 'pinned.json');

export const ASSETS = [
  'azul-generation-2300.pt',
  'azul-generation-2300.json',
  'SHA256SUMS.txt',
  'azul-2300-local-play-windows-x64.zip',
] as const;
export type Asset = (typeof ASSETS)[number];

/** The assets their own `SHA256SUMS.txt` lists; it cannot list itself. */
const SUMMED: readonly Asset[] = ['azul-generation-2300.pt', 'azul-generation-2300.json', 'azul-2300-local-play-windows-x64.zip'];

export interface Pin {
  repository: string;
  commit: string;
  release: string;
  /** sha256 of each downloaded asset's bytes. */
  assets: Record<Asset, string>;
  /** sha256 of each blob's bytes at the commit (`git cat-file blob`), by path. */
  blobs: Record<string, string>;
}

export function readPin(path = PIN_PATH): Pin {
  const p = readJson<Pin>(path);
  if (!/^[0-9a-f]{40}$/.test(p.commit)) throw new Error(`${path}: commit is not a full sha`);
  for (const a of ASSETS) if (!/^[0-9a-f]{64}$/.test(p.assets?.[a] ?? '')) throw new Error(`${path}: no sha256 for ${a}`);
  return p;
}

export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'azul-grzhx');
}

export const repoDir = (cache: string): string => join(cache, 'repo');
export const assetPath = (cache: string, a: Asset): string => join(cache, 'assets', a);

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
}

function gitBytes(args: string[], cwd: string): Buffer {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
}

const releaseUrl = (pin: Pick<Pin, 'repository' | 'release'>, a: Asset): string =>
  `https://github.com/${pin.repository}/releases/download/${pin.release}/${a}`;

async function download(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { redirect: 'follow' });
  if (r.status !== 200) throw new Error(`GET ${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Their `SHA256SUMS.txt`: `<sha256>  <name>` per line. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

function mismatch(file: string, want: string, got: string, against: string): Error {
  return new Error(`${file}: sha256 ${got} does not match ${against}'s ${want}; nothing of it is kept`);
}

/** The sha256 of every blob in the tree at `commit`, by path. */
export function blobHashes(dir: string, commit: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of git(['ls-tree', '-r', '-z', commit], dir).split('\0')) {
    if (!line) continue;
    const [meta, path] = line.split('\t');
    const [, type, object] = meta.split(' ');
    if (type !== 'blob') continue;
    out[path] = sha256(gitBytes(['cat-file', 'blob', object], dir));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function cloneAt(repository: string, commit: string, into: string): void {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(dirname(into), { recursive: true });
  git(['clone', '--quiet', '--no-checkout', `https://github.com/${repository}.git`, into]);
  git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', commit], into);
}

/**
 * The clone at the pinned commit, with an unmodified working tree: what is
 * built and imported is exactly the pinned tree.
 */
function checkRepo(cache: string, pin: Pin): void {
  const dir = repoDir(cache);
  const head = git(['rev-parse', 'HEAD'], dir).trim();
  if (head !== pin.commit) throw new Error(`${dir} is at ${head}, not the pinned ${pin.commit}: run \`grzhx fetch\``);
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], dir).trim();
  if (dirty) throw new Error(`${dir} has been modified:\n${dirty}\nrun \`grzhx fetch\` to restore it`);
}

function checkAsset(cache: string, pin: Pin, a: Asset, sums: Map<string, string>): void {
  const got = sha256(readFileSync(assetPath(cache, a)));
  if (got !== pin.assets[a]) throw mismatch(a, pin.assets[a], got, 'pinned.json');
  if (SUMMED.includes(a) && sums.get(a) !== got) throw mismatch(a, sums.get(a) ?? '(absent)', got, 'SHA256SUMS.txt');
}

/** Whether the cache holds the pinned tree and every asset, checked. */
export function cacheIsComplete(cache: string, pin: Pin): boolean {
  if (!existsSync(join(repoDir(cache), '.git')) || !ASSETS.every((a) => existsSync(assetPath(cache, a)))) return false;
  try {
    verifyCache(cache, pin);
    return true;
  } catch {
    return false;
  }
}

/** [G13-3]: every file of theirs in the cache checked against the pin, and the summed assets against their sums. */
export function verifyCache(cache: string, pin: Pin): void {
  checkRepo(cache, pin);
  const sumsGot = sha256(readFileSync(assetPath(cache, 'SHA256SUMS.txt')));
  if (sumsGot !== pin.assets['SHA256SUMS.txt']) throw mismatch('SHA256SUMS.txt', pin.assets['SHA256SUMS.txt'], sumsGot, 'pinned.json');
  const sums = parseSums(readFileSync(assetPath(cache, 'SHA256SUMS.txt'), 'utf8'));
  for (const a of ASSETS) checkAsset(cache, pin, a, sums);
}

/**
 * [G13-3]: clones their repository at the pinned commit and downloads the
 * release's assets into the cache. Every asset is downloaded and checked in a
 * scratch directory first, so a mismatch leaves nothing a later command
 * would load.
 */
export async function fetchRelease(cache: string, pin: Pin, log: (s: string) => void = () => {}): Promise<void> {
  log(`fetching ${pin.repository} at ${pin.commit.slice(0, 12)} and release ${pin.release} into ${cache}`);
  const staging = join(cache, `staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    const bodies = new Map<Asset, Uint8Array>();
    for (const a of ASSETS) {
      const body = await download(releaseUrl(pin, a));
      const got = sha256(body);
      if (got !== pin.assets[a]) throw mismatch(a, pin.assets[a], got, 'pinned.json');
      bodies.set(a, body);
      log(`  ${a}  ${body.length} bytes  ${got.slice(0, 12)}`);
    }
    const sums = parseSums(new TextDecoder().decode(bodies.get('SHA256SUMS.txt')));
    for (const a of SUMMED) {
      const got = sha256(bodies.get(a)!);
      if (sums.get(a) !== got) throw mismatch(a, sums.get(a) ?? '(absent)', got, 'SHA256SUMS.txt');
    }
    cloneAt(pin.repository, pin.commit, join(staging, 'repo'));
    checkRepo(staging, pin);
    for (const a of ASSETS) writeAtomic(assetPath(staging, a), bodies.get(a)!);
    // Only now, with everything in hand and checked, does the cache change.
    rmSync(repoDir(cache), { recursive: true, force: true });
    rmSync(join(cache, 'assets'), { recursive: true, force: true });
    renameSync(join(staging, 'repo'), repoDir(cache));
    renameSync(join(staging, 'assets'), join(cache, 'assets'));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  verifyCache(cache, pin);
}

/** The cache, fetched first when it is missing or does not match the pin. */
export async function ensureRelease(cache: string, pin: Pin, log: (s: string) => void = () => {}): Promise<void> {
  if (cacheIsComplete(cache, pin)) return;
  await fetchRelease(cache, pin, log);
}

/**
 * [G13-2]: a fresh pin of `commit` and `tag`, from a scratch clone and fresh
 * downloads. Returns the new pin and what changed from `old`.
 */
export async function makePin(repository: string, commit: string, tag: string, old: Pin | null): Promise<{ pin: Pin; changes: string[] }> {
  const scratch = join(tmpdir(), `azul-grzhx-pin-${process.pid}`);
  try {
    cloneAt(repository, commit, scratch);
    const full = git(['rev-parse', 'HEAD'], scratch).trim();
    const blobs = blobHashes(scratch, full);
    const assets = {} as Record<Asset, string>;
    const bodies = new Map<Asset, Uint8Array>();
    for (const a of ASSETS) {
      const body = await download(releaseUrl({ repository, release: tag }, a));
      bodies.set(a, body);
      assets[a] = sha256(body);
    }
    const sums = parseSums(new TextDecoder().decode(bodies.get('SHA256SUMS.txt')));
    for (const a of SUMMED) if (sums.get(a) !== assets[a]) throw mismatch(a, sums.get(a) ?? '(absent)', assets[a], 'SHA256SUMS.txt');
    const pin: Pin = { repository, commit: full, release: tag, assets, blobs };
    const changes: string[] = [];
    if (old === null) changes.push('a new pin');
    else {
      if (old.commit !== pin.commit) changes.push(`commit ${old.commit} → ${pin.commit}`);
      if (old.release !== pin.release) changes.push(`release ${old.release} → ${pin.release}`);
      for (const a of ASSETS) if (old.assets[a] !== pin.assets[a]) changes.push(`asset ${a}: ${old.assets[a]} → ${pin.assets[a]}`);
      const paths = new Set([...Object.keys(old.blobs), ...Object.keys(pin.blobs)]);
      for (const p of [...paths].sort()) if (old.blobs[p] !== pin.blobs[p]) changes.push(`blob ${p}: ${old.blobs[p] ?? '(absent)'} → ${pin.blobs[p] ?? '(absent)'}`);
    }
    return { pin, changes };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function writePin(pin: Pin, path = PIN_PATH): void {
  writeAtomic(path, `${JSON.stringify(pin, null, 2)}\n`);
}

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`https://api.github.com/repos/${path}`, { headers: { accept: 'application/vnd.github+json' } });
  if (r.status !== 200) throw new Error(`GitHub API ${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

/**
 * [G13-5]: their default branch's head, and the release's assets' digests,
 * against the pin. Writes nothing.
 */
export async function checkUpdates(pin: Pin): Promise<string[]> {
  const changed: string[] = [];
  const repo = await api<{ default_branch: string }>(pin.repository);
  const head = await api<{ sha: string }>(`${pin.repository}/commits/${repo.default_branch}`);
  if (head.sha !== pin.commit) changed.push(`their ${repo.default_branch} is at ${head.sha}, the pin at ${pin.commit}`);
  const release = await api<{ assets: { name: string; digest?: string | null }[] }>(`${pin.repository}/releases/tags/${pin.release}`);
  for (const a of ASSETS) {
    const found = release.assets.find((x) => x.name === a);
    if (found === undefined) changed.push(`release ${pin.release} no longer has ${a}`);
    else if (found.digest && found.digest !== `sha256:${pin.assets[a]}`) changed.push(`${a}: ${found.digest}, pinned sha256:${pin.assets[a]}`);
  }
  return changed;
}
