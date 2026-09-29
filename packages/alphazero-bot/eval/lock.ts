/**
 * The package's one lock ([Z11-61]), `packages/alphazero-bot/.lock`: held by
 * the loop, by a gate started on its own, and by the latency and throughput
 * lanes, whatever run each serves. It records its holder's process ID and
 * that process's start time, and is taken over only when no process with that
 * ID *and* start time exists — so a reused ID never makes a stale lock look
 * live. The crate's commands never take it.
 */

import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { LOCK } from './paths.js';

export interface Holder {
  pid: number;
  started: string;
  what: string;
}

/** A process's start time as `ps` reports it, or `null` when there is none. */
export function processStart(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

function live(h: Holder): boolean {
  return processStart(h.pid) === h.started;
}

/**
 * Takes the lock for `what`, or throws naming the process that holds it.
 * Returns the release.
 */
export function acquire(what: string, path: string = LOCK): () => void {
  const me: Holder = { pid: process.pid, started: processStart(process.pid) ?? 'unknown', what };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, `${JSON.stringify(me)}\n`);
      closeSync(fd);
      return () => {
        try {
          const h = JSON.parse(readFileSync(path, 'utf8')) as Holder;
          if (h.pid === me.pid && h.started === me.started) unlinkSync(path);
        } catch {
          // Already gone.
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let holder: Holder | null = null;
    try {
      holder = JSON.parse(readFileSync(path, 'utf8')) as Holder;
    } catch {
      holder = null; // unreadable: a lock torn by a crash, so stale
    }
    if (holder !== null && live(holder)) {
      throw new Error(
        `${what}: the package is locked by process ${holder.pid} (${holder.what}), started ${holder.started}`,
      );
    }
    try {
      unlinkSync(path);
    } catch {
      // Someone else took it over first; the next attempt will say who.
    }
  }
  throw new Error(`${what}: could not take the lock at ${path}`);
}

/** Runs `f` holding the lock, releasing it however `f` ends. */
export async function withLock<T>(what: string, f: () => Promise<T> | T): Promise<T> {
  const release = acquire(what);
  const onSignal = (): void => {
    release();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  try {
    return await f();
  } finally {
    process.off('SIGINT', onSignal);
    release();
  }
}
