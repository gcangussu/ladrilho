/**
 * Their player, run from the cached WASM in this thread.
 *
 * - `nnue` is the page's default opponent: alpha-beta minimax over the NNUE
 *   value net. The page stops it on a clock; here it stops on a node budget —
 *   what the page itself falls back to without shared memory — so a game is
 *   repeatable. `nnue-ms` keeps the clock.
 * - `mcts` is the page's alternate opponent ("PJF98-like model with mcts"):
 *   PUCT over the policy+value checkpoint, the most-visited root action
 *   played. Its tree is kept between moves, as the page keeps it, so the
 *   budget is the root's visit total, what was reused included.
 *
 * `@<threads>` runs the page's threaded mode, on its threaded build
 * (`threads.ts`): LazySMP minimax and shared-tree MCTS. The minimax's node
 * budget caps its main thread, and the helper threads search beside it until
 * it stops, so `nnue:N@T` does roughly T times the work of `nnue:N` (measured:
 * 5-6.5 CPU-seconds per second on 8 threads, the same `nodes` reported); the
 * nodes it reports are the main thread's. With three threads or more the endgame solver
 * can run, which it never does single-threaded:
 *
 * - shared-tree MCTS runs it inside the search, at 4096 simulations or more;
 * - minimax, from round 5, probes it first and plays its move when it proves
 *   one, minimax otherwise — the page's own tail-probe branch. (The page's
 *   default threaded path races the solver against minimax on at most two
 *   threads, and the solver refuses fewer than three, so there it only
 *   contributes what the page solved ahead while its opponent was thinking.
 *   `tail: false` leaves the probe out.)
 *
 * Threaded searches are not repeatable: the threads race.
 *
 * One `AzulSearch` per game, as the page keeps one per game: minimax reuses
 * its transposition table and MCTS its tree between moves, so a search object
 * carried across games would make a game depend on the ones before it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { legalActions, type AzulState } from 'engine';
import { BUILDS, loadSettings, type Build, type TheirSettings } from './assets.js';
import { actionFromTheirs, toTheirs } from './convert.js';
import { Canceller, prepareThreaded } from './threads.js';

export type TheirSpec = (
  | { kind: 'nnue'; nodes: number }
  | { kind: 'nnue-ms'; ms: number }
  | { kind: 'mcts'; sims: number }
) & { threads: number };

export function parseTheirSpec(s: string): TheirSpec {
  const m = /^(nnue|nnue-ms|mcts):(\d+)(?:@(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`"${s}" is not nnue:<nodes>, nnue-ms:<milliseconds> or mcts:<simulations>, with an optional @<threads>`);
  const n = Number(m[2]);
  const threads = m[3] === undefined ? 1 : Number(m[3]);
  if (!(n >= 1)) throw new Error(`"${s}": the budget must be at least 1`);
  if (!(threads >= 1 && threads <= 64)) throw new Error(`"${s}": threads must be in 1..64`);
  if (m[1] === 'nnue') return { kind: 'nnue', nodes: n, threads };
  if (m[1] === 'mcts') return { kind: 'mcts', sims: n, threads };
  return { kind: 'nnue-ms', ms: n, threads };
}

export function specLabel(s: TheirSpec): string {
  const base = s.kind === 'nnue' ? `nnue:${s.nodes}` : s.kind === 'mcts' ? `mcts:${s.sims}` : `nnue-ms:${s.ms}`;
  return s.threads > 1 ? `${base}@${s.threads}` : base;
}

/** The page's tail-probe limits: its node cap, and the margin it leaves on a clock. */
const TAIL_MAX_NODES = 2_000_000;
const TAIL_CLOCK_MARGIN_MS = 120;
/** The MCTS solver's own threshold, from its skip reason: below it the solver is not tried. */
export const MCTS_SOLVER_MIN_SIMS = 4096;

export interface TheirOptions {
  /** Probe the endgame solver before minimax from round 5, at three threads or more. */
  tail: boolean;
  /** The probe's time limit on a node budget; on a clock it is the clock less the page's margin. */
  tailMs: number;
}

/** The parts of their wasm-bindgen module this uses. */
interface TheirModule {
  initSync(arg: { module: Uint8Array }): { memory: { buffer: ArrayBufferLike } };
  init_threads?(n: number): Promise<unknown>;
  minimax_cancel_state_ptr?(): number;
  AzulEngine: new () => TheirEngine;
  AzulSearch: new () => TheirSearch;
}
export interface TheirEngine {
  new_game(seed: bigint, firstPlayer: string, human: string): TheirUi;
  set_state(game: unknown, human: string): TheirUi;
  get_state(): TheirUi;
  game_bytes(): Uint8Array;
  play_action_id(id: number): TheirUi;
  game_outcome_code(): number;
  free(): void;
}
export interface TheirUi {
  game: Record<string, unknown>;
  legal: { id: number }[];
}
interface Root {
  actions: number[];
  visits: number[];
  value_sum: number[];
  solver_complete?: boolean;
  tail_solver_reason?: string;
}
interface MinimaxRoot {
  best_action: number;
  best_value: number;
  nodes: number;
}
interface TheirSearch {
  set_minimax_pruning_overrides(spec: string): void;
  set_minimax_tt_use_zobrist(on: boolean): void;
  set_minimax_threaded_shared_tt_racy_verify?(on: boolean): void;
  set_minimax_cancel_poll_every(n: number): void;
  set_shared_tree_batched_eval_enabled?(on: boolean): void;
  set_shared_tree_virtual_visits_enabled?(on: boolean): void;
  load_ckpt_bytes(b: Uint8Array): void;
  load_nnue_bytes(b: Uint8Array): void;
  use_ckpt_model(): void;
  use_nnue_model(): void;
  minimax_root_bytes(
    state: Uint8Array,
    nodes: number,
    seed: bigint,
    scoreValueWeight: number,
    terminalScoreValueWeight: number,
    scoreValueScale: number,
    maxTimeMs: number,
  ): MinimaxRoot;
  minimax_root_threaded_bytes(
    state: Uint8Array,
    nodes: number,
    seed: bigint,
    threads: number,
    scoreValueWeight: number,
    terminalScoreValueWeight: number,
    scoreValueScale: number,
  ): MinimaxRoot;
  tail_solve_root_shared_tree_limited_bytes(
    state: Uint8Array,
    threads: number,
    seed: bigint,
    tailScoreValueWeight: number,
    scoreValueScale: number,
    timeoutMs: number,
    maxNodes: number,
  ): { root?: Root; reason?: string };
  search_root_bytes(
    state: Uint8Array,
    sims: number,
    cPuct: number,
    fpu: number,
    forcedPlayouts: boolean,
    cpuctStdevPrior: number,
    cpuctStdevPriorWeight: number,
    cpuctStdevScale: number,
    scoreValueWeight: number,
    scoreValueScale: number,
    seed: bigint,
    tailScoreValueWeight: number,
    tailSolverEnabled: boolean,
  ): Root;
  search_root_shared_tree_bytes(
    state: Uint8Array,
    sims: number,
    threads: number,
    cPuct: number,
    fpu: number,
    forcedPlayouts: boolean,
    cpuctStdevPrior: number,
    cpuctStdevPriorWeight: number,
    cpuctStdevScale: number,
    scoreValueWeight: number,
    scoreValueScale: number,
    seed: bigint,
    tailScoreValueWeight: number,
    tailSolverEnabled: boolean,
  ): Root;
  free(): void;
}

/** Their modules, the networks and the settings, loaded once per thread. */
export interface Theirs {
  mod: TheirModule;
  /** The threaded build, its pool started, when any budget asks for threads. */
  threaded: { mod: TheirModule; canceller: Canceller; threads: number } | null;
  ckpt: Uint8Array;
  nnue: Uint8Array;
  settings: TheirSettings;
  options: TheirOptions;
}

export async function loadTheirs(cacheDir: string, build: Build, threads: number, options: TheirOptions): Promise<Theirs> {
  const dir = join(cacheDir, BUILDS[build]);
  const mod = (await import(pathToFileURL(join(dir, 'wasm.js')).href)) as TheirModule;
  mod.initSync({ module: readFileSync(join(dir, 'wasm_bg.wasm')) });
  let threaded: Theirs['threaded'] = null;
  if (threads > 1) {
    const glue = prepareThreaded(cacheDir, build);
    const tmod = (await import(pathToFileURL(glue).href)) as TheirModule;
    const exports = tmod.initSync({ module: readFileSync(join(glue, '..', 'wasm_bg.wasm')) });
    if (tmod.init_threads === undefined || tmod.minimax_cancel_state_ptr === undefined) {
      throw new Error('their threaded build no longer exports init_threads and minimax_cancel_state_ptr');
    }
    // A rayon pool is started once per module instance; every search takes its own count up to it.
    await tmod.init_threads(threads);
    threaded = { mod: tmod, canceller: new Canceller(exports.memory, tmod.minimax_cancel_state_ptr()), threads };
  }
  return {
    mod,
    threaded,
    ckpt: readFileSync(join(cacheDir, 'model.safetensors')),
    nnue: readFileSync(join(cacheDir, 'nnue.nnue')),
    settings: loadSettings(cacheDir),
    options,
  };
}

export interface TheirMove {
  action: number;
  /** Minimax nodes searched, or MCTS root visits; 0 for a forced move or a solved one. */
  work: number;
  ms: number;
  /** The endgame solver proved this move. */
  solved: boolean;
}

function mostVisited(root: Root): number {
  let best = 0;
  for (let i = 1; i < root.actions.length; i++) if (root.visits[i] > root.visits[best]) best = i;
  return root.actions[best];
}

/** Their player for one game. */
export class TheirPlayer {
  private readonly search: TheirSearch;
  private readonly engine: TheirEngine;
  private readonly threads: number;
  private ply = 0;

  constructor(
    private readonly t: Theirs,
    private readonly spec: TheirSpec,
    private readonly seed: number,
  ) {
    this.threads = spec.threads;
    let mod = t.mod;
    if (spec.threads > 1) {
      if (t.threaded === null || t.threaded.threads < spec.threads) throw new Error(`no thread pool for ${specLabel(spec)}`);
      mod = t.threaded.mod;
    }
    const s = new mod.AzulSearch();
    s.set_minimax_pruning_overrides(t.settings.pruning);
    s.set_minimax_tt_use_zobrist(true);
    if (spec.threads > 1) {
      // The page's worker settings for its threaded mode.
      s.set_minimax_threaded_shared_tt_racy_verify?.(true);
      s.set_shared_tree_batched_eval_enabled?.(false);
      s.set_shared_tree_virtual_visits_enabled?.(true);
    }
    if (spec.kind === 'mcts') {
      s.load_ckpt_bytes(t.ckpt);
      s.use_ckpt_model();
    } else {
      s.load_nnue_bytes(t.nnue);
      s.use_nnue_model();
    }
    this.search = s;
    this.engine = new mod.AzulEngine();
  }

  choose(state: AzulState): TheirMove {
    const ply = this.ply++;
    const legal = legalActions(state);
    // Their page plays a forced move without searching.
    if (legal.length === 1) return { action: legal[0], work: 0, ms: 0, solved: false };
    this.engine.set_state(toTheirs(state, this.seed), 'P0');
    const bytes = this.engine.game_bytes();
    // A different search seed every ply of every game, and the same ones on a rerun.
    const seed = BigInt.asUintN(64, (BigInt(this.seed) << 20n) ^ BigInt(ply) ^ 0x9e3779b97f4a7c15n);
    const started = performance.now();
    const m = this.spec.kind === 'mcts' ? this.mcts(bytes, seed, this.spec.sims) : this.minimax(bytes, seed, state.roundIndex + 1, started);
    const ms = performance.now() - started;
    const action = actionFromTheirs(m.id);
    if (!legal.includes(action)) throw new Error(`their player chose ${m.id}, which is not legal here`);
    return { action, work: m.work, ms, solved: m.solved };
  }

  private mcts(bytes: Uint8Array, seed: bigint, sims: number): { id: number; work: number; solved: boolean } {
    const st = this.t.settings;
    const s = this.search;
    // The page's tail weight: score-aware solving only with the threads to run it.
    const root =
      this.threads > 1
        ? s.search_root_shared_tree_bytes(
            bytes, sims, this.threads, st.cPuct, st.fpu, false, st.cpuctStdevPrior, st.cpuctStdevPriorWeight,
            st.cpuctStdevScale, st.mctsScoreValueWeight, st.scoreValueScale, seed,
            this.threads >= 3 ? st.mctsScoreValueWeight : 0.0, true,
          )
        : s.search_root_bytes(
            bytes, sims, st.cPuct, st.fpu, false, st.cpuctStdevPrior, st.cpuctStdevPriorWeight,
            st.cpuctStdevScale, st.mctsScoreValueWeight, st.scoreValueScale, seed, 0.0, true,
          );
    const solved = root.solver_complete === true;
    return { id: mostVisited(root), work: solved ? 0 : root.visits.reduce((a, b) => a + b, 0), solved };
  }

  private minimax(bytes: Uint8Array, seed: bigint, round: number, started: number): { id: number; work: number; solved: boolean } {
    const st = this.t.settings;
    const s = this.search;
    const clock = this.spec.kind === 'nnue-ms' ? this.spec.ms : null;
    if (this.threads >= 3 && this.t.options.tail && round >= 5) {
      // The page probes only when the clock is at least a second (below it is its "easy mode").
      const timeout = clock === null ? this.t.options.tailMs : clock >= 1000 ? clock - TAIL_CLOCK_MARGIN_MS : 0;
      if (timeout > 0) {
        // The page's tail weight on this path: the MCTS player's score weight.
        const res = s.tail_solve_root_shared_tree_limited_bytes(
          bytes, this.threads, seed, st.mctsScoreValueWeight, st.scoreValueScale, timeout, TAIL_MAX_NODES,
        );
        if (res.root?.solver_complete === true) return { id: mostVisited(res.root), work: 0, solved: true };
      }
    }
    const nodes = this.spec.kind === 'nnue' ? this.spec.nodes : 0xffff_ffff;
    let root: MinimaxRoot;
    if (this.threads > 1) {
      const canceller = this.t.threaded!.canceller;
      if (clock !== null) {
        s.set_minimax_cancel_poll_every(clock <= 1 ? 64 : 4096);
        // The page fires its cancel this far ahead of the deadline.
        const safety = Math.min(60, Math.max(2, Math.floor(clock * 0.25)));
        canceller.arm(Math.max(0, clock - (performance.now() - started) - safety));
      }
      try {
        root = s.minimax_root_threaded_bytes(
          bytes, nodes, seed, this.threads, st.minimaxScoreValueWeight, st.minimaxTerminalScoreValueWeight, st.scoreValueScale,
        );
      } finally {
        if (clock !== null) canceller.disarm();
      }
    } else {
      const maxMs = clock === null ? 0 : Math.max(1, Math.floor(clock - (performance.now() - started)));
      root = s.minimax_root_bytes(
        bytes, nodes, seed, st.minimaxScoreValueWeight, st.minimaxTerminalScoreValueWeight, st.scoreValueScale, maxMs,
      );
    }
    return { id: root.best_action, work: root.nodes, solved: false };
  }

  free(): void {
    this.search.free();
    this.engine.free();
  }
}
