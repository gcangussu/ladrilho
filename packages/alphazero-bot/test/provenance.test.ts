/**
 * Provenance ([Z11-63]): the ladder hash on a hand-built directory, what
 * changes it, and what marks a build dirty ([Z11-45]).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_PATHS, dirty, hashFiles, ladderHash, ladderPaths } from '../eval/provenance.js';

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ladder-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const LADDER: Record<string, string> = {
  'packages/bot/src/search.ts': 'deep',
  'packages/bot/src/nested/tiers.ts': 'sharp',
  'packages/engine/src/apply.ts': 'rules',
  'packages/bot/arena/chooser.ts': 'c',
  'packages/bot/arena/match.ts': 'm',
  'packages/bot/arena/seeds.ts': 's',
  'packages/bot/arena/index.ts': 'i',
  'packages/alphazero-bot/eval/chooser.ts': 'adapter',
};

describe('the ladder hash [Z11-63]', () => {
  it('is the sha256 of path, NUL, length, NUL, contents, in byte order of path', () => {
    const root = tree({ ...LADDER, 'packages/bot/arena/audit-corpus.json': 'left out' });
    const paths = ladderPaths(root);
    expect([...paths].sort()).toEqual(Object.keys(LADDER).sort());
    const h = createHash('sha256');
    for (const p of Object.keys(LADDER).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      h.update(`${p}\0${Buffer.byteLength(LADDER[p])}\0${LADDER[p]}`);
    }
    expect(ladderHash(root)).toBe(h.digest('hex'));
    expect(ladderHash(root)).toBe('6ce2d02831ddf92ad2befda116c3440b511bdda347996167c74865a3bbd44f49');
  });

  it('orders paths by bytes, not by locale', () => {
    const root = tree({ 'a/B': 'x', 'a/a': 'y' });
    const both = (order: string[]) => {
      const h = createHash('sha256');
      for (const p of order) h.update(`${p}\0${1}\0${p === 'a/B' ? 'x' : 'y'}`);
      return h.digest('hex');
    };
    expect(hashFiles(root, ['a/a', 'a/B'])).toBe(both(['a/B', 'a/a']));
  });

  it('changes when one byte of any hashed file changes, and not for the audit corpus', () => {
    const base = ladderHash(tree(LADDER));
    for (const p of Object.keys(LADDER)) {
      const changed = { ...LADDER, [p]: `${LADDER[p].slice(0, -1)}!` };
      expect(ladderHash(tree(changed)), p).not.toBe(base);
    }
    const extra = { ...LADDER, 'packages/engine/src/new.ts': '' };
    expect(ladderHash(tree(extra))).not.toBe(base);
    expect(ladderHash(tree({ ...LADDER, 'packages/bot/arena/audit.ts': 'x' }))).toBe(base);
  });
});

describe('the dirty flag [Z11-63]', () => {
  function repo(): string {
    const files: Record<string, string> = { ...LADDER };
    for (const p of SOURCE_PATHS) if (!(p in files) && !p.includes('.')) files[`${p}/x`] = 'x';
    for (const p of SOURCE_PATHS) if (p.endsWith('.toml') || p.endsWith('.lock')) files[p] = 'x';
    const root = tree(files);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
    return root;
  }

  it("is clear for the loop's own outputs, and set by a change to any source path", () => {
    const root = repo();
    expect(dirty(root)).toBe(false);
    for (const out of ['milestones/log.json', 'milestones/r/10/checkpoint.bin', 'gate/r/10.json', 'latency/r.json', 'runs/r/config.json']) {
      const p = join(root, 'packages/alphazero-bot', out);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, 'written by the loop');
    }
    expect(dirty(root)).toBe(false);
    for (const p of ['packages/alphazero-bot/src/x', 'packages/engine-rs/Cargo.lock', 'packages/bot/arena/match.ts']) {
      const r = repo();
      writeFileSync(join(r, p), 'changed');
      expect(dirty(r), p).toBe(true);
    }
    const r = repo();
    writeFileSync(join(r, 'packages/alphazero-bot/train/new.py'), 'untracked');
    expect(dirty(r)).toBe(true);
  });
});
