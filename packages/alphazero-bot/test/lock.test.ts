/** The package's lock ([Z11-61]), as [Z11-45] asks. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquire, processStart } from '../eval/lock.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'lock-')), '.lock');

describe('the lock [Z11-61]', () => {
  it('refuses a second entry point while one holds it, naming the holder', () => {
    const path = fresh();
    const release = acquire('train --run a', path);
    expect(() => acquire('gate a/10', path)).toThrow(new RegExp(`process ${process.pid} \\(train --run a\\)`));
    release();
    expect(existsSync(path)).toBe(false);
    acquire('gate a/10', path)();
  });

  it('is taken over from a process that no longer exists', () => {
    const path = fresh();
    const gone = spawnSync('true').pid!;
    expect(processStart(gone)).toBeNull();
    writeFileSync(path, JSON.stringify({ pid: gone, started: 'Tue Sep 29 12:00:00 2026', what: 'latency --run a' }));
    acquire('throughput --run a', path)();
  });

  it('is taken over from a live process ID with another start time', () => {
    const path = fresh();
    expect(processStart(process.pid)).not.toBeNull();
    writeFileSync(path, JSON.stringify({ pid: process.pid, started: 'Thu Jan  1 00:00:00 1970', what: 'an old loop' }));
    acquire('train --run b', path)();
  });
});
