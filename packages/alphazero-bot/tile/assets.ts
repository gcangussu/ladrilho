/**
 * Their player's files: fetched from danluu.com/game/tile, cached outside the
 * repository, never committed.
 *
 * The cache holds the page, its worker, the three single-threaded WASM builds,
 * the two threaded ones and both networks, with a manifest of their sha256s. Every match records
 * those hashes, so a result says which version of their player it measured.
 *
 * The search settings their page uses (the minimax pruning spec, the MCTS
 * constants, the score weights) are read out of the cached page and worker
 * rather than copied here, so an update upstream is followed, and
 * `check-updates` reports it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SOURCE = 'https://danluu.com/game/tile/';

/** Their single-threaded builds. */
export const BUILDS = { scalar: 'pkg', simd: 'pkg_simd', relaxed: 'pkg_relaxed' } as const;
export type Build = keyof typeof BUILDS;

/**
 * Their threaded builds (wasm-bindgen-rayon over shared memory); there is no
 * scalar one. Their glue imports the rayon worker helper from `RAYON_HELPER`,
 * which is fetched for the record but replaced to run in Node (`threads.ts`).
 */
export const THREADED_BUILDS: Partial<Record<Build, string>> = { simd: 'pkg_simd_threads', relaxed: 'pkg_relaxed_threads' };
export const RAYON_HELPER = 'snippets/wasm-bindgen-rayon/src/workerHelpers.no-bundler.js';

const FILES = [
  'index.html',
  'worker.js',
  'model.safetensors',
  'nnue.nnue',
  ...Object.values(BUILDS).flatMap((d) => [`${d}/wasm.js`, `${d}/wasm_bg.wasm`]),
  ...Object.values(THREADED_BUILDS).flatMap((d) => [`${d}/wasm.js`, `${d}/wasm_bg.wasm`, `${d}/${RAYON_HELPER}`]),
];

export interface FileRecord {
  sha256: string;
  bytes: number;
  etag: string | null;
  lastModified: string | null;
}

export interface Manifest {
  source: string;
  fetchedAt: string;
  files: Record<string, FileRecord>;
}

/** What their page plays with, read from the page and the worker. */
export interface TheirSettings {
  modelName: string;
  nnueName: string;
  /** Which network the page's default opponent uses: `nnue` means minimax. */
  standardModel: string;
  pruning: string;
  cPuct: number;
  fpu: number;
  cpuctStdevPrior: number;
  cpuctStdevPriorWeight: number;
  cpuctStdevScale: number;
  /** The MCTS (`ckpt`) player's score weight. */
  mctsScoreValueWeight: number;
  /** The minimax (`nnue`) player's score weight. */
  minimaxScoreValueWeight: number;
  minimaxTerminalScoreValueWeight: number;
  scoreValueScale: number;
  /** Names of settings the page no longer declares, so the fallback was used. */
  fallbacks: string[];
}

export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'azul-tile');
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function get(path: string, etag?: string | null): Promise<{ status: number; body: Uint8Array; etag: string | null; lastModified: string | null }> {
  const headers: Record<string, string> = {};
  if (etag) headers['if-none-match'] = etag;
  const r = await fetch(new URL(path, SOURCE), { headers });
  if (r.status !== 200 && r.status !== 304) throw new Error(`GET ${path}: HTTP ${r.status}`);
  return {
    status: r.status,
    body: r.status === 200 ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array(),
    etag: r.headers.get('etag'),
    lastModified: r.headers.get('last-modified'),
  };
}

export function readManifest(dir: string): Manifest | null {
  const p = join(dir, 'manifest.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Manifest) : null;
}

function writeAtomic(path: string, body: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, body);
  renameSync(`${path}.tmp`, path);
}

/** Downloads every file, replacing the cache. */
export async function fetchAll(dir: string, log: (s: string) => void = () => {}): Promise<Manifest> {
  const files: Record<string, FileRecord> = {};
  const bodies: Record<string, Uint8Array> = {};
  for (const f of FILES) {
    const r = await get(f);
    bodies[f] = r.body;
    files[f] = { sha256: sha256(r.body), bytes: r.body.length, etag: r.etag, lastModified: r.lastModified };
    log(`  ${f}  ${r.body.length} bytes  ${files[f].sha256.slice(0, 12)}`);
  }
  // Every file is in hand before any is written: a failed download leaves the
  // previous cache whole rather than half old, half new.
  for (const f of FILES) writeAtomic(join(dir, f), bodies[f]);
  const manifest: Manifest = { source: SOURCE, fetchedAt: new Date().toISOString(), files };
  writeAtomic(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** The cache, fetched first if it is missing or incomplete. */
export async function ensureCache(dir: string, log: (s: string) => void = () => {}): Promise<Manifest> {
  const m = readManifest(dir);
  if (m !== null && FILES.every((f) => m.files[f] !== undefined && existsSync(join(dir, f)))) return m;
  log(`fetching their player from ${SOURCE} into ${dir}`);
  return fetchAll(dir, log);
}

export interface UpdateReport {
  changed: { file: string; was: string; now: string }[];
  settingsChanged: { key: string; was: unknown; now: unknown }[];
}

/**
 * Asks the site for each file, conditionally on its etag, and compares what
 * comes back by sha256. Writes nothing.
 */
export async function checkUpdates(dir: string): Promise<UpdateReport> {
  const m = readManifest(dir);
  if (m === null) throw new Error(`no cache at ${dir}: run \`fetch\` first`);
  const changed: UpdateReport['changed'] = [];
  const fresh: Record<string, Uint8Array> = {};
  for (const f of FILES) {
    const was = m.files[f];
    const r = await get(f, was?.etag);
    if (r.status === 304) continue;
    const now = sha256(r.body);
    fresh[f] = r.body;
    if (was === undefined || now !== was.sha256) changed.push({ file: f, was: was?.sha256 ?? '(absent)', now });
  }
  const settingsChanged: UpdateReport['settingsChanged'] = [];
  if (fresh['index.html'] !== undefined || fresh['worker.js'] !== undefined) {
    const dec = (f: string) => new TextDecoder().decode(fresh[f] ?? readFileSync(join(dir, f)));
    const before = parseSettings(readFileSync(join(dir, 'index.html'), 'utf8'), readFileSync(join(dir, 'worker.js'), 'utf8'));
    const after = parseSettings(dec('index.html'), dec('worker.js'));
    for (const k of Object.keys(after) as (keyof TheirSettings)[]) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) settingsChanged.push({ key: k, was: before[k], now: after[k] });
    }
  }
  return { changed, settingsChanged };
}

export function loadSettings(dir: string): TheirSettings {
  return parseSettings(readFileSync(join(dir, 'index.html'), 'utf8'), readFileSync(join(dir, 'worker.js'), 'utf8'));
}

/**
 * The page's own constants. Each has the value the page had when this was
 * written as its fallback, and a fallback used is reported rather than silent.
 */
export function parseSettings(html: string, worker: string): TheirSettings {
  const fallbacks: string[] = [];
  const str = (src: string, name: string, fallback: string): string => {
    const m = new RegExp(`const ${name}\\s*=\\s*(['"])(.*?)\\1`).exec(src);
    if (m) return m[2];
    fallbacks.push(name);
    return fallback;
  };
  const num = (name: string, fallback: number): number => {
    const m = new RegExp(`const ${name}\\s*=\\s*(-?[0-9.]+)\\s*;`).exec(html);
    if (m) return Number(m[1]);
    fallbacks.push(name);
    return fallback;
  };
  return {
    modelName: str(html, 'WEB_MODEL_NAME', 'Modified PJF 32x2 iter 2354'),
    nnueName: str(html, 'WEB_NNUE_NAME', 'NNUE v1 ckpt 643'),
    standardModel: str(html, 'STANDARD_MODEL_KIND', 'nnue'),
    pruning: str(
      worker,
      'DEFAULT_MINIMAX_PRUNING_OVERRIDES',
      'lmr=1,rf=1,lmr_d1=3,lmr_i1=3,lmr_r1=2,lmr_d2=6,lmr_i2=6,lmr_r2=3,rf_md=4,rf_mpd=0.12,vote=sf,vsf_b=16,vsf_qs=11,vsf_db=0',
    ),
    cPuct: num('DEFAULT_AI_C_PUCT', 1.3),
    fpu: num('DEFAULT_AI_FPU', 0.15),
    cpuctStdevPrior: num('DEFAULT_CPUCT_STDEV_PRIOR', 0.35),
    cpuctStdevPriorWeight: num('DEFAULT_CPUCT_STDEV_PRIOR_WEIGHT', 1.25),
    cpuctStdevScale: num('DEFAULT_CPUCT_STDEV_SCALE', 0.65),
    mctsScoreValueWeight: num('HUMAN_AI_SCORE_VALUE_WEIGHT', 0.1),
    minimaxScoreValueWeight: num('ALT_MODEL_SCORE_VALUE_WEIGHT', 0.0),
    minimaxTerminalScoreValueWeight: num('MINIMAX_TERMINAL_SCORE_VALUE_WEIGHT', 0.0),
    scoreValueScale: num('HUMAN_AI_SCORE_VALUE_SCALE', 20.0),
    fallbacks,
  };
}
