---
title: Master opponent
author: Gabriel Cangussu
date: 2026-10-02
status: implemented
intent: 0010 — Playing the opponent we trained
prefix: T12
depends-on: 0003 — Web interface, 0006 — Opponent in the interface, 0009 — Engine in Rust, 0011 — AlphaZero training
summary: >
  The fifth difficulty, master: the player of 0011 compiled to WebAssembly from
  the crate as it is, behind a thin export layer; which milestone ships and how
  it is swapped; the browser entry point; the second worker that hosts it; the
  advanced simulation setting and its URL parameter. Amends 0003, 0006, 0009
  and 0011; leaves training, `bot` and `ai-bot` untouched.
---

# Master opponent

## Scope

Covers three things:

- **The web build** of `azul_alphazero`: a new crate under `packages/alphazero-bot/web` that
  exports the crate's own `choose_memoised` to JavaScript and adds no player code of its own.
- **The browser entry point** `alphazero-bot/web`: loading the module and the shipped checkpoint
  from bytes in the bundle, converting a position, and choosing a move.
- **The interface changes**, as amendments to *0006 — Opponent in the interface* and
  *0003 — Web interface*:
  - the `master` level;
  - its own worker;
  - the advanced simulation setting and its URL parameter.

Does not cover training, the network, the search or the checkpoint format. Those are
*0011 — AlphaZero training*'s, and nothing here changes them: the web build calls the crate's
library as it is. It does not cover `bot` (*0004*, *0005*) or `ai-bot` (*0008*) either. `expert`
stays exactly as [0008 A8-33] leaves it.

It **amends** four specs, in the manner of *0006* and *0008*. The edits are enumerated in
*Amendments* and land with the code that needs them ([T12-32]).

### Why the crate as it is

Intent 0010 asks that the player we trained be the player we ship. A throwaway spike, written
before this spec and not kept, measured three ways to put it in a browser. It ran in Node 24
(V8, Chrome's wasm engine), single-threaded, on the machine of record ([0011 Z11-2]), with
training paused. It used checkpoint `third/90`, 11 300 simulations, and every 10th position
of the latency corpus ([0011 Z11-38]), 200 positions after the terminal ones:

| Variant | × native AVX2, no memo | p95 | Same move as native |
| --- | --- | --- | --- |
| The crate as it is, compiled to wasm | 1.76 | 1025 ms | 200 / 200 |
| The crate as it is, through `choose_memoised` | 1.08 | 626 ms | 200 / 200 |
| A simplified fork, after five profile–optimise rounds | 1.06 | 616 ms | 200 / 200 |
| ONNX Runtime Web 1.30 for the network, the crate's search | 2.04 | 1094 ms | 200 / 200 |
| The same, memoised in JavaScript | 1.33 | 760 ms | 200 / 200 |

Some findings decide the design:

- **The kernel ports as it is.** [0011 Z11-10]'s kernel compiles to full-width `f32x4` under
  `+simd128`. Its `#[inline(never)]` split is not an x86 tuning. Without it, LLVM vectorises the
  sixteen lanes as pairs on wasm as well. The fork's first round was restoring that split.
- **Most of the cost is the network.** It takes over 90% of the time, at about 106 µs a call,
  streaming 2.5 MB of weights. The memo of [0011 Z11-69] is the one large saving: 44% of a
  single search's calls repeat an earlier one, so it cuts calls a move from about 3600 to about
  2000. With the memo on both sides, wasm runs at 1.69× native.
- **The fork bought 2% for a second search to keep in step.**
- **ONNX passed parity but lost.** It met [0011 Z11-13]'s parity (worst relative error 1.4e-6),
  yet it was slower, brought a 13.6 MB runtime, and still needed the crate's search. Its values
  differed from the crate's in 140 of 200 positions.
- **Values match native to the last bits, mostly.** wasm's `f32` arithmetic is exact IEEE-754,
  and `exp` and `tanh` come from the libm compiled into the module. So the module computes the
  same bits in every browser. They differ from the native macOS build's in the last bits of the
  value on 35 of 200 positions, and the move was the same in all 200.

### Why raw exports, and not `wasm-bindgen`

The usual way to call Rust from JavaScript is `wasm-bindgen`, often driven by `wasm-pack`. It
generates the JavaScript glue and TypeScript types, copies slices and strings across the
boundary, turns a Rust error into a JavaScript exception, and writes the `#[no_mangle]` exports
itself, so the calling crate needs no `unsafe` of its own. This spec uses raw `extern "C"`
exports instead ([T12-5]), for these reasons:

- **It is not a question of speed.** `wasm-bindgen` compiles to the same kind of exports, and its
  glue copies the input into linear memory just as [T12-12]'s loader does. A call across the
  boundary costs microseconds, while a move does all its work inside the module and takes
  hundreds of milliseconds. The difference is well under 0.01% of a move either way.
- **The surface is small.** Six functions pass numbers and one buffer of words ([T12-3]). What
  `wasm-bindgen` would save is about five lines of `unsafe`, held to one module with a comment on
  each ([T12-5]), and a hand-written type declaration of a dozen lines.
- **It is a second version-locked tool.** `wasm-bindgen`'s command-line tool must match the library
  version exactly. Every machine and the suite would need it installed at that version, and
  `rust-toolchain.toml` cannot pin it. Raw exports need nothing beyond the pinned toolchain and
  its `wasm32-unknown-unknown` target ([T12-8]).
- **It adds dependencies.** It would add a crates.io dependency and the macro crates it builds with
  (`syn`, `quote`, `proc-macro2`) to a project that admits crates one by one ([0011 Z11-2]), and
  imports to a module that [T12-6] keeps import-free.

The other crates considered bought nothing. `wasm-opt` shrinks code, but the code is 160 KB beside
2.5 MB of weights. Threading crates need cross-origin-isolation headers that the static host of
[0003 U3-9] cannot be relied on to send. If the boundary ever grows to strings or structured
results, `wasm-bindgen` is the first thing to reconsider.

## Definitions

Terms from *0006* (seating, request, generation, thinking) and *0011* (checkpoint, parity file,
milestone, pool rating) keep their meaning.

| Term | Meaning |
| --- | --- |
| **master** | The `Level` this spec adds: the trained player, in the browser. |
| **Web crate** | `azul_alphazero_web`, under `packages/alphazero-bot/web` ([T12-1]). |
| **Shipped milestone** | The logged milestone named by `packages/alphazero-bot/web/shipped.json` ([T12-9]). |
| **Payload** | The generated module holding the compiled web crate, the shipped checkpoint and its parity file as bytes ([T12-7]). |
| **Master worker** | The second module worker, which hosts `master` and nothing else ([T12-20]). |
| **Simulations setting** | A seat's number of simulations when it is `master`, one per seat, each in `[min, max]` ([T12-16]). |

| Constant | Value |
| --- | --- |
| `MASTER_SIMULATIONS.default` | 10 000 |
| `MASTER_SIMULATIONS.min` | 100 |
| `MASTER_SIMULATIONS.max` | 200 000 |

*The maximum is set by memory, not time. A search keeps every node it visits, plus the memo, at
about 1.2 KB a simulation. 200 000 measured 254 MB on one heavy position, where 1 000 000 would
need over a gigabyte. Its slowest moves take about 13 s on the machine of record.*

## Data model

### `shipped.json`

```ts
interface Shipped {
  run: string;               // e.g. "sixth"
  generation: number;        // a logged milestone of that run
  checkpointSha256: string;  // of milestones/<run>/<generation>/checkpoint.bin
  paritySha256: string;      // of milestones/<run>/<generation>/checkpoint.parity
}
```

### The browser entry point

```ts
// alphazero-bot/web/settings — constants only, no payload [T12-15]
export const MASTER_SIMULATIONS: Readonly<{ default: 10000; min: 100; max: 200000 }>;
export function validSimulations(n: unknown): n is number;  // an integer in [min, max]

// alphazero-bot/web — the player
export interface MasterChoice {
  /** Always a member of position.legalActions. */
  action: number;
  /** The root's backed-up value for the seat to move, in [-1, 1]. Not points. */
  value: number;
  /** Simulations run: exactly the number asked for ([0011 Z11-18]). */
  simulations: number;
}
export interface Master {
  choose(position: AzulJSON, simulations: number): MasterChoice;
  /** The module's linear memory in bytes, which only grows: [T12-25]'s measure. */
  memoryBytes(): number;
}
/** `parity` defaults to the payload's; the suite passes a corrupted one ([T12-28]). */
export function createMaster(parity?: Uint8Array): Promise<Master>;  // [T12-12]
export function moduleBytes(): Uint8Array;  // the compiled module, for [T12-6]'s check
export const SHIPPED: Readonly<Shipped>;
```

### The web crate's exports

Raw `extern "C"` functions, no bindings generator (see *Why raw exports, and not `wasm-bindgen`*),
all on `wasm32` linear memory:

| Export | Signature | Does |
| --- | --- | --- |
| `alloc` | `(len: usize) -> *mut u8` | A buffer of `len` bytes that JavaScript fills. Never freed. |
| `load` | `unsafe (ck, ck_len, par, par_len, cpuct: f32, fpu: f32) -> i32` | `Network::load` with the parity check ([0011 Z11-13]). Returns `0`, or `-1` with the error text set. |
| `words_ptr` | `() -> *mut u32` | A buffer of at least 512 words for one canonical block ([0010 C10-8]). |
| `choose` | `(n_words: usize, simulations: u32) -> i32` | The action, or `-1` for a terminal position, or `-2` for a refused block, with the error text set. |
| `value` | `() -> f32` | The value of the last `choose`. |
| `error_ptr`, `error_len` | `() -> *const u8`, `() -> usize` | The last error, as UTF-8. |

### Messages

*0006*'s protocol, widened:

```ts
type Level = Tier | 'expert' | 'master';
type ToWorker =
  | { generation: number; position: AzulJSON; tier: Tier | 'expert' }
  | { generation: number; position: AzulJSON; tier: 'master'; simulations: number };
type FromWorker =
  | { generation: number; ok: true; choice: Choice | ExpertChoice | MasterChoice }
  | { generation: number; ok: false; message: string };

interface Seating {
  players: [Level | null, Level | null];
  /** Each seat's simulations setting, by seat. Kept whatever the seats are; read only for a master seat. */
  simulations: [number, number];
}
```

## Behaviour

### The web crate

- **[T12-1]** The web crate MUST be named `azul_alphazero_web`, Rust edition 2024, with
  `publish = false`. Its `Cargo.toml` is at `packages/alphazero-bot/web`, and it has one library
  target of `crate-type = ["cdylib", "rlib"]`.
  - Its only dependencies are `azul_alphazero` (`path = ".."`) and `azul_engine`
    (`path = "../../engine-rs"`). It has no crates.io dependency, in any section.
  - Its `Cargo.lock` MUST be committed, and every `cargo` invocation for it MUST pass `--locked`.
  - Its release profile MUST be `codegen-units = 1`, `lto = "fat"`, as the crate's is.
- **[T12-2]** The web crate MUST hold its own `.cargo/config.toml` with exactly one section,
  `[target.wasm32-unknown-unknown]`, holding exactly
  `rustflags = ["-C", "target-feature=+simd128"]`.

  *SIMD128 has shipped in every major engine since Chrome 91, Firefox 89 and Safari 16.4, and the
  measured figures stand on it.
  Like [0011 Z11-2]'s AVX2 flag, it changes instructions and not results. The order of every sum is
  in the source.*

- **[T12-3]** The web crate MUST contain no player code. Every move MUST come from one call to
  `azul_alphazero::memo::choose_memoised`, with a fresh `Memo` per `choose`, a `SearchConfig` of
  `{ simulations, cpuct, fpu }`, and the `Network` that `load` accepted. A source check MUST fail
  on:
  - `impl Evaluator`;
  - a call to `forward`, `forward_batch` or `masked_softmax`;
  - `Search::new`;
  - a source with no `choose_memoised(` in it.

  *The crate's library is reused as it is, and that is the whole of intent 0010's "the player we
  trained is the player we ship". A memo per move rather than per round keeps the memory a move
  costs bounded by that move, which is what the maximum of [T12-16] was measured on. Answers are
  identical either way ([0011 Z11-69]).*

- **[T12-4]** `choose` MUST decode the block with `azul_alphazero::wire::read_canonical` and build
  the state with `AzulState::from_canonical(&c, Seeded::new(0))`, exactly as `play` does
  ([0011 Z11-23]).
- **[T12-5]** `unsafe` MUST appear in one module of the web crate only, `src/exports.rs`, which
  holds the exports and nothing else. Every `unsafe` block there MUST carry a `// SAFETY:`
  comment. The crate root MUST be `#![deny(unsafe_code)]`, with `#[allow(unsafe_code)]` on that
  module alone. `azul_alphazero` stays `#![forbid(unsafe_code)]` and is not edited.

  *`#[unsafe(no_mangle)]` is how a function reaches JavaScript without a bindings crate, and edition
  2024 counts it as unsafe code. One module and one attribute keep that in a place a reader can
  check.*

- **[T12-6]** The compiled module MUST import nothing: `WebAssembly.Module.imports` of it is
  empty.

### The payload

- **[T12-7]** `pnpm -F alphazero-bot web` MUST:
  1. build the web crate with
     `cargo build --locked --release --lib --target wasm32-unknown-unknown`;
  2. read `web/shipped.json`, and refuse unless both files of the shipped milestone exist and
     match the recorded sha256s;
  3. read `cpuct` and `fpu` from the shipped milestone's logged config ([0011 Z11-34]);
  4. write `packages/alphazero-bot/web/dist/payload.ts`, which is git-ignored.

  The payload exports the module, the checkpoint and the parity file as base64 strings, and
  `SHIPPED`, `CPUCT` and `FPU`.
- **[T12-8]** `rust-toolchain.toml` MUST name `targets = ["wasm32-unknown-unknown"]`, so the
  pinned toolchain installs the target on first use. This applies to every byte-identical copy of
  the file: `engine-rs`, the cross-check's checker and `alphazero-bot` ([0009 R9-1]).

### Which milestone ships

- **[T12-9]** `packages/alphazero-bot/web/shipped.json` MUST be committed and MUST name a
  **logged** milestone ([0011 Z11-4]) whose checkpoint and parity file are committed and match
  its two sha256s.
- **[T12-10]** The shipped milestone MUST be the logged `milestone` entry with the highest
  `pool.rating`, ties to the earlier entry. Entries without a pool rating, which ran on the
  ladder yardstick, are not candidates. A test MUST assert it.

  *Intent 0010: the strongest player we have, by training's own record, and swapping in a
  stronger one "is a routine step, not a project". This test is what makes it routine. Committing
  a milestone that out-rates the shipped one fails the suite until `shipped.json` names it, so the
  swap is one edit in the same commit. Pool ratings share one anchor, `third/90` at 0
  ([0011 Z11-73]), so they compare across runs.*

- **[T12-11]** The web crate, `shipped.json` and `web/dist/` are not source paths of
  [0011 Z11-63]. Building or swapping the shipped player never marks a training build dirty and
  never changes the ladder hash.

### The browser entry point

- **[T12-12]** `createMaster()` MUST decode the payload's base64 into bytes, instantiate the module
  with `WebAssembly.instantiate(bytes, {})`, copy the checkpoint and parity file into buffers from
  `alloc`, and call `load` with `CPUCT` and `FPU`. It MUST reject with the error text when `load`
  fails. It MUST NOT use `fetch`, `WebAssembly.instantiateStreaming` or
  `WebAssembly.compileStreaming`, which take a network response.
- **[T12-13]** `Master.choose(position, simulations)` MUST throw unless
  `validSimulations(simulations)` holds, and it MUST throw on a terminal position or a refused
  block. Otherwise it converts the position with
  `canonicalWords(toCanonical(fromJSON(position, 0)))`, writes the words at `words_ptr`, and calls
  `choose`. It returns the action, the value and the simulations run.

  *`toJSON`'s bag is counts ([0001 E1-52]) and `fromJSON(…, 0)` orders it from seed 0, which the
  search never reads, since it stops at the round boundary ([0011 Z11-15]). The information barrier
  of [0006 W6-14] holds unchanged.*

- **[T12-14]** `alphazero-bot/web` MUST hold its own `canonicalWords`. It MUST NOT import
  `eval/chooser.ts`, which imports `node:worker_threads`. A test MUST assert that the two give
  identical words on every position of the latency corpus.

  *A second copy rather than a move, because the chooser adapter is in the ladder hash
  ([0011 Z11-63]): moving its function out would start every run's comparison afresh for a change
  that plays no differently.*

- **[T12-15]** `alphazero-bot/web/settings` MUST export `MASTER_SIMULATIONS` and
  `validSimulations`, and MUST NOT import the payload, directly or transitively.
  `validSimulations(n)` is true exactly for an integer `n` with
  `MASTER_SIMULATIONS.min ≤ n ≤ MASTER_SIMULATIONS.max`.
- **[T12-16]** The constants MUST be the values of *Definitions*. `master` MUST use the default
  wherever the simulations setting is absent or invalid.
- **[T12-17]** `alphazero-bot/web` MUST NOT import `bot`, `ai-bot`, `ui`, or anything under
  `eval/`, and nothing under `web/` may touch the DOM, storage, the network or a clock.

### The interface

These requirements were proposals for *0006*, in the manner of [0008 A8-33]. Each has landed in
`spec/0006-opponent-in-the-interface.md` under the number shown, and is cited from there.

- **[T12-18]** *(Landed as [0006 W6-43].)* The interface MUST always offer `master`, labelled
  `Computer — master`. In the order of [0006 W6-1] it comes last: after `sharp`, and after
  `expert` when [0008 A8-33] offers that. Nothing gates it. *(Intent 0010 drops the pass-or-fail
  match against `sharp` that 0006's player needed.)*
- **[T12-19]** *(Landed as [0006 W6-44].)* Each seat's simulations setting is part of the seating,
  and the two are independent. A request for a `master` seat carries that seat's setting.
  - Each MUST default to `MASTER_SIMULATIONS.default`.
  - A new game MUST keep both, as it keeps the seats.
  - Changing either MUST deal a new game with a fresh seed, as a seating change does
    ([0006 W6-3]).
  - They MUST be carried in the URL beside `seed` and `seating` ([0006 W6-4]), as `p1Simulations`
    for seat 0 ("Player 1") and `p2Simulations` for seat 1 ("Player 2"). A parameter MUST be
    written only when its seat is `master` and its value is not the default. A value that fails
    `validSimulations` MUST be discarded for the default, the way [0003 U3-13] discards a seed,
    and that does not affect the other seat's.
  - They MUST NOT be written to storage ([0003 U3-15]): they last as long as the page or the URL.

  *Because `choose_memoised` is a pure function of position and setting ([0011 Z11-24]), a seed, a
  seating, both settings and the person's moves reproduce the whole game, `master`'s play
  included. That is [0006 W6-4]'s promise, kept for the new level. Two settings rather than one
  make an uneven `master`-against-`master` game possible, which is the cheapest way to watch what
  extra search buys.*

- **[T12-20]** *(Landed as [0006 W6-45].)* The advanced control MUST be rendered only while at
  least one seat is `master`. It sits inside a closed-by-default `<details>` whose summary reads
  `Advanced`.
  - It holds one number input for each `master` seat, and none for any other seat. Each is
    labelled `Player 1: simulations per move` or `Player 2: simulations per move`, with `min`,
    `max` and the current value from that seat's setting. One line states the default and the
    range.
  - A valid value, committed on `change`, MUST apply [T12-19] to that seat alone. An invalid one
    MUST leave both settings and the game as they were, restore the input to the seat's setting,
    and say why, with the range, in a `role="status"` line inside the control.
  - It stays available while a search is in flight, as the new-game control does
    ([0006 W6-23]).

  *A status line of its own rather than [0003 U3-56]'s live region, which is derived from the view
  model alone. A refused entry changes nothing the view model holds, and giving it a place there
  would add state to the state module for a message about a form field.*

- **[T12-21]** *(Landed as [0006 W6-46].)* `master` MUST run in its own dedicated module worker,
  `master-worker.ts`, constructed by the exact shape [0003 U3-8] permits.
  - It is created lazily, on the first `master` request, and terminated on every deal, as
    [0006 W6-13] terminates the first worker.
  - Its module graph MUST reach `engine` and `alphazero-bot/web`, and MUST NOT reach `bot`,
    `ai-bot`, `src/components/` or the state module.
  - The first worker's graph, the main thread's graph and everything under `src/components/` MUST
    NOT reach `alphazero-bot/web` or the payload. They MAY reach `alphazero-bot/web/settings`.

  *This is intent 0010's "only paid for by those who use it", kept simple. The payload is about
  3.6 MB as base64, and it is only ever loaded by a worker nobody creates until a seat is
  `master`. A seating with no `master` loads exactly what it loaded before.*

- **[T12-22]** *(Landed as [0006 W6-47].)* The master worker MUST hold at most one `Master`, created
  by `createMaster()` on its first request and shared by both seats. Each request is answered by
  `choose(position, simulations)`, in the order the requests arrive, and posted as
  `{ ok: true, choice }`. A rejection from
  `createMaster` or a throw from `choose` MUST be reported as `{ ok: false, message }`
  ([0006 W6-15]).

  *One instance for both seats is sound where [0006 W6-40]'s sessions are not: `choose` keeps
  nothing between moves. Sharing it pays for instantiation and the parity check once.*

- **[T12-23]** *(Landed as [0006 W6-48].)* The real seam MUST route each request to the worker its
  level runs on. [0006 W6-7]'s single outstanding request and [0006 W6-42]'s per-generation reply
  routing MUST hold **across both workers**: a reply from either worker settles only a request
  that worker was sent. The fast suite MUST exercise the real seam against two stand-in `Worker`s,
  with a `master` seat against a tier, across a deal mid-search, asserting that both workers are
  terminated and that no reply crosses.

  *[0006 W6-42] exists because a seam once crossed its wires on one worker. Two workers are a new
  configuration of the same seam, so it gets a case in that configuration.*

- **[T12-24]** *(Folded into [0006 W6-24] and [0006 W6-25].)* `MasterChoice.value` is covered by [0006 W6-24] and
  [0006 W6-25]: published in `lastChoice` at most, and never rendered.

### Performance

- **[T12-25]** An on-demand lane, `pnpm -F alphazero-bot web-latency`, MUST time
  `Master.choose` in Node on every non-terminal latency-corpus position, at the default setting,
  single-threaded, from the call to its return. It prints `p50`, `p95` and `max`. With the
  machine otherwise idle, `max` MUST be under 1000 ms on the machine of record.

  It MUST also time one search at `MASTER_SIMULATIONS.max` on the corpus position slowest at the
  default, on a fresh `Master`, and print `memoryBytes()` after it. That size MUST be under 512 MB.
  Node's own `arrayBuffers` figure does not count WebAssembly memory, and reads 0.

  *Intent 0010: on this laptop, every move at the default takes under a second. The figures it
  stands on: 11 300 simulations gave p95 626 ms and max 736 ms on the 200-position subset, so
  10 000 projects to about 650 ms at worst. The lane is rerun when the shipped milestone changes
  architecture. A new checkpoint of the same architecture moves the figures only through where its
  trees go ([0011 Z11-39]).*

## Verification

- **[T12-26]** The web crate's `cargo test` MUST call its exports, natively, on at least 50
  latency-corpus positions at 800 simulations, with the package's fixture network. It MUST assert action and value bit for bit equal
  to `azul_alphazero::search::choose` on the same network and settings. That covers the decoding
  of [T12-4], the settings of [T12-3] and the memo's transparency together.
- **[T12-27]** The package's vitest suite MUST build the payload, call `createMaster()` and
  `choose` in Node on the same positions at 800 simulations, and assert two things:
  - the **same action** as `alphazero play --search milestone` on a config carrying the shipped
    milestone's `cpuct`, `fpu` and `milestoneSimulations: 800`;
  - a **value within 1e-5** of `play`'s value.

  *Bit equality is asserted where it is promised, in [T12-26] on one build. Across native macOS and
  wasm, `exp` and `tanh` come from different libms, so the value is compared to a tolerance and the
  move exactly. In the spike of *Scope*, 200 of 200 moves agreed.*

- **[T12-28]** The suite MUST also assert:
  - [T12-6], on the built module;
  - a parity file with one byte flipped makes `createMaster` reject;
  - `choose` throws at 99 and 200 001 simulations, and on a terminal position;
  - [T12-15]'s graph, by walking the imports of `web/settings.ts`.
- **[T12-29]** Each mutation below MUST have been seen to turn the named assertion red before
  that assertion is kept, made in a copy with its landing confirmed, and recorded beside the
  assertion.

  | Mutation | Must fail |
  | --- | --- |
  | `cpuct` and `fpu` passed to `load` in swapped order | [T12-27] |
  | `Seeded::new(1)` in place of `Seeded::new(0)` in `choose` | nothing. The search never reads the shuffler before a boundary ([0011 Z11-15]), and the check records that it stays green |
  | One field of `canonicalWords` in `web/` written out of order | [T12-14] |
  | The web crate calling `choose` instead of `choose_memoised` | [T12-3]'s source check |
  | `shipped.json` naming `third/90` | [T12-10] |
  | The first worker's module importing `alphazero-bot/web` | [T12-21]'s graph check |

  *The second row records a check that cannot fail, on purpose. A reader who wonders whether the
  shuffler's seed matters finds the answer here, rather than a test that pretends to catch it.*

- **[T12-30]** The browser lane of [0003 U3-73] MUST play, against the real master worker, one
  complete game with `master` on both seats, loaded from a URL carrying `p1Simulations=100` and
  `p2Simulations=200`. It MUST
  assert [0006 W6-26] and [0006 W6-35] while a search is in flight. It MUST also play one ply of a
  person-against-`sharp` game and assert that no request was made for the master worker's chunk.
- **[T12-31]** Every requirement in this document MUST be either cited by at least one test in
  `packages/alphazero-bot`, by identifier, or listed with a reason in the *Traceability
  exemptions* table. This is enforced by the package's traceability test, which reads this spec
  beside 0011.

### Traceability exemptions

| Requirement | Why it is not testable here |
| --- | --- |
| [T12-18], [T12-19], [T12-20], [T12-21], [T12-22], [T12-23], [T12-24] | Proposals for *0006*. They are cited in `packages/ui` under the numbers they take there. |
| [T12-25] | A lane run on purpose, on an idle machine. |
| [T12-32] | A process promise about what lands in which commit. |
| [T12-30] | Asserted in `packages/ui`'s browser lane, under [0006 W6-30] as amended. |

## Amendments

Identifiers are append-only. A widened requirement is edited in place, and a new one takes the
next free number.

- **[T12-32]** These amendments MUST land in their specs in the same change as the code that needs
  them, as [0006 W6-28] and [0008 A8-47] required of their own.

### To 0003 — Web interface

| Requirement | Amendment |
| --- | --- |
| [0003 U3-7] | Widen: `ui` may also depend on `alphazero-bot`, which knows how to play and asks the engine what is legal. |
| [0003 U3-74] | Widen the allowlist to include `alphazero-bot`, as a `workspace:` range. |
| [0003 U3-8] | Widen: two same-origin module workers, `./worker.ts` and `./master-worker.ts`, each constructed by the exact shape already permitted. `WebAssembly.instantiate` of bytes already in the bundle is not a network request and is permitted. `WebAssembly.instantiateStreaming` and `WebAssembly.compileStreaming` are forbidden with `fetch`. |
| [0003 U3-75] | The source check permits the second worker construction by its exact shape, and fails on `instantiateStreaming` and `compileStreaming`. |
| [0003 U3-72] | The throwing stubs add `WebAssembly.instantiateStreaming` and `WebAssembly.compileStreaming`. |
| [0003 U3-73] | Extend the browser lane with [T12-30]. |
| [0003 U3-78] | Name `master-worker.ts` beside `worker.ts`: it runs inside a worker and MUST NOT be reachable from the state module or a component. |
| [0003 U3-15] | Unchanged. The simulations settings live in the seating and the URL, not in storage. |
| `package.json` | `dev`, `build`, `test`, `test:browser` and `typecheck` run `pnpm -F alphazero-bot web` first, so the payload exists. |

### To 0006 — Opponent in the interface

| Requirement | Amendment |
| --- | --- |
| *Data model* | `Level` gains `'master'`. `Seating` gains `simulations`, one per seat. `ToWorker` and `FromWorker` become this spec's *Messages*. |
| [0006 W6-1] | Extend: offer `master` as [T12-18] says. |
| [0006 W6-3], [0006 W6-4] | Extend with [T12-19]: each seat's setting deals like a seating change, and travels in the URL as `p1Simulations` and `p2Simulations`. |
| [0006 W6-11] | Widen: the search runs in one of two dedicated workers. A `master` seat's runs in the master worker, every other level's in the first. Together they are the only things loaded at run time. |
| [0006 W6-12] | Extend with [T12-21]'s graphs. The first worker's bundle is unchanged, and the master worker carries the payload, which MUST stay under 5 MB. |
| [0006 W6-13] | Widen to both workers: each is created lazily, and both are terminated on every deal. |
| [0006 W6-7], [0006 W6-42] | Hold across both workers ([T12-23]). |
| [0006 W6-15] | Extend: a rejection from `createMaster` or a throw from `choose` is reported the same way. |
| [0006 W6-24], [0006 W6-25] | Cover `MasterChoice.value` ([T12-24]). |
| [0006 W6-26], [0006 W6-35] | Unchanged, and applying to `master` at any simulations setting. |
| [0006 W6-29] | The property test also runs with one seat `master` through the injected seam. |
| [0006 W6-30] | Extend with [T12-30]. |
| New, [0006 W6-43] to [0006 W6-48] | [T12-18] to [T12-23], under those numbers in order. [T12-24] is folded into [0006 W6-24] and [0006 W6-25] rather than numbered. |

### To 0009 — Engine in Rust

| Requirement | Amendment |
| --- | --- |
| [0009 R9-1] | Unchanged in substance. The pinned `rust-toolchain.toml` gains `targets = ["wasm32-unknown-unknown"]` ([T12-8]). Its byte-identical copies change with it. |

### To 0011 — AlphaZero training

| Requirement | Amendment |
| --- | --- |
| *Scope* | "Nothing runs in the browser" is now *0012*'s to settle: the player does, through the web crate. Training, the crate's library and every lane are unchanged. |
| [0011 Z11-1] | Widen: the package exports `./web` and `./web/settings` for `ui`. Its one runtime dependency is still `engine`. |
| [0011 Z11-2] | Unchanged. The web crate is a separate crate with no crates.io dependency, and `azul_alphazero` gains no dependency and no edit. |
| [0011 Z11-3] | Extend: the source check also covers `web/`. |
| [0011 Z11-4] | Add the scripts `web` ([T12-7]) and `web-latency` ([T12-25]). The root `pnpm test` runs the web crate's `cargo test` and [T12-27]. |
| [0011 Z11-47] | Unchanged in scope. Its config-file clause holds the package root's `.cargo/config.toml`, and [T12-2] holds the web crate's. |

## Invariants

- `choose(position, n).action ∈ position.legalActions` for every non-terminal position and valid
  `n`.
- `choose(position, n).simulations === n` ([0011 Z11-18]).
- A seating with no `master` seat constructs no master worker, and so loads no payload.
- At most one request is outstanding across both workers ([0006 W6-32]).

## References

- Intent [0010 — Playing the opponent we trained](../intent/0010-playing-the-opponent-we-trained.md)
- Intent [0009 — An opponent we train ourselves](../intent/0009-an-opponent-we-train-ourselves.md)
- Spec [0003 — Web interface](0003-web-interface.md): amended here
- Spec [0006 — Opponent in the interface](0006-opponent-in-the-interface.md): amended here
- Spec [0009 — Engine in Rust](0009-engine-in-rust.md): amended here, by one line of the toolchain
- Spec [0011 — AlphaZero training](0011-alphazero-training.md): the player itself, and amended here
