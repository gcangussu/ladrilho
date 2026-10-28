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
library as it is. The endgame proof that follows the search ([0011 Z11-76]) is 0011's too; what
this spec decides is the node cap the browser plays it at ([T12-33]). It does not cover `bot` (*0004*, *0005*) or `ai-bot` (*0008*) either. `expert`
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
  *Remeasured on 10-27 with the crate as shipped (`choose_played`, the proof, the memo within
  each move), interleaved on the idle machine of record, both sides twice over every
  non-terminal corpus position, the faster of each position's two times kept: the module took
  1.46–1.49× native AVX2 in total, at 10 000 and 50 000 simulations, with the past-deal
  refinement and without, and its per-position ratio had a median of 1.46–1.49 and a 10–90%
  range of 1.32–1.61. The module is not as fast as native, and the gap does not close with the
  count. Native figures are therefore no stand-in for [T12-25]'s, which time the module.*
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
| **Endgame cap** | The node cap of [0011 Z11-76]'s endgame proof that the shipped player plays at, recorded in `shipped.json` ([T12-33]). |

| Constant | Value |
| --- | --- |
| `MASTER_SIMULATIONS.quick` | 10 000 |
| `MASTER_SIMULATIONS.default` | 100 000 |
| `MASTER_SIMULATIONS.deep` | 200 000 |
| `MASTER_SIMULATIONS.min` | 100 |
| `MASTER_SIMULATIONS.max` | 200 000 |

*The maximum was set by memory while a search kept about 1.2 KB a simulation: 200 000 measured
254 MB on one heavy position, where 1 000 000 would have needed over a gigabyte. Since the 10-21
layout it keeps about 0.29 KB, and on 10-22 the heaviest corpus position measured 72 MB at
200 000 and 290 MB at 1 000 000, both inside [T12-25]'s 512 MB. So memory no longer decides it;
strength does. Played natively on 10-22, 100 000 against the default scored 62.5% (about +90
Elo), and 200 000, 500 000 and 1 000 000 against 100 000 scored 57%, 50% and 47%: past 100 000
to 200 000 the setting buys waiting, not strength (`milestones/JOURNAL.md`, 10-22). The maximum
stays 200 000, where "more simulations play stronger" is still true. Its slowest moves take
about 9 s on the machine of record.*

*`quick`, `default` and `deep` are [T12-37]'s, from the climb of 10-27 on `twelfth`/120. The
default, 10 000 until then, was set by intent 0010's budget of every move under a second; that
budget is now `quick`'s, and 10 000 is the largest count that still keeps it.*

## Data model

### `shipped.json`

```ts
interface Shipped {
  run: string;               // e.g. "sixth"
  generation: number;        // a logged milestone of that run
  checkpointSha256: string;  // of milestones/<run>/<generation>/checkpoint.bin
  paritySha256: string;      // of milestones/<run>/<generation>/checkpoint.parity
  endgameNodes: number;      // the endgame cap, a whole number in 0..=10^9 [T12-33]
  pastDeal: { sha256: string } | null;  // the shipped milestone's pastdeal.json, or none [T12-36]
}
```

### The browser entry point

```ts
// alphazero-bot/web/settings — constants only, no payload [T12-15]
export const MASTER_SIMULATIONS: Readonly<{ quick: 10000; default: 100000; deep?: 200000; min: 100; max: 200000 }>;
export function validSimulations(n: unknown): n is number;  // an integer in [min, max]
// [T12-37]: quickest first; Deep only while `deep` is set
export const MASTER_PRESETS: readonly { name: 'Quick' | 'Balanced' | 'Deep'; simulations: number }[];

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
/** `parity` defaults to the payload's; the suite passes a corrupted one ([T12-28]).
 *  `endgameNodes` defaults to the payload's cap; the latency lane passes others ([T12-25]).
 *  `pastDeal` defaults to the payload's refinement, empty for none; the lane passes others. */
export function createMaster(parity?: Uint8Array, endgameNodes?: number, pastDeal?: Uint8Array): Promise<Master>;  // [T12-12], [T12-33], [T12-36]
export function moduleBytes(): Uint8Array;  // the compiled module, for [T12-6]'s check
export const SHIPPED: Readonly<Shipped>;
```

### The web crate's exports

Raw `extern "C"` functions, no bindings generator (see *Why raw exports, and not `wasm-bindgen`*),
all on `wasm32` linear memory:

| Export | Signature | Does |
| --- | --- | --- |
| `alloc` | `(len: usize) -> *mut u8` | A buffer of `len` bytes that JavaScript fills, for `load`, which frees it. |
| `load` | `unsafe (ck, ck_len, par, par_len, cpuct: f32, fpu: f32, endgame_nodes: u32, pd, pd_len) -> i32` | `Network::load_single` with the parity check ([0011 Z11-13]), keeping the settings, the endgame cap ([T12-33]) and the past-deal refinement ([T12-36]) every `choose` plays at. `pd` is a `pastdeal.json`'s bytes, empty for none, read by `PastDeal::parse` and refused unless fitted to the checkpoint: a refused refinement refuses the load. Frees all three buffers. Once loaded, plays one `choose_played` at 10 000 simulations on a fixed position with few moves (the opening, its first legal action each ply until at most six remain) and throws the answer away, so that the engine has optimised the search before the first real move: WebAssembly has no on-stack replacement, and the first move otherwise ran its whole search in baseline code, about 15% slower. Nothing a later `choose` answers changes. Returns `0`, or `-1` with the error text set. |
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
  `azul_alphazero::pastdeal::choose_played`, with a fresh `Memo` per `choose`, a `SearchConfig` of
  `{ simulations, cpuct, fpu, endgame_nodes }` whose `endgame_nodes` is the cap `load` was given
  ([T12-33]), the refinement `load` was given ([T12-36]), and the `Network` that `load` accepted.
  The endgame proof and the refinement are the crate's, run inside `choose_played`
  ([0011 Z11-76], [0011 Z11-96]), not code of the web crate; without a refinement it is
  `choose_memoised`, bit for bit. A source check MUST fail on:
  - `impl Evaluator`;
  - a call to `forward`, `forward_batch` or `masked_softmax`;
  - `Search::new`;
  - a source with no `choose_played(` in it, one that calls `choose_memoised(` alone included.

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
     match the recorded sha256s, its `endgameNodes` is a whole number in `0..=10⁹`, and its
     `pastDeal` is `null` or `{ sha256 }` naming the milestone's own `pastdeal.json`, which exists,
     matches the sha256 and was fitted to the shipped checkpoint ([T12-36]);
  3. read `cpuct` and `fpu` from the shipped milestone's logged config ([0011 Z11-34]);
  4. write `packages/alphazero-bot/web/dist/payload.ts`, which is git-ignored.

  The payload exports the module, the checkpoint, the parity file and the refinement's file
  (empty for none) as base64 strings, and `SHIPPED`, `CPUCT`, `FPU` and `ENDGAME_NODES`, the
  last being `shipped.json`'s `endgameNodes`.
- **[T12-8]** `rust-toolchain.toml` MUST name `targets = ["wasm32-unknown-unknown"]`, so the
  pinned toolchain installs the target on first use. This applies to every byte-identical copy of
  the file: `engine-rs`, the cross-check's checker and `alphazero-bot` ([0009 R9-1]).

### Which milestone ships

- **[T12-9]** `packages/alphazero-bot/web/shipped.json` MUST be committed and MUST name a
  **logged** milestone ([0011 Z11-4]) whose checkpoint and parity file are committed and match
  its two sha256s, and MUST carry the endgame cap ([T12-33]).
- **[T12-10]** Once the log holds a `ship` entry ([T12-35]), the shipped milestone MUST be
  `master` as the log names it. Before then it was decided by rating, which a test still asserts
  of a log without one:
  - **Once `milestones/anchors.json` exists ([0011 Z11-84]):** the strongest on the anchors'
    scale. That is the highest of the anchors at their ratings in the file and of every logged
    entry with an `anchored.rating` (milestones and `rating` entries), ties to the anchor, then
    to the earlier entry.
  - **Before the file exists:** the logged `milestone` entry with the highest `pool.rating`,
    ties to the earlier entry. Entries without one (the ladder's) are not candidates.

  A test MUST assert all three.

  *Intent 0010: the strongest player we have, by training's own record, and swapping in a
  stronger one "is a routine step, not a project". This test is what makes it routine. Committing
  a milestone that out-rates the shipped one fails the suite until `shipped.json` names it, so the
  swap is one edit in the same commit. Pool ratings share one anchor, `third/90` at 0
  ([0011 Z11-73]), so they compare across runs, but their scale drifted upward by more than any
  run gained ([0011 Z11-74]), which is why the anchors' scale decided next. The highest of many
  ratings of about ±7 is biased upward too. `sixteenth`/20 rated 876 on the anchors and shipped,
  then scored −12 Elo (−42 to +19) against `twelfth`/120 in 500 games at the shipped settings.
  So a rating now only makes a candidate, and a direct match decides ([T12-34]).*

- **[T12-34]** A logged anchored milestone ([0011 Z11-85]) that rates above `master` MUST be a
  **candidate**. `master`'s rating is its anchor's in the file if it is an anchor, otherwise its
  latest logged `anchored.rating`. A candidate is **owed** a match when all of these hold:
  - it was rated above the `master` of its time. Before the log's first `ship` entry there is
    none, and rating alone decided ([T12-10]);
  - it is still above today's `master`, so `master` itself is never owed one;
  - no `ship` entry names it since, a pin included.

  The loop MUST play every match its run owes, recomputing what is owed before each one: right
  after logging a milestone, and when it starts, before refusing a stopped or done run. So a
  match that was interrupted is played when the loop comes back. Only a run's own loop settles
  its run's matches; at its start it MUST name every other run's owed match, with the
  `pnpm -F alphazero-bot ship <checkpoint>` that plays it. A `master` with no rating on the
  anchors MUST stop the loop with that message, rather than leave every candidate unplayed.
  `ship <checkpoint>` MUST play the match by hand for any logged milestone but `master`, and no
  path may play `master` against itself. The match:
  - The candidate plays `master`, both by the milestone search at the anchors' simulation count,
    with no proof.
  - Each seed is played twice, the candidate first and then second ([0005 M5-3]). The pair's
    score, the mean of its two games, is one observation, counted in quarters.
  - Seeds come from [0011 Z11-85]'s allocation, keyed `ship:<run>/<generation>`, over
    `maxGames / 2` seeds.
  - After every `batchPairs` pairs (200), it computes the log-likelihood ratio of H1 (the
    candidate is at least `elo1` = +15 Elo better) over H0 (at most `elo0` = 0). It uses the
    normal approximation on pair scores: `n · (s1 − s0) · (2m − s0 − s1) / (2v)`, where `s0` and
    `s1` are the expected scores at `elo0` and `elo1`, `m` and `v` the pairs' mean and variance,
    `v` floored at 10⁻⁹.
  - The first look at or above `ln((1 − β) / α)` MUST accept, and the first at or below
    `ln(β / (1 − α))` MUST reject, with α = β = 0.05. Reaching `maxGames`, 8 000, without
    either MUST reject.

  An accepted match names the candidate in `web/shipped.json`. The loop writes that file and
  never commits it.

  *As `pnpm -F alphazero-bot stop-simulation` prints it ([0011 Z11-56]), calling `verdict`
  itself. The model gives each pair's first game the first seat's 8.4 points, the self-play
  figure of 58.4%, and its second game minus them, with no draws:*

  | True edge over `master` (first seat +8.4 points, 4000 matches a row) | Ships | Mean games | 90th percentile games |
  | --- | --- | --- | --- |
  | -15 Elo | 0.00 | 1328 | 2000 |
  | 0 Elo | 0.03 | 3401 | 6800 |
  | +7 Elo | 0.33 | 5009 | 8000 |
  | +15 Elo | 0.93 | 3322 | 6400 |
  | +25 Elo | 1.00 | 1659 | 2800 |
  | +40 Elo | 1.00 | 954 | 1200 |

  *At 200 simulations the anchors play about 2 400 games in seven minutes, so a typical match is
  about ten. 200 simulations was checked as a fair proxy for the shipped 10 000 (10-24).*

  *The matches add up. A level run oscillating around `master`'s rating, as `sixteenth` did
  around 856, makes a candidate of about half its milestones, and each ships a player of equal
  strength 3% of the time. Over 30 milestones that is about a one-in-three chance of a new
  `master` that is no better. H0 is "no better", not "worse", so such a `master` costs nothing in
  strength. The patience rule ([0011 Z11-90]) also keeps level runs short.*

- **[T12-35]** A ship match MUST append a `ship` entry to `milestones/log.json`. The entry
  records:
  - the candidate as `run` and `generation`;
  - `decision`, which is `accept` or `reject`;
  - `master`;
  - `simulations` and `seedBase`;
  - `test`, its six parameters;
  - `looks`, the cumulative five quarter counts after each look;
  - `seconds`;
  - a `reason`.

  `pnpm -F alphazero-bot ship pin <run>:<generation> --reason "…"` MUST append a `ship` entry
  with `decision: pin` and `master: null`, naming a logged milestone `master` without a match.
  It MUST hold the package's lock, as the loop and `ship` do, so a pin cannot land inside a
  match. Every writer of a `ship` entry that names a new `master` MUST compute `shipped.json`'s
  record before appending the entry, so a missing file fails before the log names it.
  That is for the first `master` under [T12-34], and for a person's own call, with the reason
  written down. `master` MUST be the milestone of the latest `ship` entry whose decision is
  `accept` or `pin`. The replay of [0011 Z11-45] MUST hold every `ship` entry to its own numbers:
  - it names a milestone logged before it;
  - a played one names the `master` of its time, and is not that `master`;
  - its test is [T12-34]'s, and its simulation count the anchors';
  - it has looks and a seed base;
  - each look is one more batch than the last, and cumulative;
  - no look before the last decided, and none ran past `maxGames`;
  - its decision is the test's verdict on its looks;
  - its seeds, as many as its pairs, were used by no earlier record.

  A ship entry takes no part in a run's stop rule. Later records' seeds avoid its seeds.

- **[T12-11]** The web crate, `shipped.json` and `web/dist/` are not source paths of
  [0011 Z11-63]. Building or swapping the shipped player never marks a training build dirty and
  never changes the ladder hash.
- **[T12-33]** The shipped player MUST play with [0011 Z11-76]'s endgame proof at the cap
  `shipped.json`'s `endgameNodes` records, 300 000 nodes, a whole number in `0..=10⁹`
  ([0011 Z11-77]'s range). The cap reaches the module one way: the payload's `ENDGAME_NODES`
  ([T12-7]), passed by `createMaster` to `load` ([T12-12]), kept by the web crate's player, and used
  as `endgame_nodes` in every move's `SearchConfig` ([T12-3]). It is the same for both seats and
  every simulations setting. No request, URL parameter or storage carries it, and the interface
  never passes one: `createMaster`'s second argument is for the latency lane alone, which measures
  a cap before it is shipped. A cap MUST keep [T12-25]'s budgets, and MUST be the smallest
  measured past which no measured move changes, recorded with its figures here.

  *Until intent 0016 the rule was "the largest that keeps the budgets", which was the same cap
  while the budget was tight. At 0016's budget it would force a larger cap that buys nothing: the
  journal's sweep found no cap above 300 000 changing a move worth measuring (10-22).*

  *Why the proof at all: on the champions' pool's 3,201 games at 200 simulations, `twelfth`/120
  rated +905 with a 2,000,000-node proof against +856 without, and 262 of the 264 games it changed
  improved (`milestones/JOURNAL.md`, 10-05). Why this cap: measured with `twelfth`/120 on the
  machine of record, idle. At 300 000 nodes the lane measured p50 40 ms, p95 491 ms, p99 641 ms
  and max 831 ms, on a position where the proof runs; 51 MB after the corpus; and 434 MB after the
  search at the maximum. It failed at 500 000 (max 1134 ms) and at 2 000 000 (max 1694 ms, and
  221 MB after the corpus), and passed at 200 000 (max 891 ms). Timed twice at each cap, the
  faster kept, on the 408 corpus positions where the proof runs, it added at most 80, 183, 214
  and 333 ms at 100 000, 200 000, 300 000 and 500 000 nodes (p95 52, 101, 146 and 233 ms), the
  slowest of those moves taking 748, 798, 852 and 951 ms against 668 ms without it. A search at
  the maximum on the three of them with the heaviest searches left 347 to 350 MB at 200 000 and
  300 000 nodes: the table fits in what the finished search gave back. Single timings vary by
  about a tenth between passes, which is why 500 000, with 50 ms to spare on its own worst move,
  is not shipped. What the shipped cap buys, played natively (the moves are the module's,
  [T12-27]): `twelfth`/120 at the default with the proof at 300 000 against itself without, over
  the 200 wide seeds from both seats, split 187 deals as before and came out ahead in all 13 the
  proof changed (5 won both games, 8 won one and drew the other): +9 points in 400 games, for 3.4%
  more thinking time in all. The cap is a property of what ships, like the
  milestone, so it lives beside the milestone in `shipped.json`. It is the browser's only: the
  native `play` takes its cap from `playEndgameNodes` ([0011 Z11-77]).*

### The past-deal refinement and the configurations

- **[T12-36]** The shipped player MUST play with the past-deal refinement ([0011 Z11-91]) that
  `shipped.json`'s `pastDeal` names, or with none when it is `null`. It reaches the module one
  way: the payload carries the file's bytes ([T12-7]), `createMaster` passes them to `load`
  ([T12-12]), and the crate's own `PastDeal::parse` reads them there ([T12-3]). No request, URL
  parameter or storage carries it, and it is the same for both seats and every simulations
  setting. A test MUST hold `shipped.json` to `milestones/log.json`:
  - `pastDeal` non-null only beside an accepting `pastDeal` entry ([0011 Z11-98]) for the same
    milestone and file, played at today's default;
  - `pastDeal` null only beside a rejecting one at today's default, or a `drop`, for the same
    milestone;
  - and so, for a `master` with neither, the suite fails.

  When a ship match or a pin names a new `master`, its writer MUST set `pastDeal` to `null`: the
  constants are fitted to one network. A person then fits the new one and plays its match, or
  drops it with a reason.

  *Intent 0016: the refinement is never lost without anyone noticing. A ship match compares
  networks at 200 simulations without it, so a network that wins one could quietly lose the
  refinement's +33 in the browser; failing the suite until someone decides is what makes that
  loud. The interface's estimate ([0006 W6-56]) reads the second search's value, on the blend's
  scale, on the moves the refinement applies to.*

- **[T12-37]** `MASTER_SIMULATIONS` MUST hold `quick` and `default`, and `deep` exactly when the
  climb names one:
  - **default**: the climb's ([0011 Z11-99]). From 10 000, each step accepted with `fits` is the
    next default; with no step, 10 000.
  - **deep**: the first step accepted without `fits`, which ends the climb. A rejected step ends
    it with no `deep`: more would only make people wait.
  - **quick**: at most the default, and every move under 1 s by [T12-25]'s lane.

  A test MUST hold the constants to the committed log's climb on `master`.

  *Intent 0016: thought is spent only where it is shown to win. Each step must beat the default it
  climbs from by [T12-34]'s test, whose `elo1` is +15, at roughly twice the thinking time, so a
  doubling of the wait has to buy about 15 rating points. A step over budget that still wins is
  offered as `deep` rather than lost, and one that does not win is not offered at all.*

  *The climb of 10-27 on `twelfth`/120, played natively with the refinement off, `fits` from
  [T12-25]'s record of that day: 25 000 against 10 000, 800 games, 54.4%; 50 000 against 25 000,
  800 games, 54.6%; 100 000 against 50 000, 1 200 games, 53.0%; each accepted and in budget. Then
  200 000 against 100 000, 1 600 games, 52.7%, accepted but over budget (p95 3 328 ms, p99
  5 529 ms), so it is `deep` and the climb ended. Each doubling bought about +19 to +32 Elo,
  less as the count grew. `quick` is 10 000, the largest of
  2 000, 5 000 and 10 000 whose every move was under a second (max 805 ms).*

### The browser entry point

- **[T12-12]** `createMaster()` MUST decode the payload's base64 into bytes, instantiate the module
  with `WebAssembly.instantiate(bytes, {})`, copy the checkpoint and parity file into buffers from
  `alloc`, and call `load` with `CPUCT`, `FPU`, the endgame cap — `ENDGAME_NODES` unless a caller
  passes another ([T12-33]) — and the refinement's bytes, the payload's unless a caller passes
  others ([T12-36]). It MUST reject with the error text when `load` fails, and with a
  `RangeError` for a cap that is not a whole number in `0..=10⁹`. It MUST NOT use `fetch`, `WebAssembly.instantiateStreaming` or
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

- **[T12-20]** *(Landed as [0006 W6-45], and since moved into the new-game sheet of [0006 W6-49]: a slider beside the number input, inside the sheet rather than an `Advanced` disclosure.)* The advanced control MUST be rendered only while at
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
  [0006 W6-25]: published in `lastChoice` at most, and never rendered. *(Since intent 0012 it
  is rendered, as a chance and only as [0006 W6-55] through [0006 W6-58] read it.)*

### Performance

- **[T12-25]** An on-demand lane, `pnpm -F alphazero-bot web-latency`, MUST time
  `Master.choose` in Node on every non-terminal latency-corpus position, at the shipped endgame
  cap ([T12-33]) and with the shipped refinement ([T12-36]), single-threaded, from the call to its
  return, twice over, at `quick` and at the default, or at the counts `--simulations` names. For
  each count and pass it prints `p50`, `p95`, `p99` and `max`, pN being the time at rank
  `⌈N/100 · n⌉` as [0011 Z11-40] ranks it; then the same of round-4 positions where the
  refinement can apply, the slowest move of each corpus game and how many games had a move over
  3 s and over 5 s, which position was slowest, and `memoryBytes()` after the corpus. On the
  machine of record, idle, every pass MUST keep its count's budget:
  - **the default**: `p95` at most 3000 ms, `p99` at most 5000 ms, and no move over 10 000 ms;
  - **`quick`**: every move under 1000 ms;
  - **`deep`** and any other count: timed and printed, held to nothing but memory.

  The lane MUST take the package's lock ([0011 Z11-61]) and refuse to start while the one-minute
  load average is over 2.5, and print the load average before and after. `--json <file>` writes
  every figure and time, which is the record the climb reads ([0011 Z11-99]); `--past-deal
  <file>|none` and `--endgame <nodes>` measure a setting before it ships.

  For the default it MUST also time one search at `MASTER_SIMULATIONS.max` on the corpus position
  slowest at the default, and one on the position whose search holds the most memory, each on a
  fresh `Master`, and print `memoryBytes()` after each. Those sizes, and the size after the corpus
  at every count, MUST each be under 512 MB. The heaviest position is named in the lane by its index and re-found when the
  corpus is re-recorded: the slowest at the default is usually a late position whose proof is
  slow and whose tree is small. Node's own `arrayBuffers` figure does not count
  WebAssembly memory, and reads 0. `--endgame <nodes>` runs the lane at another cap, which is how
  [T12-33]'s is chosen.

  *Intent 0016: on this laptop, with nothing else running, 19 moves in 20 at the default take at
  most three seconds and 99 in 100 at most five, and `quick` keeps intent 0010's promise of every
  move under a second. Two passes, because p99 is the twentieth slowest of about 2 000 moves and a
  single time moves by about a tenth between passes; the slower must pass. The 10 s tripwire is
  there so a pathological position is a defect rather than a percentile. The lock and the load
  average make "idle" a check rather than a hope.*

  *Under intent 0010 the budget was `max` under 1000 ms at the default. The figures it stood on: 11 300 simulations gave p95 626 ms and max 736 ms on the 200-position subset, so
  10 000 projects to about 650 ms at worst. The lane is rerun when the shipped milestone changes
  architecture, or the endgame cap. A new checkpoint of the same architecture moves the figures
  only through where its trees go ([0011 Z11-39]). With `twelfth`/120 and no proof it measured
  p95 574 ms, max 927 ms, 48 MB after the corpus, and 485 MB after the search at the maximum.
  The proof keeps a table of about 86 bytes a node beside the search's memo, so its cap is bounded
  by memory as well as by time ([T12-33]).

  *Remeasured on 10-05 after the forward pass learned to skip zero inputs ([0011 Z11-10]) and the
  endgame proof's nodes got cheaper (no allocation or sort per node, the key hashed a word at a
  time), with every move and value the same: p50 30 ms, p95 368 ms, p99 468 ms, max 616 ms, 53 MB
  after the corpus and 436 MB after the search at the maximum, against p50 50, p95 614, p99 819
  for the build before on the same day. The machine was in use for both, so their maxima are not
  compared; interleaved A/B runs on fixed position sets, minimum of three, gave 1.36× on moves at
  the default and 1.5× on the proof alone. A cap or a default that spends the room is a new
  latency record ([T12-33]), not part of this change.*

  *Remeasured on 10-21 after the crate was laid out for memory, with every move and value the
  same: the memo keeps a sparse key and the legal actions' policy only; a tree node keeps no state
  and an action's visits and value sum live on its child; edges come in fixed chunks; the proof's
  table keys on two words; the network holds each matrix once (`Network::load_single`); `load`
  frees the checkpoint's buffers; and `choose` hands `choose_memoised` its memo to drop before the
  proof. The lane: p50 37 ms, p95 426 ms, p99 545 ms, max 697 ms, 19 MB after the corpus and 72 MB
  after the search at the maximum, against 53 MB and 436 MB before. On every fourth corpus
  position, four interleaved A/B pairs: 17.4 MB against 50.7 MB, moves 2.7% faster in total; six
  pairs of the search at the maximum: 0.7% slower at the median.*

  *Remeasured on 10-22, when the lane learned to search the heaviest position (498) at the
  maximum too, found by a sweep of every third corpus position at 50 000 simulations: the
  slowest at the default is usually a late position whose proof is slow and whose tree is
  small, and on 10-22 one such held 14 MB at 1 000 000. p50 36 ms, p95 419 ms, p99 532 ms, max
  700 ms, 19 MB after the corpus, and 9.1 s and 72 MB at the maximum on the heaviest. Rerun at
  endgame caps of 400 000, 500 000 and 600 000 it also passed (max 689, 663 and 687 ms, 31 MB
  after the corpus), where 500 000 failed on 10-05; the journal's sweep found that no cap above
  300 000 changes a move worth measuring, so the shipped cap stands ([T12-33]).*

  *Measured on 10-27 for the new budget, with `pastdeal.json` on and the shipped cap, at every
  count the climb could reach (the slower pass of two, 1 978 positions): 10 000, p95 464 ms, p99
  594 ms, max 805 ms; 25 000, p95 850 ms, p99 1 231 ms, max 3 000 ms; 50 000, p95 1 239 ms, p99
  1 843 ms, max 2 553 ms; 100 000, p95 1 994 ms, p99 3 239 ms, max 4 633 ms, 43 MB after the
  corpus; 200 000, p95 3 328 ms, p99 5 529 ms, max 8 289 ms, 75 MB. 25 000's maximum is one
  move of the first pass, which took 1 487 ms in the second; the load average was 2.3 at the
  start. At 100 000, 11 of the 38 corpus games had a move over 3 s and none one over 5 s; the
  slowest moves are in round 4, where the refinement applies (p99 4 232 ms there). Timed with
  the refinement, these bound the default without it as well: off, a move does no more work.
  At the maximum, 4.3 s and 35 MB on the slowest position at 10 000, 8.0 s and 72 MB on the
  heaviest.*

## Verification

- **[T12-26]** The web crate's `cargo test` MUST call its exports, natively, on at least 50
  latency-corpus positions at 800 simulations, with the package's fixture network and an endgame
  cap given to `load`. It MUST assert action and value bit for bit equal to
  `azul_alphazero::search::choose` on the same network and settings, the cap included. That covers
  the decoding of [T12-4], the settings of [T12-3] and the memo's transparency together. It MUST
  also compare, on late positions where a wall row holds four tiles, loaded at that cap and at 0,
  and assert that the proof changed the crate's move on at least five of them, so that a cap lost
  between `load` and the search fails it ([T12-33]). And loaded with the fixture's
  `pastdeal.json`, on round-4 positions where the refinement applies, it MUST assert action and
  value bit for bit equal to `choose_played` with it, and that the refinement changed the crate's
  move on at least two of them ([T12-36]). The fixture's settings are the test's own, 64 leaves,
  so that 2 000 simulations refine 12.
- **[T12-27]** The package's vitest suite MUST build the payload, call `createMaster()` and
  `choose` in Node on the same positions at 800 simulations, and on late positions where a wall row
  holds four tiles, and assert two things:
  - the **same action** as `alphazero play --search play` on a config carrying the shipped
    milestone's `cpuct` and `fpu`, `playSimulations: 800` and `playEndgameNodes` equal to the
    shipped endgame cap ([T12-33]), and `--past-deal` with the shipped milestone's `pastdeal.json`
    whenever `shipped.json` names one ([T12-36]): `--search play`, because the proof follows no
    other ([0011 Z11-77]);
  - a **value within 1e-5** of `play`'s value.

  It MUST also assert that, on at least three of the late positions, `play` with the proof off
  chooses differently, so the comparison is made where the cap decides the move.

  *Bit equality is asserted where it is promised, in [T12-26] on one build. Across native macOS and
  wasm, `exp` and `tanh` come from different libms, so the value is compared to a tolerance and the
  move exactly. In the spike of *Scope*, 200 of 200 moves agreed.*

- **[T12-28]** The suite MUST also assert:
  - [T12-6], on the built module;
  - a parity file with one byte flipped makes `createMaster` reject;
  - `choose` throws at 99 and 200 001 simulations, and on a terminal position;
  - `createMaster` rejects an endgame cap of -1, 1.5 or 10⁹ + 1, and `pnpm -F alphazero-bot web`'s
    check refuses a `shipped.json` without a cap or with one out of range ([T12-33]);
  - `load` refuses a malformed `pastdeal.json` and one fitted to another checkpoint, and the web
    check refuses a `pastDeal` that is not `null` or `{ sha256 }`, or names a file that is
    missing, does not match, or was fitted to another checkpoint ([T12-36]);
  - [T12-15]'s graph, by walking the imports of `web/settings.ts`.
- **[T12-29]** Each mutation below MUST have been seen to turn the named assertion red before
  that assertion is kept, made in a copy with its landing confirmed, and recorded beside the
  assertion.

  | Mutation | Must fail |
  | --- | --- |
  | `cpuct` and `fpu` passed to `load` in swapped order | [T12-27] |
  | `Seeded::new(1)` in place of `Seeded::new(0)` in `choose` | nothing. The search never reads the shuffler before a boundary ([0011 Z11-15]), and the check records that it stays green |
  | One field of `canonicalWords` in `web/` written out of order | [T12-14] |
  | The web crate calling `choose` instead of `choose_played` | [T12-3]'s source check |
  | The web crate calling `choose_memoised`, so the refinement is dropped | [T12-3]'s source check, and [T12-26]'s refinement case |
  | `load` passing an empty buffer for the refinement | [T12-26]'s refinement case |
  | `PastDeal::fitted_to` not comparing the checkpoint | [T12-28]'s refusal case |
  | `shippedFor` keeping the old master's refinement | [T12-36]'s new-master case |
  | A non-null `pastDeal` accepted without its match; a null one with no decision | [T12-36]'s cases |
  | A climb step accepted over budget taken as the next default; a rejected step not ending the climb | [T12-37]'s cases |
  | p99 checked against the p95 bound; the tripwire left out | [T12-25]'s budget case |
  | `shipped.json` naming `third/90` | [T12-10] |
  | The strongest read from pool ratings while the anchors exist | [T12-10]'s anchored cases |
  | `master` read as the strongest once the log names one | [T12-10]'s case for a log with a `ship` entry |
  | H0 and H1 swapped; the variance left out of the ratio | [T12-34]'s ratio case |
  | The cap read as accept; an early look's verdict undone by a later one | [T12-34]'s verdict case |
  | The seeds not doubled, so a seed is played from one seat | [T12-34]'s pairing case |
  | A rejected match counted as naming `master` | [T12-35]'s `master` case |
  | A ship entry's verdict, `master`, batches, cumulation or seeds not checked by the replay | [T12-35]'s cases in [0011 Z11-45]'s replay |
  | The replay letting a match play on after a look decided, or past the cap; or not holding its test and count to [T12-34]'s | [T12-35]'s cases in the replay |
  | A milestone with its own ship entry still owed one; a pin not settling the candidate it names; one below today's `master` owed one; a master with no rating skipped in silence | [T12-34]'s owed-match case |
  | The replay accepting `master` played against itself | [T12-35]'s cases in the replay |
  | The first worker's module importing `alphazero-bot/web` | [T12-21]'s graph check |
  | The web crate's player building its `SearchConfig` with `endgame_nodes: 0` | [T12-26]'s late-position case, and [T12-27] |
  | `load` passing a fixed cap to the player instead of its argument | [T12-26]'s late-position case |
  | `createMaster` passing 0 to `load` in place of the payload's cap | [T12-27] |
  | `pnpm -F alphazero-bot web` writing `ENDGAME_NODES = 0` into the payload | [T12-7]'s payload case, and [T12-27] |
  | `shippedMilestone` accepting a cap out of range | [T12-28]'s refusal case |

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
| [0011 Z11-77] | Amend its browser clause: the browser plays the proof at [T12-33]'s cap, from `shipped.json`, not from `playEndgameNodes`. Milestones, the pool and self-play stay search-only, unchanged. |

## Invariants

- `choose(position, n).action ∈ position.legalActions` for every non-terminal position and valid
  `n`.
- `choose(position, n).simulations === n` ([0011 Z11-18]).
- `choose(position, n)` is the same move every time for one payload: the endgame cap is fixed by
  it ([T12-33]), and neither the search nor the proof reads a clock ([0011 Z11-18]).
- A seating with no `master` seat constructs no master worker, and so loads no payload.
- At most one request is outstanding across both workers ([0006 W6-32]).

## References

- Intent [0010 — Playing the opponent we trained](../intent/0010-playing-the-opponent-we-trained.md)
- Intent [0009 — An opponent we train ourselves](../intent/0009-an-opponent-we-train-ourselves.md)
- Spec [0003 — Web interface](0003-web-interface.md): amended here
- Spec [0006 — Opponent in the interface](0006-opponent-in-the-interface.md): amended here
- Spec [0009 — Engine in Rust](0009-engine-in-rust.md): amended here, by one line of the toolchain
- Spec [0011 — AlphaZero training](0011-alphazero-training.md): the player itself, and amended here
