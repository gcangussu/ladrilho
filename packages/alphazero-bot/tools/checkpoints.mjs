/**
 * Where milestone checkpoints live ([0011 Z11-103]): on one GitHub Release,
 * not in git. `milestones/checkpoints.json` is committed and names each
 * checkpoint's sha256 and length; the bytes are the Release's assets, one per
 * milestone, named `<run>-<generation>.bin`, and are fetched to the path they
 * always had, `milestones/<run>/<generation>/checkpoint.bin`, which git
 * ignores. The parity file beside each stays committed.
 *
 *   node tools/checkpoints.mjs fetch [<run>:<g> …] [--all]
 *   node tools/checkpoints.mjs record
 *   node tools/checkpoints.mjs upload [<run>:<g> …]
 *   node tools/checkpoints.mjs verify
 *
 * `fetch` with no names fetches the set the suite and the payload need
 * ([Z11-104]); a file already on disk is hashed, never fetched again, and one
 * that does not match the manifest is refused, not replaced. `record` adds
 * every milestone checkpoint on disk the manifest lacks, as the loop does for
 * each milestone it writes. `upload` puts every recorded checkpoint the
 * Release lacks on it, and is a person's act, like a commit ([Z11-62]).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundled into node_modules/.alphazero/ by tools/bundle.mjs, this module's own
// path is the bundle's, as eval/paths.ts allows for too.
const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED = HERE.includes('node_modules');
const PACKAGE = BUNDLED ? join(HERE, '..', '..') : join(HERE, '..');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export const manifestPath = (packageDir = PACKAGE) => join(packageDir, 'milestones', 'checkpoints.json');
export const checkpointPath = (key, packageDir = PACKAGE) => join(packageDir, 'milestones', key, 'checkpoint.bin');
export const assetName = (key) => `${key.replace('/', '-')}.bin`;

/** `run/generation`, the manifest's key. */
export function keyOf(run, generation) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(run) || !Number.isInteger(generation) || generation < 0) {
    throw new Error(`${run}/${generation} is not a milestone`);
  }
  return `${run}/${generation}`;
}

function parseName(name) {
  const m = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})[:/](\d+)$/.exec(name);
  if (m === null) throw new Error(`${name} is not <run>:<generation>`);
  return keyOf(m[1], Number(m[2]));
}

export function readManifest(packageDir = PACKAGE) {
  return JSON.parse(readFileSync(manifestPath(packageDir), 'utf8'));
}

/** Written with its keys in a fixed order, so a new milestone is a one-entry diff. */
export function writeManifest(manifest, packageDir = PACKAGE) {
  const order = (k) => {
    const [run, g] = k.split('/');
    return [run, Number(g)];
  };
  const keys = Object.keys(manifest.checkpoints).sort((a, b) => {
    const [ra, ga] = order(a);
    const [rb, gb] = order(b);
    return ra < rb ? -1 : ra > rb ? 1 : ga - gb;
  });
  const checkpoints = Object.fromEntries(keys.map((k) => [k, manifest.checkpoints[k]]));
  const text = `${JSON.stringify({ ...manifest, checkpoints }, null, 2)}\n`;
  writeFileSync(manifestPath(packageDir), text);
}

/**
 * Adds the checkpoint on disk at `run/generation` to the manifest, or does
 * nothing when it is there already with the same bytes. Refuses a checkpoint
 * whose bytes differ from the ones recorded: a milestone is written once.
 */
export function recordCheckpoint(run, generation, packageDir = PACKAGE) {
  const key = keyOf(run, generation);
  const bytes = readFileSync(checkpointPath(key, packageDir));
  const entry = { sha256: sha256(bytes), bytes: bytes.length };
  const manifest = readManifest(packageDir);
  const had = manifest.checkpoints[key];
  if (had !== undefined) {
    if (had.sha256 !== entry.sha256) throw new Error(`${key}'s checkpoint is not the one checkpoints.json records`);
    return false;
  }
  manifest.checkpoints[key] = entry;
  writeManifest(manifest, packageDir);
  return true;
}

/**
 * The milestones the suite and the payload read ([Z11-104]): `master`, as
 * `web/shipped.json` names it; the anchors; the pool as its seed and the
 * log's replacements leave it ([Z11-73]); and each run's latest recorded
 * milestone, which [Z11-44]'s width-256 check loads.
 */
export function neededKeys(packageDir = PACKAGE) {
  const manifest = readManifest(packageDir);
  const json = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
  const keys = new Set();
  const shipped = json(join(packageDir, 'web', 'shipped.json'));
  if (shipped !== null) keys.add(keyOf(shipped.run, shipped.generation));
  const anchors = json(join(packageDir, 'milestones', 'anchors.json'));
  for (const m of anchors?.members ?? []) keys.add(keyOf(m.run, m.generation));
  const seed = json(join(packageDir, 'milestones', 'pool.json'));
  if (seed !== null) {
    const pool = new Set(seed.members.map((m) => keyOf(m.run, m.generation)));
    for (const e of json(join(packageDir, 'milestones', 'log.json')) ?? []) {
      const r = e.kind === 'milestone' ? e.pool?.replaced : undefined;
      if (r === undefined || r === null) continue;
      pool.delete(keyOf(r.run, r.generation));
      pool.add(keyOf(e.run, e.generation));
    }
    for (const k of pool) keys.add(k);
  }
  const latest = new Map();
  for (const k of Object.keys(manifest.checkpoints)) {
    const [run, g] = k.split('/');
    if ((latest.get(run) ?? -1) < Number(g)) latest.set(run, Number(g));
  }
  for (const [run, g] of latest) keys.add(keyOf(run, g));
  for (const k of keys) {
    if (manifest.checkpoints[k] === undefined) throw new Error(`${k} is needed but checkpoints.json does not record it`);
  }
  return [...keys].sort();
}

/**
 * The recorded milestones a command's arguments name, as `<run>:<g>` (alone,
 * in a comma list, or before `=`) or as a checkpoint path, which the lanes
 * fetch before the command runs. A name the manifest does not record is left
 * for the command to judge.
 */
export function namedKeys(args, recorded) {
  const keys = new Set();
  for (const token of args.flatMap((a) => a.split(','))) {
    const m =
      /(?:^|[\\/])milestones[\\/]([A-Za-z0-9][A-Za-z0-9_-]*)[\\/](\d+)[\\/]checkpoint\.bin$/.exec(token) ??
      /^([A-Za-z0-9][A-Za-z0-9_-]*):(\d+)(?:=.*)?$/.exec(token);
    if (m === null) continue;
    const key = keyOf(m[1], Number(m[2]));
    if (recorded[key] !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

/** The Release's download address for one asset. */
export function assetUrl(manifest, key) {
  return `https://github.com/${manifest.repository}/releases/download/${manifest.release}/${assetName(key)}`;
}

/**
 * Puts each named checkpoint on disk, checked against the manifest. A file
 * already there is hashed and kept, or refused when it does not match; a
 * missing one is downloaded beside its destination, checked, and only then
 * renamed into place, so a failed or wrong download leaves nothing behind.
 * `url` maps a key to where it is fetched from (the Release, unless a test
 * says otherwise). Returns the keys it downloaded.
 */
export async function fetchCheckpoints(keys, { packageDir = PACKAGE, url } = {}) {
  const manifest = readManifest(packageDir);
  const from = url ?? ((k) => assetUrl(manifest, k));
  const fetched = [];
  for (const key of keys) {
    const want = manifest.checkpoints[key];
    if (want === undefined) throw new Error(`checkpoints.json does not record ${key}`);
    const dest = checkpointPath(key, packageDir);
    if (existsSync(dest)) {
      if (sha256(readFileSync(dest)) !== want.sha256) {
        throw new Error(`${dest} does not match checkpoints.json; move it aside to fetch the recorded one`);
      }
      continue;
    }
    const response = await fetch(from(key));
    if (!response.ok) throw new Error(`${key}: ${from(key)} answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== want.bytes || sha256(bytes) !== want.sha256) {
      throw new Error(`${key}: the download does not match checkpoints.json`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    const part = `${dest}.download`;
    writeFileSync(part, bytes);
    renameSync(part, dest);
    fetched.push(key);
  }
  return fetched;
}

/** Every `milestones/<run>/<generation>/checkpoint.bin` on disk, as keys. */
export function checkpointsOnDisk(packageDir = PACKAGE) {
  const root = join(packageDir, 'milestones');
  const keys = [];
  for (const run of readdirSync(root, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    for (const g of readdirSync(join(root, run.name), { withFileTypes: true })) {
      if (g.isDirectory() && /^\d+$/.test(g.name) && existsSync(join(root, run.name, g.name, 'checkpoint.bin'))) {
        keys.push(keyOf(run.name, Number(g.name)));
      }
    }
  }
  return keys.sort();
}

function releaseAssets(manifest) {
  const out = execFileSync('gh', ['release', 'view', manifest.release, '--repo', manifest.repository, '--json', 'assets'], {
    encoding: 'utf8',
  });
  return new Map(JSON.parse(out).assets.map((a) => [a.name, a]));
}

/** The recorded checkpoints the Release lacks, or names an asset whose length is not the recorded one. */
function missingFromRelease(manifest, assets, keys) {
  const missing = [];
  for (const key of keys) {
    const asset = assets.get(assetName(key));
    if (asset === undefined) missing.push(key);
    else if (asset.size !== manifest.checkpoints[key].bytes) {
      throw new Error(`the Release's ${asset.name} is ${asset.size} bytes, not the ${manifest.checkpoints[key].bytes} recorded`);
    }
  }
  return missing;
}

function upload(keys) {
  const manifest = readManifest();
  const missing = missingFromRelease(manifest, releaseAssets(manifest), keys);
  const stage = mkdtempSync(join(tmpdir(), 'az-upload-'));
  try {
    for (const key of missing) {
      const src = checkpointPath(key);
      if (sha256(readFileSync(src)) !== manifest.checkpoints[key].sha256) throw new Error(`${src} does not match checkpoints.json`);
      const named = join(stage, assetName(key));
      copyFileSync(src, named);
      execFileSync('gh', ['release', 'upload', manifest.release, named, '--repo', manifest.repository], { stdio: 'inherit' });
      rmSync(named);
      console.log(`uploaded ${key}`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  console.log(`${missing.length} uploaded, ${keys.length - missing.length} already on the Release`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
  const names = rest.filter((a) => !a.startsWith('--')).map(parseName);
  switch (command) {
    case 'fetch': {
      const keys = rest.includes('--all') ? Object.keys(readManifest().checkpoints) : names.length > 0 ? names : neededKeys();
      const fetched = await fetchCheckpoints(keys);
      if (fetched.length > 0) console.log(`fetched ${fetched.length} checkpoint${fetched.length === 1 ? '' : 's'}`);
      break;
    }
    case 'record': {
      const added = checkpointsOnDisk().filter((k) => {
        const [run, g] = k.split('/');
        return recordCheckpoint(run, Number(g));
      });
      console.log(added.length === 0 ? 'every checkpoint on disk is recorded' : `recorded ${added.join(', ')}`);
      break;
    }
    case 'upload':
      upload(names.length > 0 ? names : Object.keys(readManifest().checkpoints).sort());
      break;
    case 'verify': {
      const manifest = readManifest();
      const assets = releaseAssets(manifest);
      const missing = missingFromRelease(manifest, assets, Object.keys(manifest.checkpoints));
      const recorded = new Set(Object.keys(manifest.checkpoints).map(assetName));
      const extra = [...assets.keys()].filter((n) => !recorded.has(n));
      if (missing.length > 0) console.log(`not on the Release: ${missing.join(', ')}`);
      if (extra.length > 0) console.log(`on the Release but not recorded: ${extra.join(', ')}`);
      if (missing.length > 0 || extra.length > 0) process.exit(1);
      console.log(`all ${assets.size} recorded checkpoints are on the Release at their recorded lengths`);
      break;
    }
    default:
      throw new Error('usage: checkpoints.mjs fetch [<run>:<g> …] [--all] | record | upload [<run>:<g> …] | verify');
  }
}

// Run as a script, not inlined into a lane's bundle: there argv[1] is the bundle
// too, and every lane command would be read as one of these.
if (!BUNDLED && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
