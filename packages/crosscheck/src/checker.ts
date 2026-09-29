/**
 * The driver's side of the checker's protocol [C10-12]: one child process,
 * one game message out and one reply back at a time, each a little-endian
 * word count followed by that many words.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { endianness } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameInput } from './game.js';
import { ToolError } from './game.js';
import { pushCanonical, splitRecords, toWords } from './record.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the checker is built. `CROSSCHECK_CHECKER` overrides it, which is how a
 * checker built against a mutated copy of the crate is run [C10-39].
 */
export function checkerPath(profile: 'debug' | 'release'): string {
  const fromEnv = process.env.CROSSCHECK_CHECKER;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  // `src/` in the suite, `node_modules/.crosscheck/` in the bundle: both sit
  // two levels below the package, or one.
  const pkg = HERE.includes('node_modules') ? join(HERE, '..', '..') : join(HERE, '..');
  return join(pkg, 'checker', 'target', profile, 'azul_crosscheck');
}

/** The game message of [C10-12], without its length prefix. */
export function gameMessage(game: number, input: GameInput): Uint32Array {
  const out: number[] = [game >>> 0, Math.floor(game / 0x100000000)];
  if (input.start === null) out.push(0);
  else {
    out.push(1);
    pushCanonical(out, input.start);
  }
  out.push(input.shuffles.length);
  for (const s of input.shuffles) out.push(s.length, ...s);
  out.push(input.actions.length, ...input.actions);
  out.push(input.probes.length, ...input.probes);
  return toWords(out);
}

export class Checker {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private stderr = '';
  private waiting: { resolve: (w: Uint32Array) => void; reject: (e: Error) => void } | null = null;
  private dead: Error | null = null;

  constructor(path: string) {
    if (endianness() !== 'LE') throw new ToolError('the wire is little-endian, and so must the host be');
    this.child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.deliver();
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    const fail = (why: string): void => {
      this.dead ??= new ToolError(`the checker ${why}${this.stderr ? `: ${this.stderr.trim()}` : ''}`);
      this.waiting?.reject(this.dead);
      this.waiting = null;
    };
    this.child.on('error', (e) => fail(`could not run (${path}): ${e.message}`));
    this.child.on('exit', (code, signal) => fail(`exited (${signal ?? code})`));
    this.child.stdin.on('error', () => {});
  }

  private deliver(): void {
    if (this.waiting === null || this.buffer.length < 4) return;
    const n = this.buffer.readUInt32LE(0);
    if (this.buffer.length < 4 + 4 * n) return;
    const words = new Uint32Array(n);
    for (let i = 0; i < n; i++) words[i] = this.buffer.readUInt32LE(4 + 4 * i);
    this.buffer = this.buffer.subarray(4 + 4 * n);
    const { resolve } = this.waiting;
    this.waiting = null;
    resolve(words);
  }

  /** Sends raw words as one message and waits for the reply's words. */
  ask(words: Uint32Array): Promise<Uint32Array> {
    if (this.dead !== null) return Promise.reject(this.dead);
    if (this.waiting !== null) return Promise.reject(new ToolError('one message at a time'));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      const frame = Buffer.alloc(4 + 4 * words.length);
      frame.writeUInt32LE(words.length, 0);
      for (let i = 0; i < words.length; i++) frame.writeUInt32LE(words[i], 4 + 4 * i);
      this.child.stdin.write(frame);
      this.deliver();
    });
  }

  /** The crate's records for a game input, record `0` first. */
  async replay(game: number, input: GameInput): Promise<Uint32Array[]> {
    const reply = await this.ask(gameMessage(game, input));
    if (reply.length === 0) throw new ToolError('the checker sent an empty reply');
    return splitRecords(reply.subarray(1), reply[0]);
  }

  /** Ends the checker's input and waits for it to exit. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      this.child.once('exit', () => resolve());
      this.child.stdin.end();
    });
  }
}
