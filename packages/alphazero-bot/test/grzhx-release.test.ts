/**
 * Their release, as far as it can be checked without the cache: the pin's
 * shape ([G13-1]), their sums' format ([G13-3]), and the tripwire that no file
 * of ours is byte for byte a file of theirs ([G13-4]).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../eval/files.js';
import { REPO } from '../eval/paths.js';

/** The commit and release spec 0013's *Definitions* name: a new pin is a spec change too. */
function specPin(): { commit: string; release: string } {
  const spec = readFileSync(join(REPO, 'spec', '0013-master-against-grzhx.md'), 'utf8');
  const commit = /\| Their commit \| `([0-9a-f]{40})` \|/.exec(spec)?.[1];
  const release = /\| Their release \| `([^`]+)` \|/.exec(spec)?.[1];
  if (!commit || !release) throw new Error("spec 0013's Definitions name no commit or release");
  return { commit, release };
}
import { ASSETS, parseSums, readPin } from '../grzhx/release.js';

/** sha256 of the empty file: an empty file of ours copies nothing of theirs. */
const EMPTY = sha256(new Uint8Array());

/** Every file of ours that git does not ignore, tracked or not. */
function ourFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
  return out.split('\0').filter((p) => p !== '');
}

/** [G13-4]: the paths of ours whose bytes hash to one of `theirs`. */
export function copiesOf(theirs: Set<string>, files: { path: string; bytes: Uint8Array }[]): string[] {
  return files.filter((f) => f.bytes.length > 0 && theirs.has(sha256(f.bytes))).map((f) => f.path);
}

describe('the pin', () => {
  it('names a full commit, the release, every asset and their tree [G13-1]', () => {
    const pin = readPin();
    expect(pin.repository).toBe('grzhx/azul-alpha-zero');
    expect({ commit: pin.commit, release: pin.release }).toEqual(specPin());
    expect(Object.keys(pin.assets).sort()).toEqual([...ASSETS].sort());
    expect(Object.keys(pin.blobs).length).toBeGreaterThan(50);
    for (const h of Object.values(pin.blobs)) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.blobs['CMakeLists.txt']).toBeDefined();
  });

  it('reads their sums file [G13-3]', () => {
    const a = 'a'.repeat(64);
    const b = 'B'.repeat(64);
    const sums = parseSums(`${a}  azul-generation-2300.pt\r\n${b} *azul-generation-2300.json\n\nnot a line\n`);
    expect(sums.get('azul-generation-2300.pt')).toBe(a);
    expect(sums.get('azul-generation-2300.json')).toBe(b.toLowerCase());
    expect(sums.size).toBe(2);
  });
});

describe('nothing of theirs is in the repository [G13-4]', () => {
  const pin = readPin();
  const theirs = new Set([...Object.values(pin.blobs), ...Object.values(pin.assets)].filter((h) => h !== EMPTY));

  it('rejects a file of ours that is one of their blobs, and passes one edited by a byte', () => {
    const cmake = new TextEncoder().encode('cmake_minimum_required(VERSION 3.20)\n');
    const blob = { path: 'packages/x/CMakeLists.txt', bytes: cmake };
    // A file whose hash is in the pin is a copy; a different one is not.
    const pinned = new Set([sha256(cmake)]);
    expect(copiesOf(pinned, [blob])).toEqual(['packages/x/CMakeLists.txt']);
    expect(copiesOf(pinned, [{ path: 'y', bytes: new TextEncoder().encode('cmake_minimum_required(VERSION 3.21)\n') }])).toEqual([]);
    // An empty file copies nothing, even were the empty file pinned.
    expect(copiesOf(new Set([EMPTY]), [{ path: 'z', bytes: new Uint8Array() }])).toEqual([]);
  });

  // Mutation, seen red (CLAUDE.md), in a git copy of the repository: their
  // CMakeLists.txt, from the cache, added as packages/alphazero-bot/grzhx/CMakeLists.txt.
  it('finds no file of ours with the bytes of one of their files', () => {
    const files = ourFiles()
      .map((p) => join(REPO, p))
      .filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false; // deleted in the working tree
        }
      })
      .map((p) => ({ path: p, bytes: readFileSync(p) }));
    expect(files.length).toBeGreaterThan(100);
    expect(copiesOf(theirs, files)).toEqual([]);
  });
});
