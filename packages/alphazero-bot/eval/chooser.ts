/**
 * The chooser adapter ([Z11-31]): the trained player as the arena sees it.
 *
 * One `alphazero serve` per chooser, and so per player per game, handed each
 * move's `toCanonical(fromJSON(position, 0))` and nothing else — `toJSON`'s
 * bag is counts, so the order the harness holds never reaches the process,
 * and seed 0 is a shuffler nothing below the round boundary ever calls
 * ([Z11-15]). The process keeps only its memo between moves, which changes
 * no answer: each is the one `alphazero play` gives that position alone
 * ([Z11-72]), so a game's result does not depend on which process played it.
 *
 * This file is in the ladder hash ([Z11-63]): it decides how the player plays
 * in every milestone and gate.
 */

import { fromJSON, toCanonical, type AzulJSON, type CanonicalState } from 'engine';
import type { Chooser } from 'bot/arena';
import { Worker } from 'node:worker_threads';

/** [0010 C10-8]'s canonical block, in [0001 E1-62]'s field order. */
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

/** What `play` answers ([Z11-23]). */
export interface Answer {
  action: number;
  simulations: number;
  value: number;
  milliseconds: number;
}

export function readAnswer(bytes: Uint8Array): Answer {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength !== 20 || v.getUint32(0, true) !== 4) {
    throw new Error(`play answered ${bytes.byteLength} bytes, not four words`);
  }
  return {
    action: v.getUint32(4, true),
    simulations: v.getUint32(8, true),
    value: v.getFloat32(12, true),
    milliseconds: v.getUint32(16, true),
  };
}

export interface PlayerSpec {
  binary: string;
  checkpoint: string;
  /** The config file the crate reads its settings from ([Z11-60]). */
  config: string;
  search: 'play' | 'milestone';
  /**
   * How long one move may take before the process is given up on: a process
   * that never answers must not stop a milestone for ever. Ten minutes unless
   * set; the slowest search any lane runs takes seconds.
   */
  answerMilliseconds?: number;
}

/** A chooser holding a process, to be closed when its game is over. */
export type ClosingChooser = Chooser & { close(): void };

/**
 * The player as a chooser. Its work is `nodes = simulations`, `depth = 0`,
 * neither complete nor curtailed: the search is not depth-bounded and has no
 * clock to be curtailed by ([Z11-18]). Every move's simulation count is
 * handed to `onMove`, which is how a milestone records them ([Z11-34]).
 *
 * The process starts at the first move and ends at `close`, or with this
 * one if `close` is never called.
 */
export function alphazeroChooser(spec: PlayerSpec, onMove?: (a: Answer) => void): ClosingChooser {
  let server: Server | null = null;
  const choose = (position: AzulJSON) => {
    const words = canonicalWords(toCanonical(fromJSON(position, 0)));
    server ??= new Server(
      spec.binary,
      ['serve', spec.checkpoint, '--config', spec.config, '--search', spec.search],
      spec.answerMilliseconds ?? 10 * 60 * 1000,
    );
    const answer = readAnswer(server.ask(frame(words)));
    onMove?.(answer);
    return { action: answer.action, nodes: answer.simulations, depth: 0, complete: false, curtailed: false };
  };
  return Object.assign(choose, {
    close: () => {
      server?.close();
      server = null;
    },
  });
}

/** The answer's size: four words and their count ([Z11-23]). */
const ANSWER_BYTES = 20;

/** Room for an answer, or for the process's error message, cut to fit. */
const DATA_BYTES = 1 << 16;

/** `state`: the worker has not answered yet. */
const PENDING = 0;
/** `state`: `data` holds the answer. */
const ANSWERED = 1;
/** `state`: `data` holds why there is none. */
const FAILED = 2;

/**
 * One `alphazero serve`, asked synchronously. The arena's choosers are plain
 * functions, but a process that outlives one call can only be read
 * asynchronously; so a worker thread owns it, and the caller blocks on
 * `Atomics.wait` until the worker has put the answer, or the reason there is
 * none — the process ended, or could not start — in shared memory. A failure
 * throws, as `alphazero` does for a one-shot command; nothing waits forever
 * on a process that is gone.
 */
class Server {
  private readonly control: Int32Array;
  private readonly data: Uint8Array;
  private readonly worker: Worker;
  private broken: string | null = null;

  constructor(
    bin: string,
    args: string[],
    private readonly timeout: number,
  ) {
    const shared = new SharedArrayBuffer(8 + DATA_BYTES);
    this.control = new Int32Array(shared, 0, 2);
    this.data = new Uint8Array(shared, 8);
    this.worker = new Worker(WORKER, { eval: true, workerData: { bin, args, shared } });
    // The worker never keeps the process alive: when it goes, the server's
    // stdin closes and it ends on its own.
    this.worker.unref();
  }

  ask(message: Uint8Array): Uint8Array {
    if (this.broken !== null) throw new Error(this.broken);
    Atomics.store(this.control, 0, PENDING);
    this.worker.postMessage(message);
    if (Atomics.wait(this.control, 0, PENDING, this.timeout) === 'timed-out') {
      // Ending the worker closes the process's stdin, and so the process.
      void this.worker.terminate();
      this.broken = `alphazero serve gave no answer in ${this.timeout} ms`;
      throw new Error(this.broken);
    }
    const length = this.control[1];
    const bytes = this.data.slice(0, length);
    if (Atomics.load(this.control, 0) === FAILED) throw new Error(new TextDecoder().decode(bytes));
    return bytes;
  }

  close(): void {
    if (this.broken === null) this.worker.postMessage(null);
  }
}

/** The worker's side, run as a CommonJS script of its own. */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { bin, args, shared } = workerData;
const control = new Int32Array(shared, 0, 2);
const data = new Uint8Array(shared, 8);
let child = null;
let stderr = '';
let pending = Buffer.alloc(0);
let waiting = false;
let failure = null;
let closing = false;

function settle(state, bytes) {
  const n = Math.min(bytes.length, ${DATA_BYTES});
  data.set(bytes.subarray(0, n));
  control[1] = n;
  Atomics.store(control, 0, state);
  Atomics.notify(control, 0);
}

function fail(why) {
  failure ??= why;
  if (waiting) {
    waiting = false;
    settle(${FAILED}, Buffer.from(failure));
  }
}

function start() {
  child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    pending = Buffer.concat([pending, d]);
    if (waiting && pending.length >= ${ANSWER_BYTES}) {
      const answer = pending.subarray(0, ${ANSWER_BYTES});
      pending = pending.subarray(${ANSWER_BYTES});
      waiting = false;
      settle(${ANSWERED}, answer);
    }
  });
  child.stdin.on('error', () => {});
  child.on('error', (e) => fail('alphazero ' + args[0] + ' could not start: ' + e.message));
  child.on('close', (code) => {
    fail('alphazero ' + args[0] + ' exited ' + code + ': ' + stderr.trim());
    // Until \`close\`, a process that has gone still answers every later
    // move, with why it went.
    if (closing) parentPort.close();
  });
}

parentPort.on('message', (m) => {
  try {
    if (m === null) {
      closing = true;
      if (child === null || failure !== null) parentPort.close();
      else child.stdin.end();
      return;
    }
    if (child === null) start();
    waiting = true;
    if (failure !== null) return fail(failure);
    child.stdin.write(m);
  } catch (e) {
    fail(String(e));
  }
});
`;
