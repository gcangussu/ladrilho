/**
 * The two processes a game talks to: the host, which holds their player and
 * the lockstep game ([G13-8] to [G13-13]), and our `alphazero serve`
 * ([G13-16], [G13-27], [G13-29]). Both answer one request at a time; a
 * request unanswered for its timeout ends the process with an error naming it
 * ([G13-38]).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fromJSON, toCanonical, type AzulJSON, type CanonicalState } from 'engine';
import { VENV_SH } from './build.js';
import { HERE } from './release.js';
import { join } from 'node:path';

/** Reads whole chunks from a stream as they come. */
class Reader {
  private chunks: Buffer[] = [];
  private length = 0;
  private waiting: (() => void) | null = null;
  ended = false;
  stderr = '';

  /** A spawn failure, or a write to a process that has died: the next read fails with it. */
  failure: Error | null = null;

  constructor(child: ChildProcess) {
    const fail = (e: Error): void => {
      this.failure ??= e;
      this.waiting?.();
    };
    child.on('error', fail);
    child.stdin!.on('error', fail);
    child.on('exit', () => {
      this.ended = true;
      this.waiting?.();
    });
    child.stdout!.on('data', (b: Buffer) => {
      this.chunks.push(b);
      this.length += b.length;
      this.waiting?.();
    });
    child.stdout!.on('end', () => {
      this.ended = true;
      this.waiting?.();
    });
    child.stderr!.on('data', (b: Buffer) => {
      this.stderr = (this.stderr + b.toString()).slice(-8192);
    });
  }

  private take(n: number): Buffer {
    const all = Buffer.concat(this.chunks);
    this.chunks = [all.subarray(n)];
    this.length = all.length - n;
    return all.subarray(0, n);
  }

  peek(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Waits until `ready` says how many bytes make a message, and takes them. */
  async read(ready: (b: Buffer) => number | null, timeoutMs: number, what: string): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const n = ready(this.peek());
      if (n !== null) return this.take(n);
      if (this.failure !== null) throw new Error(`${what}: ${this.failure.message}\n${this.stderr.trim()}`);
      if (this.ended) throw new Error(`${what}: the process ended without answering\n${this.stderr.trim()}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${what}: no answer in ${Math.round(timeoutMs / 1000)} s`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiting = () => {
          clearTimeout(t);
          this.waiting = null;
          resolve();
        };
      });
    }
  }
}

export interface HostPaths {
  repo: string;
  library: string;
  actor: string;
  actorSha256: string;
}

/** The host: line-delimited JSON, one request then one answer ([G13-10]). */
export class Host {
  private readonly child: ChildProcess;
  private readonly reader: Reader;

  constructor(paths: HostPaths) {
    this.child = spawn('bash', [
      VENV_SH, join(HERE, 'host', 'host.py'),
      '--repo', paths.repo, '--library', paths.library, '--actor', paths.actor, '--actor-sha256', paths.actorSha256,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.reader = new Reader(this.child);
  }

  async ask<T = Record<string, unknown>>(request: Record<string, unknown>, timeoutMs: number, what: string): Promise<T> {
    this.child.stdin!.write(`${JSON.stringify(request)}\n`);
    const line = await this.reader.read((b) => {
      const i = b.indexOf(10);
      return i < 0 ? null : i + 1;
    }, timeoutMs, what);
    return JSON.parse(line.toString('utf8')) as T;
  }

  get stderr(): string {
    return this.reader.stderr;
  }

  close(): void {
    this.child.stdin!.end();
    this.child.kill();
  }
}

/** [0010 C10-8]'s canonical block, in [0001 E1-62]'s field order: the words `serve` reads ([0011 Z11-23]). */
export function canonicalWords(c: CanonicalState): number[] {
  const b = (x: boolean): number => (x ? 1 : 0);
  const out: number[] = [];
  for (const f of c.factories) out.push(...f);
  out.push(...c.center, b(c.markerInCenter), c.bag.length, ...c.bag, ...c.lid);
  for (const w of c.walls) out.push(...w);
  for (const p of c.plColor) out.push(...p);
  for (const p of c.plCount) out.push(...p);
  for (const p of c.floor) out.push(...p);
  out.push(b(c.floorMarker[0]), b(c.floorMarker[1]), c.scores[0], c.scores[1]);
  out.push(c.currentPlayer, c.firstPlayer, c.roundIndex, c.tilesLeft, c.shufflesUsed);
  out.push(b(c.isTerminal), b(c.exhausted));
  return out;
}

/** [0010 C10-12]'s framing: the word count, then the words, little-endian. */
export function frame(words: readonly number[]): Uint8Array {
  const out = new DataView(new ArrayBuffer(4 * (words.length + 1)));
  out.setUint32(0, words.length, true);
  words.forEach((w, i) => out.setUint32(4 * (i + 1), w >>> 0, true));
  return new Uint8Array(out.buffer);
}

/**
 * [G13-16]: the bytes `serve` is handed for a position — the canonical block of
 * the state rebuilt from `toJSON`'s counts on seed 0, so neither the bag's
 * order nor the shuffler's seed can reach it.
 */
export function framedPosition(position: AzulJSON): Uint8Array {
  return frame(canonicalWords(toCanonical(fromJSON(position, 0))));
}

export interface OurAnswer {
  action: number;
  simulations: number;
  value: number;
  searchMs: number;
  proofMs: number;
}

/** `serve --split-ms`'s five words ([0011 Z11-79]). */
export function readSplitAnswer(b: Buffer): OurAnswer {
  if (b.length !== 24 || b.readUInt32LE(0) !== 5) throw new Error(`serve answered ${b.length} bytes, not five words`);
  return {
    action: b.readUInt32LE(4),
    simulations: b.readUInt32LE(8),
    value: b.readFloatLE(12),
    searchMs: b.readUInt32LE(16),
    proofMs: b.readUInt32LE(20),
  };
}

/** Our player: one `serve --split-ms` for one game, with a clock or without. */
export class Serve {
  private readonly child: ChildProcess;
  private readonly reader: Reader;

  constructor(binary: string, checkpoint: string, config: string, clockMs: number | null) {
    const args = ['serve', checkpoint, '--config', config, '--search', 'play', '--split-ms'];
    if (clockMs !== null) args.push('--clock-ms', String(clockMs));
    this.child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.reader = new Reader(this.child);
  }

  async choose(position: AzulJSON, timeoutMs: number, what: string): Promise<OurAnswer> {
    this.child.stdin!.write(framedPosition(position));
    const b = await this.reader.read((x) => (x.length >= 24 ? 24 : null), timeoutMs, what);
    return readSplitAnswer(b);
  }

  close(): void {
    this.child.stdin!.end();
    this.child.kill();
  }
}
