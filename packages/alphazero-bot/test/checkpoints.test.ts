/** Milestone checkpoints on the Release, recorded in `milestones/checkpoints.json` ([Z11-103], [Z11-104]). */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE } from '../eval/paths.js';
import {
  assetName,
  assetUrl,
  checkpointPath,
  checkpointsOnDisk,
  fetchCheckpoints,
  namedKeys,
  neededKeys,
  readManifest,
  recordCheckpoint,
  type Manifest,
} from '../tools/checkpoints.mjs';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A package directory with a manifest recording `files`, and none of them on disk. */
function packageWith(files: Record<string, Buffer>, extra: { shipped?: object; anchors?: object; pool?: object; log?: object[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'az-ckpt-'));
  mkdirSync(join(dir, 'milestones'));
  mkdirSync(join(dir, 'web'));
  const manifest: Manifest = {
    repository: 'owner/repo',
    release: 'checkpoints',
    checkpoints: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, { sha256: sha256(b), bytes: b.length }])),
  };
  writeFileSync(join(dir, 'milestones', 'checkpoints.json'), JSON.stringify(manifest));
  if (extra.shipped) writeFileSync(join(dir, 'web', 'shipped.json'), JSON.stringify(extra.shipped));
  if (extra.anchors) writeFileSync(join(dir, 'milestones', 'anchors.json'), JSON.stringify(extra.anchors));
  if (extra.pool) writeFileSync(join(dir, 'milestones', 'pool.json'), JSON.stringify(extra.pool));
  if (extra.log) writeFileSync(join(dir, 'milestones', 'log.json'), JSON.stringify(extra.log));
  return dir;
}

describe('the committed record [Z11-103]', () => {
  const manifest = readManifest(PACKAGE);
  const tracked = execFileSync('git', ['ls-files', 'milestones'], { cwd: PACKAGE, encoding: 'utf8' }).split('\n');

  it('commits no checkpoint, and a parity file for every recorded one', () => {
    expect(tracked.filter((f) => f.endsWith('/checkpoint.bin'))).toEqual([]);
    for (const key of Object.keys(manifest.checkpoints)) expect(tracked, key).toContain(`milestones/${key}/checkpoint.parity`);
  });

  it('records exactly the logged milestones', () => {
    const log = JSON.parse(readFileSync(join(PACKAGE, 'milestones', 'log.json'), 'utf8')) as { kind: string; run: string; generation: number }[];
    const logged = log.filter((e) => e.kind === 'milestone').map((e) => `${e.run}/${e.generation}`);
    expect(Object.keys(manifest.checkpoints).sort()).toEqual([...new Set(logged)].sort());
  });

  it('matches every checkpoint on disk, and names the Release on this repository', () => {
    // A checkpoint on disk that the manifest does not record is one the loop
    // has written and a person has not yet committed: the test above catches
    // its log entry, this one only what is recorded.
    const onDisk = checkpointsOnDisk(PACKAGE).filter((k) => manifest.checkpoints[k] !== undefined);
    expect(onDisk.length).toBeGreaterThan(0);
    for (const key of onDisk) {
      const bytes = readFileSync(checkpointPath(key, PACKAGE));
      expect({ key, sha256: sha256(bytes), bytes: bytes.length }).toEqual({ key, ...manifest.checkpoints[key] });
    }
    expect(manifest).toMatchObject({ repository: 'gcangussu/ladrilho', release: 'checkpoints' });
    expect(assetUrl(manifest, 'twelfth/120')).toBe('https://github.com/gcangussu/ladrilho/releases/download/checkpoints/twelfth-120.bin');
  });

  it('has every needed checkpoint on disk once the suite has fetched [Z11-104]', () => {
    for (const key of neededKeys(PACKAGE)) expect(existsSync(checkpointPath(key, PACKAGE)), key).toBe(true);
  });
});

describe('the needed set [Z11-104]', () => {
  const b = (n: number) => Buffer.from([n]);
  const files = { 'a/10': b(1), 'a/20': b(2), 'a/30': b(3), 'b/5': b(4), 'b/15': b(5), 'c/1': b(6), 'c/2': b(7) };

  it('is master, the anchors, the pool after its replacements, and each run\'s latest', () => {
    const dir = packageWith(files, {
      shipped: { run: 'a', generation: 10 },
      anchors: { members: [{ run: 'b', generation: 5 }] },
      pool: { members: [{ run: 'c', generation: 1 }, { run: 'a', generation: 20 }] },
      log: [
        { kind: 'milestone', run: 'c', generation: 2, pool: { replaced: { run: 'c', generation: 1 } } },
        { kind: 'milestone', run: 'a', generation: 30, pool: { replaced: null } },
      ],
    });
    // Mutation, seen red: the replaced member kept in the set (`pool.delete` removed) adds c/1.
    expect(neededKeys(dir)).toEqual(['a/10', 'a/20', 'a/30', 'b/15', 'b/5', 'c/2']);
  });

  it('refuses a needed milestone the manifest does not record', () => {
    const dir = packageWith(files, { shipped: { run: 'a', generation: 40 } });
    expect(() => neededKeys(dir)).toThrow('a/40 is needed but checkpoints.json does not record it');
  });

  it('is what a command\'s arguments name, in each form the lanes take', () => {
    const recorded = { 'a/10': 1, 'b/5': 1, 'c/1': 1 };
    expect(namedKeys(['milestone', '/x/milestones/a/10/checkpoint.bin'], recorded)).toEqual(['a/10']);
    expect(namedKeys(['init', '--members', 'a:10,b:5', '--pin', 'c:1=856'], recorded)).toEqual(['a/10', 'b/5', 'c/1']);
    expect(namedKeys(['play', '--them', 'nnue-ms:1000@8', 'd:1', 'runs/a/checkpoints/10.bin'], recorded)).toEqual([]);
  });
});

describe('fetching [Z11-103]', () => {
  const good = Buffer.from('the recorded bytes');
  const served = new Map<string, Buffer>();
  const requests: string[] = [];
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(req.url ?? '');
      const body = served.get(req.url ?? '');
      if (body === undefined) {
        res.statusCode = 404;
        res.end();
      } else res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const url = (k: string) => `${base}/${assetName(k)}`;

  it('downloads a missing checkpoint into place, and keeps one already there without asking', async () => {
    const dir = packageWith({ 'r/10': good });
    served.set('/r-10.bin', good);
    expect(await fetchCheckpoints(['r/10'], { packageDir: dir, url })).toEqual(['r/10']);
    expect(readFileSync(checkpointPath('r/10', dir))).toEqual(good);
    requests.length = 0;
    expect(await fetchCheckpoints(['r/10'], { packageDir: dir, url })).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('refuses a download that does not match, and leaves nothing behind', async () => {
    const dir = packageWith({ 'r/20': good });
    served.set('/r-20.bin', Buffer.from('other bytes, same length'.slice(0, good.length)));
    // Mutation, seen red: the hash check deleted lets the wrong bytes into place.
    await expect(fetchCheckpoints(['r/20'], { packageDir: dir, url })).rejects.toThrow('r/20: the download does not match checkpoints.json');
    expect(readdirSync(join(dir, 'milestones'))).toEqual(['checkpoints.json']);
  });

  it('refuses a checkpoint on disk that does not match, rather than replacing it', async () => {
    const dir = packageWith({ 'r/30': good });
    mkdirSync(join(dir, 'milestones', 'r', '30'), { recursive: true });
    writeFileSync(checkpointPath('r/30', dir), 'not it');
    await expect(fetchCheckpoints(['r/30'], { packageDir: dir, url })).rejects.toThrow('does not match checkpoints.json');
    expect(readFileSync(checkpointPath('r/30', dir), 'utf8')).toBe('not it');
  });

  it('names the asset the Release lacks, and a key the manifest does not record', async () => {
    const dir = packageWith({ 'r/40': good });
    await expect(fetchCheckpoints(['r/40'], { packageDir: dir, url })).rejects.toThrow('answered 404');
    await expect(fetchCheckpoints(['r/50'], { packageDir: dir, url })).rejects.toThrow('checkpoints.json does not record r/50');
  });
});

describe('recording [Z11-103]', () => {
  it('adds a milestone once, in run then numeric generation order, and refuses different bytes', () => {
    const dir = packageWith({});
    const write = (key: string, text: string) => {
      mkdirSync(join(dir, 'milestones', key), { recursive: true });
      writeFileSync(checkpointPath(key, dir), text);
    };
    write('r/100', 'hundred');
    write('r/20', 'twenty');
    write('a/5', 'five');
    expect(recordCheckpoint('r', 100, dir)).toBe(true);
    expect(recordCheckpoint('r', 20, dir)).toBe(true);
    expect(recordCheckpoint('a', 5, dir)).toBe(true);
    expect(recordCheckpoint('r', 20, dir)).toBe(false);
    expect(Object.keys(readManifest(dir).checkpoints)).toEqual(['a/5', 'r/20', 'r/100']);
    write('r/20', 'rewritten');
    expect(() => recordCheckpoint('r', 20, dir)).toThrow("r/20's checkpoint is not the one checkpoints.json records");
  });
});
