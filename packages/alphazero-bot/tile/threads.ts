/**
 * Their threaded build, run in Node.
 *
 * The build is wasm-bindgen-rayon over a shared `WebAssembly.Memory`. Their
 * glue is browser-neutral but for one file it imports, the rayon worker helper,
 * which starts Web Workers from a blob URL — neither of which Node has. So the
 * glue and the module are copied, byte for byte, into a runtime directory of
 * the cache, and beside them, at the path the glue imports, goes a helper that
 * starts `worker_threads` instead. Nothing of theirs is edited; the helper is
 * the library's, rewritten for Node.
 *
 * The page stops a threaded minimax on a clock by writing into a two-word cell
 * of the module's shared memory (`minimax_cancel_state_ptr`: generation,
 * cancel generation). The thread searching is blocked in the module, so the
 * write comes from a timer thread: {@link Canceller}.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { RAYON_HELPER, THREADED_BUILDS, type Build } from './assets.js';

/** wasm-bindgen-rayon's `startWorkers`, on `worker_threads`. */
const NODE_RAYON_HELPER = `// Written by the tile harness (packages/alphazero-bot/tile/threads.ts), not by danluu.com:
// wasm-bindgen-rayon's worker helper, on node:worker_threads instead of Web Workers.
import { Worker } from 'node:worker_threads';

const BOOT = \`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const pkg = await import(workerData.mainJS);
  pkg.initSync({ module: workerData.module, memory: workerData.memory });
  parentPort.postMessage('ready');
  pkg.wbg_rayon_start_worker(workerData.receiver);
})().catch((e) => parentPort.postMessage({ error: String((e && e.stack) || e) }));
\`;

// Held so they are not collected; unref'd so they never keep the process alive.
export const workers = [];

export async function startWorkers(module, memory, builder) {
  const n = builder.numThreads();
  if (n === 0) throw new Error('num_threads must be > 0.');
  const init = { module, memory, receiver: builder.receiver(), mainJS: builder.mainJS() };
  await Promise.all(
    Array.from({ length: n }, () =>
      new Promise((resolve, reject) => {
        const w = new Worker(BOOT, { eval: true, workerData: init });
        w.unref();
        workers.push(w);
        w.once('message', (m) => (m === 'ready' ? resolve() : reject(new Error(m.error))));
        w.once('error', reject);
      }),
    ),
  );
  builder.build();
}
`;

/** Their threaded glue and module beside the Node helper; the glue's path. */
export function prepareThreaded(cacheDir: string, build: Build): string {
  const pkg = THREADED_BUILDS[build];
  if (pkg === undefined) throw new Error(`their ${build} build has no threaded variant: use --build simd or relaxed`);
  const src = join(cacheDir, pkg);
  const glue = readFileSync(join(src, 'wasm.js'), 'utf8');
  if (!glue.includes(`from './${RAYON_HELPER}'`)) {
    throw new Error(`their ${pkg}/wasm.js no longer imports ./${RAYON_HELPER}: the Node helper needs updating`);
  }
  const dir = join(cacheDir, 'node', pkg);
  for (const f of ['wasm.js', 'wasm_bg.wasm']) {
    const to = join(dir, f);
    if (!existsSync(to) || !readFileSync(to).equals(readFileSync(join(src, f)))) {
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(src, f), to);
    }
  }
  const helper = join(dir, RAYON_HELPER);
  if (!existsSync(helper) || readFileSync(helper, 'utf8') !== NODE_RAYON_HELPER) {
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, NODE_RAYON_HELPER);
  }
  return join(dir, 'wasm.js');
}

const TIMER = `
const { workerData } = require('node:worker_threads');
const ctrl = new Int32Array(workerData.ctrl);
const cell = new Int32Array(workerData.memory, workerData.ptr, 2);
let seen = 0;
for (;;) {
  Atomics.wait(ctrl, 0, seen);
  seen = Atomics.load(ctrl, 0);
  const delay = Atomics.load(ctrl, 1);
  const armedGen = Atomics.load(ctrl, 4);
  const woke = Atomics.wait(ctrl, 3, 0, delay);
  if (woke !== 'timed-out' || Atomics.load(ctrl, 0) !== seen) continue;
  if (Atomics.compareExchange(ctrl, 2, 1, 2) !== 1) continue;
  // As the page does: the generation the search published, or, if it has not
  // published one yet, a pending cancel (-1) for the one it is about to.
  const gen = Atomics.load(cell, 0) | 0;
  Atomics.store(cell, 1, gen === 0 || gen === armedGen ? -1 : gen);
  Atomics.store(ctrl, 2, 3);
  Atomics.notify(ctrl, 2);
}
`;

/** ctrl words: arm sequence, delay ms, state (0 idle, 1 armed, 2 firing, 3 fired), disarm, armed generation. */
const SEQ = 0;
const DELAY = 1;
const STATE = 2;
const DISARM = 3;
const ARMED_GEN = 4;

/** Stops their threaded minimax after a delay, from a thread of its own. */
export class Canceller {
  private readonly ctrl = new Int32Array(new SharedArrayBuffer(4 * 5));
  private readonly cell: Int32Array;
  private readonly worker: Worker;

  constructor(memory: { buffer: ArrayBufferLike }, ptr: number) {
    if (!(memory.buffer instanceof SharedArrayBuffer)) throw new Error('their threaded module has no shared memory');
    this.cell = new Int32Array(memory.buffer, ptr, 2);
    this.worker = new Worker(TIMER, { eval: true, workerData: { ctrl: this.ctrl.buffer, memory: memory.buffer, ptr } });
    this.worker.unref();
  }

  arm(delayMs: number): void {
    const c = this.ctrl;
    Atomics.store(c, ARMED_GEN, Atomics.load(this.cell, 0));
    Atomics.store(c, DELAY, Math.max(0, Math.floor(delayMs)));
    Atomics.store(c, DISARM, 0);
    Atomics.store(c, STATE, 1);
    Atomics.add(c, SEQ, 1);
    Atomics.notify(c, SEQ);
  }

  /** After the search: stop the timer, or wait for it to finish firing and clear a pending cancel it left. */
  disarm(): void {
    const c = this.ctrl;
    if (Atomics.compareExchange(c, STATE, 1, 0) === 1) {
      Atomics.store(c, DISARM, 1);
      Atomics.notify(c, DISARM);
      return;
    }
    while (Atomics.load(c, STATE) !== 3) Atomics.wait(c, STATE, 2, 1000);
    if (Atomics.load(this.cell, 1) === -1) Atomics.store(this.cell, 1, 0);
    Atomics.store(c, STATE, 0);
  }

  close(): void {
    void this.worker.terminate();
  }
}
