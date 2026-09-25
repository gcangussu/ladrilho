---
title: Engine in Rust
author: Gabriel Cangussu
date: 2026-09-25
status: draft
intent: 0007 — Rules engine in Rust
prefix: R9
depends-on: 0001 — Engine core, 0002 — Engine conformance vectors, 0007 — Scoring explained
summary: >
  A second implementation of the two-player Azul rules engine, as a synchronous
  Rust library crate in `packages/engine-rs`: which requirements of 0001, 0002
  and 0007 it adopts and how each reads in Rust, its own randomness, its public
  surface, the committed conformance vectors it replays in place, and the
  throughput gate it has to pass against the TypeScript engine. The rules
  themselves stay in 0001; this document does not restate them.
---

# Engine in Rust

## Scope

Covers `packages/engine-rs`: a Rust library crate that implements the rules of *0001 — Engine
core*, replays the conformance vectors of *0002 — Engine conformance vectors*, and reports round
scoring as *0007 — Scoring explained* specifies.

The rules are **not** restated here. 0001 remains the one description of what Azul is, and this
document says, requirement by requirement, which of 0001's, 0002's and 0007's apply to the crate
and what each one means in Rust ([R9-22]). A rule change is a change to 0001, and it binds both
engines.

Does not cover:

- **The TypeScript engine.** `packages/engine` is untouched by this work: no source, test, bench
  or vector in it changes to make the two engines agree. If the crate finds a case where the
  TypeScript engine is wrong, that is a fix under 0001 in its own right, made separately.
- **Any consumer.** No bot, interface or tool drives the crate yet. Bindings to JavaScript,
  WebAssembly, a native Node addon, or a command-line player are out of scope: the intent rules out
  the browser, and a Rust bot would be its own intent.
- **The fixtures.** The vectors, their format and their generator belong to 0002. The crate reads
  the committed files ([R9-15]) and owns none of them.
- **Comparing the two engines directly.** Driving both with the same random bag orders and moves
  would test far more positions than the recorded games hold, but agreement on the recorded games
  is this crate's bar. The direct comparison is its own intent, *0008 — Engines checked against
  each other*.

## Definitions

Terms from 0001 (colour, source, destination, lid, marker, ply, round), 0002 (vector, oracle,
canonical state) and 0007 (record, charged, forgiven, rung) keep their meanings unchanged. Added
here:

| Term | Meaning |
| --- | --- |
| **The crate** | The Rust library in `packages/engine-rs`, crate name `azul_engine`. |
| **The TypeScript engine** | `packages/engine`, as 0001 specifies it. |
| **Adopted** | A requirement of 0001, 0002 or 0007 that binds the crate as written. |
| **Rust reading** | An adopted requirement whose wording names a TypeScript construct, together with the Rust construct this document substitutes for it. The rule is unchanged; only its nouns are. |
| **Allocation** | A call into the global allocator. Stack use is not an allocation. |

Constants are 0001's, unchanged, and exported under the same names ([R9-14]).

## Package and toolchain

- **[R9-1]** The crate MUST live in `packages/engine-rs` as a single library crate named
  `azul_engine`, Rust edition 2024, with `publish = false`. Its toolchain MUST be pinned by a
  `rust-toolchain.toml` naming an exact stable release (`1.98.1` at the time of writing) with the
  `clippy` component, and `Cargo.lock` MUST be committed. Every `cargo` invocation the package
  scripts make MUST pass `--locked`.
- **[R9-2]** The directory MUST carry a `package.json` named `engine-rs`, so the pnpm workspace
  picks it up and the root `pnpm test` and `pnpm typecheck` include it. Its scripts MUST delegate
  to `cargo`:

  | Script | Runs |
  | --- | --- |
  | `test` | `cargo test --locked` |
  | `typecheck` | `cargo clippy --locked --all-targets -- -D warnings` |
  | `bench` | the throughput benchmark of [R9-18], release profile |
  | `compare` | the gate run of [R9-19] |

  *This makes a Rust toolchain a prerequisite of the root commands. That is accepted: the
  repository has one contributor, and a suite that only runs when someone remembers is the one
  0002 [V2-28] calls absent.*
- **[R9-3]** `[dependencies]` and `[build-dependencies]` MUST be empty. `[dev-dependencies]` MAY
  hold `serde_json` and nothing else, used by the harness to read vectors without `derive`
  macros. Adding any dependency, of any kind, is a change to this requirement.

### No async

- **[R9-4]** The crate MUST be synchronous throughout — library, tests, benchmarks and the
  compare tool alike. No `.rs` file under `packages/engine-rs` may contain an `async` function,
  block or closure, an `.await`, or an implementation of `Future`; and `Cargo.lock` MUST NOT
  contain a package named `tokio`, `async-std`, `smol` or `futures`, nor any whose name begins
  with `futures-` or `async-`.

  *The engine never waits on anything: a ply is a bounded computation over a few hundred bytes of
  state, and nothing in it does I/O. Async would add a runtime, a colouring of every signature and
  an executor to every test, and buy nothing. Parallelism, where a caller wants it, is threads
  ([R9-5]).*
- **[R9-5]** The crate MUST NOT spawn threads, block, sleep, or read a clock. `AzulState<Seeded>`,
  `Canonical`, `RoundScoring` and `IllegalAction` MUST be `Send + Sync`, asserted at compile time,
  so that a caller running many games in parallel does so with `std::thread` and owned states.
- **[R9-6]** The library MUST declare `#![forbid(unsafe_code)]`. The prohibition covers `src/`;
  the allocation-counting test of [R9-17] necessarily implements `GlobalAlloc` and sits in its
  own test target.
- **[R9-7]** No public function may panic for any argument value. Illegal or out-of-range
  actions, malformed snapshots and seat indices are all expressed as `Result`s or ruled out by
  their types. The fuzz run of [0002 V2-24] MUST additionally feed every `u8` value as an action
  to a sample of positions and assert that none panics and that every rejected one leaves the
  state unchanged. Seeds MUST be printed on failure.

## Data model

### The state

```rust
pub struct AzulState<S: Shuffler = Seeded> { /* private */ }
```

- **[R9-8]** Every field of `AzulState` MUST be private. Callers read a position through the
  accessors of [R9-14] and `to_canonical`; they change it only through `apply`,
  `apply_explained` and the two constructors. There is no way to edit a field directly, and
  therefore no `recount` ([0001 E1-5]): nothing outside the crate can invalidate a derived cache.
- **[R9-9]** `AzulState` MUST own no heap allocation. The bag is a fixed `[u8; 100]` with a
  length, every other field is a fixed-size array or a scalar, and `Clone` is a plain copy of
  those — which is what makes [0001 E1-48] hold structurally and [R9-17]'s `clone` clause
  possible. It MUST NOT derive `Copy`: an implicit copy of a game in progress is a bug waiting to
  be written.
- **[R9-10]** `AzulState` MUST implement `PartialEq` and `Debug`, and equality MUST compare every
  field, derived caches and the shuffler included.
- **[R9-11]** After every ply of every vector, rebuilding the state from its own snapshot —
  `AzulState::from_canonical(&s.to_canonical(), s.shuffler().clone())` — MUST yield a state equal
  to `s` under [R9-10]. This replaces 0002 [V2-21]: with no `recount` to heal a cache, the question
  "are the caches fresh?" becomes "does a from-scratch rebuild agree with the incrementally
  maintained state?", and equality over caches is what answers it.

### The snapshot

The Rust reading of [0001 E1-62]. The same fields as 0001's data model, in the same order, in
`snake_case`:

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Canonical {
    pub factories: [[u8; 5]; 5],   // per display, per colour
    pub center: [u8; 5],
    pub marker_in_center: bool,
    pub bag: Vec<u8>,              // storage order; the last element is drawn first
    pub lid: [u8; 5],
    pub walls: [[u8; 25]; 2],      // row-major, 0/1
    pub pl_color: [[i8; 5]; 2],    // -1 when the line is empty [0001 E1-4]
    pub pl_count: [[u8; 5]; 2],
    pub floor: [[u8; 5]; 2],
    pub floor_marker: [bool; 2],
    pub scores: [i32; 2],
    pub current_player: Player,
    pub first_player: Player,
    pub round_index: u32,
    pub tiles_left: u8,
    pub shuffles_used: u32,
    pub is_terminal: bool,
    pub exhausted: bool,
}
```

`Canonical` is a plain Rust value, not a serialisation: the crate has no JSON of its own ([R9-3]),
so 0001's key-order clause has nothing to bind. The harness compares a vector's parsed state
against `to_canonical()` field by field.

### Seats

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Player { P0 = 0, P1 = 1 }
impl Player { pub fn index(self) -> usize; pub fn other(self) -> Player; }
```

A seat is a type, not an integer, so a seat index of 2 cannot be written ([R9-7]).

## Randomness

The Rust reading of [0001 E1-61], and a replacement for [0001 E1-46] and [0001 E1-49].

```rust
pub trait Shuffler: Clone + PartialEq + core::fmt::Debug {
    /// Reorder `bag` in place. `index` is the state's `shuffles_used` at the moment of the call.
    fn shuffle(&mut self, bag: &mut [u8], index: u32);
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Seeded { /* private generator state */ }
impl Seeded { pub fn new(seed: u64) -> Self; }
impl Shuffler for Seeded { /* … */ }
```

- **[R9-12]** The shuffler is a type parameter of the state and is owned by it, so `clone` copies
  it with everything else. The engine MUST call `shuffle` exactly where [0001 E1-61] permits —
  once in `new_game` on the full bag, once per lid recycle ([0001 E1-33]) — pass the state's
  `shuffles_used` as `index`, and increment `shuffles_used` immediately after. An injected shuffler
  in a test replays `recorded[index]` and keeps no cursor; the seeded one advances its own
  generator, which the clone carries.

  *This is how the crate gets 0001's indexed seam without a function pointer or a shared
  reference: an injected shuffler is a pure function of `(bag, index)` carried by value, and the
  seeded one is a value with state. Both constructors take the shuffler itself, so a state is
  never without a source of randomness and the seed-alongside-a-shuffle of the TypeScript
  signatures has no counterpart here.*
- **[R9-13]** `Seeded` MUST be `xoshiro256**` seeded by running `splitmix64` over the `u64` seed
  to fill its four words, drawing bounded integers by Lemire's multiply-and-reject method on
  `u64`, and shuffling with Fisher–Yates descending (`for i in (1..n).rev() { swap(i, below(i + 1)) }`).
  All arithmetic MUST be on fixed-width integers, never `usize`, so a seed deals the same game on
  every platform. The suite MUST pin the algorithm with known answers: the opening bag of
  `new_game(Seeded::new(k))` for `k` in `0..3`, committed as literals in the test.

  *Deliberately not 0001's `xoshiro128**`. The intent does not ask the two engines to deal the
  same game from the same seed, and a generator that visibly differs keeps anyone from coming to
  depend on it by accident. **Seeds are not portable between the engines**: conformance is
  replay-based through the shuffle seam, exactly as it already is between the TypeScript engine
  and the oracle ([0002 V2-2]).*

## Interfaces

- **[R9-14]** The crate's public surface MUST be this listing, and the listing's names MUST be
  the ones exported:

```rust
// constants — 0001's, same names and values
pub const NUM_COLORS: usize;       pub const TILES_PER_COLOR: usize;  pub const NUM_TILES: usize;
pub const NUM_FACTORIES: usize;    pub const FACTORY_SIZE: usize;     pub const NUM_ROWS: usize;
pub const CENTER: u8;              pub const FLOOR: u8;               pub const ACTION_SPACE: usize;
pub const FLOOR_PENALTIES: [i32; 7];  pub const FLOOR_SLOTS: usize;   pub const CUM_PENALTY: [i32; 8];
pub const ROW_BONUS: i32;          pub const COL_BONUS: i32;          pub const COLOR_BONUS: i32;
pub const ENCODED_SIZE: usize;
pub const OFF_MY_WALL: usize; /* … every observation offset of 0001, same names [0001 E1-53] */

pub type Action = u8;
pub fn encode_action(source: u8, color: u8, dest: u8) -> Option<Action>;
pub fn decode_action(action: Action) -> Option<(u8, u8, u8)>;   // None when action >= 180
pub fn wall_col(color: u8, row: u8) -> u8;
pub fn wall_color_at(row: u8, col: u8) -> u8;

pub fn placement_value(wall: &[u8; 25], row: usize, col: usize) -> i32;   // [0001 E1-68]; 0 off the wall
pub fn wall_completed_rows(wall: &[u8; 25]) -> u8;                         // [0001 E1-70]
pub fn wall_completed_cols(wall: &[u8; 25]) -> u8;
pub fn wall_completed_colors(wall: &[u8; 25]) -> u8;

pub struct ActionList { /* fixed capacity, no allocation */ }
impl ActionList {
    pub fn as_slice(&self) -> &[Action];
    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IllegalAction { pub action: Action }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanonicalError { TilesLeftMismatch, OutOfRange, Inconsistent }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome { Player0 = 1, Draw = 0, Player1 = -1 }

impl AzulState<Seeded> {
    pub fn seeded(seed: u64) -> Self;                   // new_game(Seeded::new(seed))
}
impl<S: Shuffler> AzulState<S> {
    // construction
    pub fn new_game(shuffler: S) -> Self;
    pub fn from_canonical(c: &Canonical, shuffler: S) -> Result<Self, CanonicalError>;
    pub fn to_canonical(&self) -> Canonical;

    // actions
    pub fn legal_actions(&self) -> ActionList;
    pub fn is_legal(&self, action: Action) -> bool;
    pub fn apply(&mut self, action: Action) -> Result<(), IllegalAction>;
    pub fn apply_explained(&mut self, action: Action)
        -> Result<Option<RoundScoring>, IllegalAction>;

    // inspection
    pub fn current_player(&self) -> Player;
    pub fn first_player(&self) -> Player;
    pub fn scores(&self) -> [i32; 2];
    pub fn round_index(&self) -> u32;
    pub fn tiles_left(&self) -> u8;
    pub fn shuffles_used(&self) -> u32;
    pub fn is_terminal(&self) -> bool;
    pub fn exhausted(&self) -> bool;
    pub fn shuffler(&self) -> &S;
    pub fn outcome(&self) -> Option<Outcome>;
    pub fn floor_penalty(&self, p: Player) -> i32;
    pub fn completed_rows(&self, p: Player) -> u8;
    pub fn completed_cols(&self, p: Player) -> u8;
    pub fn completed_colors(&self, p: Player) -> u8;
    pub fn tile_census(&self) -> [u8; 5];

    // observation
    pub fn encode(&self) -> [f32; ENCODED_SIZE];
    pub fn encode_for(&self, p: Player) -> [f32; ENCODED_SIZE];
}

// the round-scoring record of 0007, same fields, snake_case
pub struct Placement    { pub row: u8, pub col: u8, pub h: u8, pub v: u8, pub points: i32 }
pub struct FloorCharge  { pub occupied: u8, pub rungs: &'static [i32], pub marker_held: bool,
                          pub penalty: i32 }
pub struct PlayerRound  { pub placements: Vec<Placement>, pub tiling: i32, pub floor: FloorCharge,
                          pub score_before: i32, pub score_after_round: i32, pub forgiven: i32 }
pub struct PlayerBonuses { pub rows: u8, pub cols: u8, pub colors: u8, pub row_points: i32,
                          pub col_points: i32, pub color_points: i32, pub total: i32,
                          pub score_before: i32, pub score_after: i32 }
pub struct RoundScoring { pub round: u32, pub players: [PlayerRound; 2],
                          pub bonuses: Option<[PlayerBonuses; 2]> }
```

  The record types derive `Clone, Debug, PartialEq, Eq`. `rungs` borrows a prefix of
  `FLOOR_PENALTIES` rather than copying it, which is [0007 S7-16] stated by the type.
  `placement_runs` is private, as in 0007. `render_text`, `to_json` and `from_json` have no
  counterpart ([R9-22]); `AzulState` MAY implement `Display` as a debugging aid.

  *A test can enforce the "MUST be this listing" half only as far as naming goes — it imports
  every name above, so a rename or removal fails to compile. It cannot see an extra export, and
  does not claim to.*

## Conformance

- **[R9-15]** The harness MUST read the vectors in place from `packages/engine/test/vectors`,
  resolved from `CARGO_MANIFEST_DIR`, and MUST replay every `*.json` file it finds there. It MUST
  fail if it finds none, and MUST NOT copy, vendor, rewrite or regenerate any of them: 0002
  [V2-9] names the one writer of that directory, and two copies of the fixtures would be two
  fixtures.

  *One consequence is intended: regenerating the vectors re-tests both engines, and a
  regeneration that the crate fails is read like any other diff 0002 [V2-11] produces.*

- **[R9-16]** A disagreement between the crate and a vector is the crate's bug. The TypeScript
  engine passes every vector (0002), and the oracle is authoritative for both. The crate's suite
  MUST report a mismatch with the vector's file name, the ply index, the action, and the first
  differing `Canonical` field.

## Allocation

- **[R9-17]** The following MUST NOT allocate: `legal_actions`, `is_legal`, `apply`, `clone`,
  `encode`, `encode_for`, `placement_value`, the three `wall_completed_*` functions, the
  inspection accessors, and `apply_explained` on a ply that does not end a round. It MUST be
  checked by a dedicated test target installing a counting `#[global_allocator]`, over complete
  seeded games and over every game vector, asserting a count of zero across each call.

  *This is 0007's [S7-4] made observable. In TypeScript it was a budget with a structural
  argument, because nothing could see an allocation; here a test can count them, so the
  requirement is a gate and not a hope. `new_game`, `from_canonical`, `to_canonical` and a
  round-ending `apply_explained` may allocate, and are not listed.*

## Performance

- **[R9-18]** `pnpm -F engine-rs bench` MUST measure, in the release profile and with
  `std::time::Instant` (no benchmarking crate, [R9-3]), the two figures the TypeScript bench
  reports: `legal_actions` + `apply` throughput in plies per second, over a seeded random game
  replayed from a clone of its opening state — the same shape as `packages/engine/bench` — and the
  cost of one `clone` of a mid-game position in nanoseconds. It MUST report the median of at least
  nine timed runs after discarding three warm-up runs, following 0007 [S7-40]'s protocol.
- **[R9-19]** `pnpm -F engine-rs compare` MUST run the TypeScript engine's bench and the crate's
  bench in one session on one machine, apply the same run-and-median protocol to both, and write
  `packages/engine-rs/bench/baseline.json`:

  ```jsonc
  {
    "date": "2026-09-25",
    "machine": { "os": "…", "arch": "…", "cpu": "…" },
    "typescript": { "pliesPerSecond": 1048931, "cloneNs": 530 },
    "rust":       { "pliesPerSecond": 0,       "cloneNs": 0 },
    "ratio": 0,                   // rust.pliesPerSecond / typescript.pliesPerSecond
    "passed": false               // ratio >= 5
  }
  ```

  Only a complete run writes the file; an interrupted or partial run MUST leave it alone.
- **[R9-20]** The crate MUST sustain at least **five times** the TypeScript engine's
  `legal_actions` + `apply` throughput, as measured by [R9-19]. The committed `baseline.json` is
  the evidence: the suite MUST assert that it exists, parses, that `ratio` equals the quotient of
  the two figures it records, that `passed` equals `ratio >= 5`, and that `passed` is true. The
  spec does not move to `implemented` until it is.

  *Measured on the day this was written, on the author's laptop (an Intel Core i7-1068NG7): the TypeScript engine replays an
  83-ply game 12 638 times a second — about 1.05 million plies per second — and clones a mid-game
  position in about 0.53 µs. The gate is a ratio on one machine, not an absolute figure, because
  only a ratio survives a change of laptop. Five is the floor of "many times"; there is no ceiling
  and no reason to expect one near it.*
- **[R9-21]** `cargo test`, excluding compilation, SHOULD finish in under 10 seconds, for the
  reason 0002 [V2-28] gives.

## Traceability

### How adoption is recorded

- **[R9-22]** Every requirement declared in `spec/0001-engine-core.md`,
  `spec/0002-engine-conformance-vectors.md` and `spec/0007-scoring-explained.md` MUST appear in
  exactly one row of the *Adopted requirements* table below, classified as exactly one of:

  | Class | Meaning | Must be cited by a crate test? |
  | --- | --- | --- |
  | `adopted` | Binds the crate as written. | Yes, or exempt |
  | `reading` | Binds the crate, with the Rust reading the row gives. | Yes, or exempt |
  | `replaced` | Superseded for the crate by the `R9` requirement the row names. | No — the `R9` one is |
  | `not adopted` | Does not apply to the crate, for the reason the row gives. | No |

  A scanner in the crate's suite MUST fail when a declared identifier is missing from the table,
  appears twice, carries any other class, or when the table names an identifier the three specs
  do not declare.

  *This is the drift guard. A requirement added to 0001 tomorrow fails the crate's build until
  someone decides, in writing, what it means for the second engine — which is exactly the decision
  that would otherwise be skipped.*
- **[R9-23]** Every `R9` requirement, and every identifier classed `adopted` or `reading`, MUST
  be cited by at least one test under `packages/engine-rs/tests` — by identifier, in a comment
  adjacent to the test or in its doc comment, since a Rust test name cannot hold brackets — or
  listed with a reason in *Traceability exemptions* below. The scanner MUST also fail on a
  citation of an identifier that does not exist and on an exemption naming one that no longer does,
  as 0002 [V2-27] does, and exemptions are held to 0002 [V2-31]: difficulty is not a reason, and
  a `MUST` about behaviour cannot be excused.
- **[R9-24]** The checks of [R9-4], [R9-13], [R9-17], [R9-22] and [R9-23] MUST each have been seen
  to fail, by the procedure `CLAUDE.md` sets out — mutate a copy made with `git archive`, confirm
  the mutation landed, watch that check go red — and the mutation MUST be recorded beside the test
  it justifies, naming the function and the line. [0007 S7-31] covers the record invariants the
  same way.

### Adopted requirements

The scanner reads every identifier in the first column and the class in the second.

| Requirement | Class | Rust reading, replacement, or reason |
| --- | --- | --- |
| [0001 E1-1] | adopted | |
| [0001 E1-2] | reading | The wall is `[u8; 25]`, row-major. |
| [0001 E1-3] | adopted | |
| [0001 E1-4] | reading | Internally any sentinel; `Canonical::pl_color` reports `-1`. |
| [0001 E1-5] | replaced | [R9-8] and [R9-11]. Fields are private, so no caller can invalidate a cache and there is no `recount`. |
| [0001 E1-6] | adopted | |
| [0001 E1-7] | reading | `encode_action` returns `None` outside the space and `decode_action` returns `None` for `180..=255`; the two are inverses over `0..180`. |
| [0001 E1-8] | not adopted | A process constraint on the shared encoding, carried by 0001. The crate is held to the encoding by the vectors, not by a promise. |
| [0001 E1-9], [0001 E1-10], [0001 E1-11], [0001 E1-12], [0001 E1-13] | adopted | |
| [0001 E1-14] | reading | `apply` returns `Err(IllegalAction)` instead of throwing, and leaves the state unchanged. |
| [0001 E1-15], [0001 E1-16], [0001 E1-17], [0001 E1-18], [0001 E1-19], [0001 E1-20] | adopted | |
| [0001 E1-21] | reading | `applyExplained` is `apply_explained`. |
| [0001 E1-22], [0001 E1-23], [0001 E1-24], [0001 E1-25] | adopted | |
| [0001 E1-26], [0001 E1-27], [0001 E1-28], [0001 E1-29], [0001 E1-30], [0001 E1-31] | adopted | |
| [0001 E1-32], [0001 E1-33], [0001 E1-34], [0001 E1-35] | adopted | |
| [0001 E1-36], [0001 E1-37], [0001 E1-38] | adopted | |
| [0001 E1-39] | reading | `outcome()` returns `Option<Outcome>`; `None` while unfinished. |
| [0001 E1-40] | reading | `tile_census()` returns `[u8; 5]`. |
| [0001 E1-41], [0001 E1-42], [0001 E1-43], [0001 E1-44], [0001 E1-45] | adopted | |
| [0001 E1-46] | replaced | [R9-13]: the crate's own generator, deliberately not 0001's. |
| [0001 E1-47] | adopted | |
| [0001 E1-48] | reading | `Clone` copies the shuffler with the state ([R9-9], [R9-12]). |
| [0001 E1-49] | replaced | [R9-13]. Seeds are portable neither to the oracle nor to the TypeScript engine. |
| [0001 E1-50] | reading | [R9-3] and [R9-5]: no dependencies; no filesystem, network, clock, environment or threads in `src/`. A source scan checks `src/` for `std::fs`, `std::net`, `std::time`, `std::env`, `std::thread` and `std::process`. |
| [0001 E1-51] | reading | Mutation is visible in the signatures: only `apply`, `apply_explained` and `Shuffler::shuffle` take `&mut`. The behavioural half — no ambient state — is a source scan of `src/` for `static mut`, `thread_local!`, `Cell`, `RefCell`, `OnceCell`, `Mutex`, `RwLock` and atomics. |
| [0001 E1-52] | not adopted | No JSON view: it exists for the interface and the worker boundary, and the crate has neither. |
| [0001 E1-53] | reading | `ENCODED_SIZE` and every offset exported as `pub const … : usize`, under 0001's names. |
| [0001 E1-54], [0001 E1-55], [0001 E1-56] | adopted | |
| [0001 E1-57] | not adopted | A process constraint on the shared layout, carried by 0001. |
| [0001 E1-58], [0001 E1-59], [0001 E1-60] | replaced | [R9-17], [R9-18] and [R9-20]. |
| [0001 E1-61] | reading | [R9-12]: the shuffler is a type parameter carried by value, and both constructors take it in place of a seed. |
| [0001 E1-62] | reading | `Canonical` of *The snapshot*. No key order, since nothing is serialised. `from_canonical` returns `Err(CanonicalError::TilesLeftMismatch)` rather than throwing. |
| [0001 E1-63], [0001 E1-64] | adopted | |
| [0001 E1-65] | reading | `new_game(shuffler)`; `current_player` and `first_player` are `Player::P0`. |
| [0001 E1-66] | adopted | |
| [0001 E1-67] | reading | `encode_for(p)` returns `[f32; 182]`; `encode()` equals `encode_for(current_player())`. |
| [0001 E1-68] | reading | `placement_value(&[u8; 25], row, col)`; allocation-free by [R9-17]. `placement_runs` is private. |
| [0001 E1-69] | not adopted | `fromJSON` is the bot's information barrier ([0004 B4-10]); the crate has no bot. |
| [0001 E1-70] | reading | `wall_completed_rows`, `wall_completed_cols`, `wall_completed_colors` over `&[u8; 25]`, called by the three per-player accessors. |
| [0001 E1-71] | not adopted | A tripwire over TypeScript source whose clauses name TypeScript forms. The crate holds the property behaviourally, through [0007 S7-30]'s corpus; its source half is [0007 S7-12], exempt below. |
| [0001 E1-72] | adopted | |
| [0002 V2-1] | adopted | |
| [0002 V2-2] | not adopted | A property of the committed files, which the crate reads unchanged ([R9-15]). |
| [0002 V2-3] | adopted | |
| [0002 V2-4] | not adopted | A property of the committed files. |
| [0002 V2-5] | reading | States are compared as `Canonical` values against the parsed vector state, field by field. |
| [0002 V2-6], [0002 V2-7] | adopted | |
| [0002 V2-8] | reading | The crate's suite runs with no network and no Python; `cargo test --locked` needs no fetch once the lockfile's one dev-dependency is cached. |
| [0002 V2-9], [0002 V2-10], [0002 V2-11], [0002 V2-12] | not adopted | The generator's obligations, owned by 0002. |
| [0002 V2-13], [0002 V2-14], [0002 V2-15], [0002 V2-16], [0002 V2-17] | not adopted | Coverage of the committed files, owned by 0002; the crate replays all of them ([R9-15]). |
| [0002 V2-18], [0002 V2-19], [0002 V2-20] | adopted | |
| [0002 V2-21] | replaced | [R9-11]. |
| [0002 V2-22], [0002 V2-23] | adopted | |
| [0002 V2-24] | reading | 200 games with `Seeded`, plus the action sweep of [R9-7]. |
| [0002 V2-25] | adopted | |
| [0002 V2-26], [0002 V2-27] | replaced | [R9-22] and [R9-23]. |
| [0002 V2-28] | replaced | [R9-21]. |
| [0002 V2-29], [0002 V2-30] | adopted | |
| [0002 V2-31] | replaced | [R9-23]. |
| [0002 V2-32], [0002 V2-33], [0002 V2-34] | not adopted | The generator's obligations, owned by 0002. |
| [0002 V2-35] | reading | The harness half only: a vector under 100 tiles without `"census": "short"` fails; with it, conservation is checked as invariance alone. |
| [0002 V2-36] | reading | `kind: "game"` starts with `new_game(recorded)`; `kind: "position"` with `from_canonical(&initial, recorded)`. |
| [0002 V2-37] | adopted | |
| [0002 V2-38] | reading | Each `f32` from `encode_for`, widened to `f64`, MUST equal the parsed JSON number exactly — the comparison the TypeScript harness makes. Exactness needs `serde_json`'s `float_roundtrip` feature: its default parser is not correctly rounded, and reads some recorded values one bit away. The encoder computes in `f64` and rounds to `f32` once, on store, as a `Float32Array` does. |
| [0007 S7-1] | reading | `apply_explained` returns `Result<Option<RoundScoring>, IllegalAction>`. |
| [0007 S7-2] | reading | `apply` returns `Result<(), IllegalAction>` and never a record. The type is the assertion; a test binds it to `()` so a change fails to compile. |
| [0007 S7-3] | reading | One private implementation with a `const EXPLAIN: bool` parameter — the degenerate sink — so the unexplained instantiation compiles the recording away. |
| [0007 S7-4] | reading | Observable in Rust, and gated by [R9-17]. |
| [0007 S7-5] | adopted | |
| [0007 S7-6] | reading | Nothing is added to `AzulState` or `Canonical`. |
| [0007 S7-7] | adopted | |
| [0007 S7-8] | reading | The record is an owned value; `rungs` borrows only `'static` data. |
| [0007 S7-9], [0007 S7-10] | adopted | |
| [0007 S7-11] | reading | A private `placement_runs` over the same two run scans `placement_value` uses. |
| [0007 S7-12] | adopted | |
| [0007 S7-13], [0007 S7-14], [0007 S7-15] | adopted | |
| [0007 S7-16] | reading | `rungs` is `&FLOOR_PENALTIES[..min(occupied, 7)]`. |
| [0007 S7-17], [0007 S7-18], [0007 S7-19], [0007 S7-20], [0007 S7-21], [0007 S7-22] | adopted | |
| [0007 S7-23], [0007 S7-24], [0007 S7-25], [0007 S7-26], [0007 S7-27] | adopted | |
| [0007 S7-28], [0007 S7-29], [0007 S7-30], [0007 S7-31] | adopted | |
| [0007 S7-32], [0007 S7-33] | adopted | |
| [0007 S7-34] | reading | Round-trips through `to_canonical` and `from_canonical` only; there is no JSON view. |
| [0007 S7-35] | not adopted | Widens the TypeScript tripwire of [0001 E1-71], not adopted above. |
| [0007 S7-36] | reading | Each record type is destructured exhaustively, without `..`, in a test; adding or removing a field fails to compile. |
| [0007 S7-37] | not adopted | Folded into [0007 S7-2]'s reading: in Rust the return type is the check. |
| [0007 S7-38] | not adopted | Concerns amendments to 0001 and 0003 that have landed. |
| [0007 S7-39] | replaced | [R9-23]. |
| [0007 S7-40], [0007 S7-41] | replaced | [R9-18] and [R9-20]. |
| [0007 S7-42], [0007 S7-43] | not adopted | Concern amendments to 0001 and 0003 that have landed. |

*0007 is adopted whole, which intent 0007 left to judgement ("if it comes easily"). It does: the
record is plain data, the sink is a generic parameter, and the invariants port unchanged. Should
that prove wrong, reclassifying the `S7` rows is a one-column spec change the scanner makes
visible — the intent is met without it.*

### Traceability exemptions

| Requirement | Why it is not testable |
| --- | --- |
| [0007 S7-3] | "Exactly one implementation" is a source property, as 0007's own exemption says. [0007 S7-28] and [0007 S7-29] catch a divergence in what the two paths do. |
| [0007 S7-12] | A source property. 0007 enforces it with [0001 E1-71]'s TypeScript tripwire, which is not adopted; in the crate it rests on [0007 S7-30]'s corpus, which fails the first time a second fusion rule produces a different number. A second copy that agrees everywhere the corpus reaches is the residue, stated plainly. |
| [R9-18], [R9-21] | Non-gating measurements, as [0001 E1-58] was. [R9-20] is the gate, and it is tested. |
| [R9-19] | A tool, not a behaviour of the crate. Its output is what [R9-20] asserts on. |

## Amendments

On landing, in the same change as the code:

- `spec/README.md` — this spec's row in the index (added as `draft` with this document).
- `CLAUDE.md` — the fifth package in *Project*, and `pnpm -F engine-rs test`, `bench` and
  `compare` in *Commands*.

Nothing in 0001, 0002 or 0007 is amended. The crate reads them; they do not know it exists.

## Open questions

- **The legal-action representation.** `ActionList` is fixed-capacity and sorted, to match
  [0001 E1-13]. A bitmask would be smaller and faster to build, but an ascending iterator over it is
  the same contract. Left to the benchmark: whichever [R9-20] needs.

## References

- Intent [0007 — Rules engine in Rust](../intent/0007-rules-engine-in-rust.md)
- Intent [0008 — Engines checked against each other](../intent/0008-engines-checked-against-each-other.md)
- Spec [0001 — Engine core](0001-engine-core.md)
- Spec [0002 — Engine conformance vectors](0002-engine-conformance-vectors.md)
- Spec [0007 — Scoring explained](0007-scoring-explained.md)
- `xoshiro256**` and `splitmix64`: Blackman and Vigna, [prng.di.unimi.it](https://prng.di.unimi.it/)
- Bounded integers: Lemire, *Fast Random Integer Generation in an Interval* (2019)
