/**
 * The master opponent's browser entry point ([0012 T12-12], [T12-13]): the
 * trained player of spec 0011, compiled to WebAssembly from the crate as it
 * is, and the shipped milestone's weights, all from bytes in the bundle. It
 * plays with the endgame proof at the cap `shipped.json` ships ([T12-33]).
 *
 * Imported by the master worker and nothing else in the client
 * ([0006 W6-46]): the payload is megabytes, and only a game with a `master`
 * seat should load it. The interface's main thread reads `./settings.ts`.
 */

import { fromJSON, toCanonical, type AzulJSON } from 'engine';
import { canonicalWords } from './canonical.js';
import { CHECKPOINT, CPUCT, ENDGAME_NODES, FPU, MODULE, PARITY, SHIPPED as PAYLOAD_SHIPPED } from './dist/payload.js';
import { MASTER_SIMULATIONS, validSimulations } from './settings.js';

export { MASTER_SIMULATIONS, validSimulations };

/** What `choose` answers. Plain data, structurally cloneable. */
export interface MasterChoice {
  /** Always a member of `position.legalActions`. */
  action: number;
  /** The root's backed-up value for the seat to move, in [-1, 1]. Not points. */
  value: number;
  /** Simulations run: exactly the number asked for ([0011 Z11-18]). */
  simulations: number;
}

export interface Master {
  choose(position: AzulJSON, simulations: number): MasterChoice;
  /** The module's linear memory, in bytes: it grows with a search and never shrinks ([T12-25]). */
  memoryBytes(): number;
}

/** The milestone the payload carries ([T12-9]), and its endgame node cap ([T12-33]). */
export const SHIPPED: Readonly<{
  run: string;
  generation: number;
  checkpointSha256: string;
  paritySha256: string;
  endgameNodes: number;
}> = PAYLOAD_SHIPPED;

/** The web crate's exports ([0012] *The web crate's exports*). */
interface Exports {
  memory: { buffer: ArrayBuffer };
  alloc(len: number): number;
  load(ck: number, ckLen: number, par: number, parLen: number, cpuct: number, fpu: number, endgameNodes: number): number;
  words_ptr(): number;
  choose(nWords: number, simulations: number): number;
  value(): number;
  error_ptr(): number;
  error_len(): number;
}

/**
 * The slice of the `WebAssembly` global this module uses, typed here because
 * the package compiles against Node's types and the interface against the
 * DOM's, which declare it differently.
 */
interface Wasm {
  instantiate(bytes: Uint8Array<ArrayBuffer>, imports: object): Promise<{ instance: { exports: object } }>;
}
const wasm = (globalThis as unknown as { WebAssembly: Wasm }).WebAssembly;

/** Base64 to bytes, without `Buffer`: this runs in a browser worker. */
function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The module's bytes, for the suite's check of [T12-6]. */
export function moduleBytes(): Uint8Array<ArrayBuffer> {
  return decode(MODULE);
}

function errorText(x: Exports): string {
  return new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.error_ptr(), x.error_len()));
}

function put(x: Exports, bytes: Uint8Array): number {
  const at = x.alloc(bytes.length);
  new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes);
  return at;
}

/**
 * [T12-12]: instantiates the module from the bundle's bytes — never
 * `instantiateStreaming`, which takes a network response — and loads the
 * shipped checkpoint, parity checked ([0011 Z11-13]), at the shipped endgame
 * node cap ([T12-33]). Rejects with the crate's own words when the load is
 * refused. `parity` is for the suite alone, to show a corrupted file is
 * refused; `endgameNodes` for the latency lane alone, to measure a cap before
 * it is shipped. The interface passes neither.
 */
export async function createMaster(parity: Uint8Array = decode(PARITY), endgameNodes: number = ENDGAME_NODES): Promise<Master> {
  if (!Number.isInteger(endgameNodes) || endgameNodes < 0 || endgameNodes > 1_000_000_000) {
    throw new RangeError(`endgameNodes must be a whole number in 0..=1000000000, not ${String(endgameNodes)}`);
  }
  const { instance } = await wasm.instantiate(moduleBytes(), {});
  const x = instance.exports as unknown as Exports;
  const checkpoint = decode(CHECKPOINT);
  const ck = put(x, checkpoint);
  const par = put(x, parity);
  if (x.load(ck, checkpoint.length, par, parity.length, CPUCT, FPU, endgameNodes) !== 0) {
    throw new Error(`the master's checkpoint was refused: ${errorText(x)}`);
  }
  return {
    choose(position, simulations) {
      if (!validSimulations(simulations)) {
        throw new RangeError(
          `simulations must be an integer in [${MASTER_SIMULATIONS.min}, ${MASTER_SIMULATIONS.max}], not ${String(simulations)}`,
        );
      }
      const words = canonicalWords(toCanonical(fromJSON(position, 0)));
      // A fresh view each call: a search that grows memory detaches the old one.
      new Uint32Array(x.memory.buffer, x.words_ptr(), words.length).set(words);
      const action = x.choose(words.length, simulations);
      if (action < 0) throw new Error(errorText(x));
      return { action, value: x.value(), simulations };
    },
    memoryBytes: () => x.memory.buffer.byteLength,
  };
}
