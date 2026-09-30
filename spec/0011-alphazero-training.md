---
title: AlphaZero training
author: Gabriel Cangussu
date: 2026-09-29
status: implemented
intent: 0009 — An opponent we train ourselves
prefix: Z11
depends-on: 0001 — Engine core, 0005 — Opponent strength, 0009 — Engine in Rust, 0010 — Engines cross-checked
summary: >
  `packages/alphazero-bot`: a player trained from scratch by self-play on the
  Rust engine — its network, its search, the self-play and training loop, the
  milestones that measure it against `bot`'s tiers, the rule that stops
  training, and the gate against `sharp`. Amends 0009 by one test. Leaves the
  interface, the browser and `ai-bot` untouched.
---

# AlphaZero training

## Scope

Covers `packages/alphazero-bot`: the network and its input, the search, self-play, training, the
file formats that pass samples and weights between the Rust and Python halves, the milestone lane
that measures each checkpoint against `bot`, the rule that decides whether training goes on, the
gate against `sharp`, and the latency and throughput lanes.

Does not cover:

- **The interface.** Nothing here is offered as a difficulty setting, and nothing runs in the
  browser. Intent 0009 leaves both to a later intent, and with them the setting's name.
- **`bot`.** *0004 — Computer opponent* and *0005 — Opponent strength* are unchanged. `bot` is used
  only as the measuring stick, through the arena export of [0005 M5-32], exactly as `ai-bot`'s gate
  uses it ([0008 A8-30]).
- **`ai-bot`.** Nothing is taken from it: not its weights, its encoding, its search or its code
  ([Z11-3]). Its gate and its withdrawal stand as *0008* records them.
- **Repeatable training.** Intent 0009 rules it out. Self-play draws from seeded generators so a
  bug can be chased, but two runs of the loop are not required to produce the same network.
  What *is* repeatable is measurement: a given checkpoint plays the same moves on the same build
  ([Z11-24]), so every milestone result can be reproduced from the committed weights.
- **Committing.** The loop writes files a person commits. It never runs `git` ([Z11-34]).

### The shape of it

Three languages, each where it is strongest:

| Half | Language | Does |
| --- | --- | --- |
| Self-play and play | Rust, crate `azul_alphazero` | the search, the forward pass, self-play games, the player the lanes call |
| Training | Python, PyTorch | reads samples, trains, exports weights |
| Measurement | TypeScript | the milestone lane, the gate, the stop rule — driving `bot`'s arena |

Self-play is almost all of the compute: every move costs hundreds of network evaluations, and
PyTorch's per-call overhead would dominate a network this small. So the search and the forward
pass are Rust, on *0009*'s engine, which is what intent 0009 leans on it for. Training is batched
matrix work where PyTorch is hard to beat. Measurement is TypeScript because `sharp` is, and a
second copy of `sharp` would be a second answer to "how strong is it".

### The machine, and what it rules out

The machine of record is the author's laptop: an Intel Core i7-1068NG7, 4 cores and 8 threads,
32 GB, no GPU PyTorch can use. Two consequences are fixed here rather than discovered later:

- **Training is CPU-only.** The network is sized for that, and for [Z11-40]'s latency, which asks
  the same of the finished player.
- **PyTorch is pinned at 2.2.2**, the last release with a macOS x86_64 wheel. `ai-bot`'s tools
  run it beside NumPy 2 by never calling `tensor.numpy()`; the trainer needs that call, so it pins
  NumPy 1.26, which that build was compiled against. A move to other hardware lifts both pins, and
  intent 0009 says not to prepare for it now.

### Chance, and where the search stops

Within an Azul round nothing is random: both players see every tile in play, and every move is
deterministic. Chance enters once per round, when the displays are refilled from a bag whose order
nobody knows. The engine deals inside `apply` ([0001 E1-32]), so a search that continues past the
last move of a round is looking at a deal drawn from the bag's real order.

This search **stops at the round boundary** ([Z11-15]), as `bot`'s does ([0004 B4-6]), and values
the boundary with the network on a **pre-deal view** ([Z11-9]): the position as it stood after the
round was scored and before the displays were filled, with the bag and the lid as they were at
that moment. The value network is therefore trained to estimate the expected result over every
deal the bag could produce, which is exactly the quantity a boundary has, and the search never
reads a dealt tile. Nothing the player does depends on the bag's order, and [Z11-21] tests that
directly.

*The alternative, sampling a deal at the boundary and searching on, is what `ai-bot`'s original
does with its fixed guess at the deal. It buys lookahead into the next round at the price of
treating one guessed deal as the real one. Stopping at the boundary costs nothing in rounds that
end the game — those boundaries are terminal and exact — and elsewhere hands the question to the
network, which is what the network is for.*

## Definitions

Terms from *0001* (action, ply, round, seat, boundary), *0004* (tier) and *0005* (chooser, match,
result, winrate) keep their meaning.

| Term | Meaning |
| --- | --- |
| **Crate** | `azul_alphazero`, the Rust library and binary in `packages/alphazero-bot`. The engine crate, `azul_engine`, is always named as such. |
| **Trainer** | The Python program under `packages/alphazero-bot/train`. |
| **Lanes** | The TypeScript programs under `packages/alphazero-bot/eval`: milestone, gate, latency corpus, stop-rule simulation. The latency and throughput measurements themselves are commands of the crate. |
| **Observation** | `encode_for(p)` of [0001 E1-53] as `azul_engine` implements it: 182 `f32`. |
| **Boundary ply** | A ply whose `apply` resolves a round ([0001 E1-30] through [0001 E1-37]). |
| **Pre-deal view** | The input the network sees for a non-terminal boundary: the position between scoring and dealing ([Z11-9]). |
| **Network** | The function of [Z11-6]: observation and legal set to a policy over 180 actions and a value in `[-1, 1]`. |
| **Checkpoint** | One set of network weights, in the format of [Z11-11]. |
| **Generation** | One pass of the loop: self-play with the current checkpoint, then training, producing the next ([Z11-28]). |
| **Training round** | Intent 0009's term: the generations between two milestones. Not an Azul round. |
| **Milestone** | The end of a training round: the current checkpoint is measured, and the stop rule decides ([Z11-31]). |
| **Ladder** | `uniformRandom`, `greedy`, `steady` and `sharp` from `bot/arena`, in that order ([Z11-32]). |
| **Progress** | The sum of a milestone's winrates over the ladder, in `[0, 4]` ([Z11-33]). |
| **Shipped settings** | The architecture and simulation count the gate and latency lane measure ([Z11-25]). |

## Package

- **[Z11-1]** The package MUST live in `packages/alphazero-bot`, a pnpm workspace package named
  `alphazero-bot` whose one runtime dependency is the workspace package `engine`. It MAY declare
  `bot` as a devDependency; only the lanes and their tests may import it. Nothing in the package
  may import `ai-bot` or `ui`.
- **[Z11-2]** The crate MUST be named `azul_alphazero`, with its `Cargo.toml` at the package root,
  Rust edition 2024, `publish = false`, one library target and one binary target named
  `alphazero`. It MUST depend on `azul_engine` by path (`../engine-rs`). Everything that is the
  player — the network, the search, the pre-deal view, the sample, checkpoint and parity formats,
  self-play — MUST be written in the crate on the engine alone. General-purpose functionality MAY
  come from crates.io, and only from this list, which the source check of [Z11-47] holds the
  manifest to:

  | Section | Crates | For |
  | --- | --- | --- |
  | `[dependencies]` | `serde`, `serde_json` | `config.json` and the result files |
  | | `sha2`, `hex` | the parity corpus's hash ([Z11-12]), checkpoints' hashes in results |
  | | `rand`, `rand_xoshiro`, `rand_distr` | the crate's own generator and the Gamma draws behind the Dirichlet noise ([Z11-20]) |
  | | `clap` | the binary's arguments ([Z11-60]) |
  | `[dev-dependencies]` | `tempfile`, `proptest` | scratch directories; [Z11-22]'s property tests |

  `[build-dependencies]` MUST be empty. `rand` MUST be built without its default features, so
  nothing in the crate can reach the operating system's entropy or a thread-local generator: every
  random draw comes from a generator seeded by the crate. Adding a crate to the list is a spec
  change. `Cargo.lock` MUST be committed, every `cargo` invocation the package makes
  MUST pass `--locked`, and its `rust-toolchain.toml` MUST be byte-identical to
  `packages/engine-rs/rust-toolchain.toml`. It MUST satisfy [0009 R9-4] and [0009 R9-6] as though
  it were under `packages/engine-rs`: no async, `#![forbid(unsafe_code)]`.

  *The line is between the player and plumbing. A JSON reader, a hash, a Gamma sampler and an
  argument parser are well-established functionality whose hand-written versions would only be
  more code for the suite to trust; the forward pass stays hand-written because [Z11-10] fixes
  its summation order in the source, and a linear-algebra crate brings its own. The sampler is a
  library's, but [Z11-52] still holds it to the distribution the noise needs, whatever it is.
  The seed derivation of [Z11-20] and [Z11-26] — how a game's triple becomes its seeds — is the
  spec's, and stays in the crate.*

- **[Z11-3]** Nothing in the package may be derived from `ai-bot` or from the program it ports:
  no weights, no encoding table, no search code, no constants. A source check MUST fail on an
  import of `ai-bot`, on the path `packages/ai-bot`, and on the string `alpha-zero-general`
  anywhere in the package's sources.
- **[Z11-4]** `package.json` scripts:

  | Script | Runs |
  | --- | --- |
  | `test` | `cargo test --locked`, then the lanes' vitest suite |
  | `typecheck` | `tsc --noEmit`, then `cargo clippy --locked --all-targets -- -D warnings` |
  | `test:train` | the trainer's pytest suite, in its pinned environment |
  | `train init --run <name>` | [Z11-58] |
  | `train --run <name>` | the loop of [Z11-28]: starts or resumes a run |
  | `stop-simulation` | [Z11-56] |
  | `milestone <checkpoint>` | [Z11-31] on one checkpoint, printed, not logged |
  | `gate <checkpoint>` | [Z11-35], [Z11-61] |
  | `latency --run <name>` | [Z11-40], [Z11-57] |
  | `throughput --run <name>` | [Z11-53] |

  `milestone` and `gate` take a checkpoint at `milestones/<run>/<generation>/checkpoint.bin` and
  read the run and generation from that path; the checkpoint's header carries no run name. Where
  they read their settings depends on who calls them:
  - **Inside the loop** (step 5 of [Z11-28]), the milestone's log entry does not exist yet: it is
    appended after the gate runs, because it records the gate's outcome ([Z11-37]). Both read
    `runs/<name>/config.json`, the config that entry will copy ([Z11-25]).
  - **Started on their own**, the checkpoint MUST be a **logged** milestone — one with a
    `milestone` entry in `log.json` — and both read the settings from the config copied into that
    entry ([Z11-34]), never from `runs/<name>/`, which is git-ignored and may be gone. This is what
    makes a logged milestone reproducible from the repository alone. Logged, not committed:
    whether a file is committed is a person's act the lane cannot check, and a logged entry is.

  Two more, beside them: `latency-corpus` records [Z11-38]'s corpus, once and on purpose, as
  `bot`'s `corpus` records its own; and the loop takes `--until <generation>` to stop cleanly
  before a generation, for a smoke run. The lanes that play games take `--workers N`, the number
  of processes games are shared across ([Z11-31]), half the machine's threads by default.

  The root `pnpm test` and `pnpm typecheck` therefore include the crate and the lanes. They do
  **not** include `test:train`: it needs `uv` and a PyTorch install, and the parts of the trainer
  whose mistakes would reach play are checked from Rust instead ([Z11-13]).
- **[Z11-5]** The trainer's environment MUST be pinned in `train/requirements.txt`, compiled by
  `uv pip compile --generate-hashes --python-version 3.12 --python-platform x86_64-apple-darwin`
  from a `train/requirements.in` naming `torch==2.2.2` and `numpy==1.26.4`, so that every package
  it installs, transitive ones included, is pinned by version and by the hash of the wheel this
  machine installs. It MUST be built by a `venv.sh` in the manner of `ai-bot`'s tools,
  from binary wheels only, in `train/.venv`, which is git-ignored.

## The network

- **[Z11-6]** The network MUST compute, from an observation `x` (182) and a legal set:

  ```
  h      = relu(S · x + s)                        // stem: 182 → W
  repeat B times:
    h    = relu(h + B2 · relu(B1 · h + b1) + b2)  // residual block: W → W → W
  logits = P · h + p                              // policy: W → 180
  value  = tanh(v2 · relu(V1 · h + v1) + v2b)     // value: W → 64 → 1
  policy = softmax(logits restricted to the legal set); 0 elsewhere
  ```

  Every product is a dense matrix–vector product with a bias, in `f32`. `W` and `B` are the
  architecture, recorded in every checkpoint ([Z11-11]).

  *A residual MLP, because the observation is a flat vector with no spatial layout worth
  convolving: the wall is 5×5, but adjacency on it is the only structure, and the network can learn
  that from 25 inputs. No normalisation layers, so there is no train/eval difference for the two
  implementations to disagree about.*

- **[Z11-7]** The value is from the perspective of the seat whose observation it was given: `+1` a
  certain win for that seat, `-1` a certain loss, `0` a draw.
- **[Z11-8]** The network's input MUST be the observation of [0001 E1-53], unmodified except by
  [Z11-9]. The package MUST read its fields only through the offsets `azul_engine` exports; the
  trainer, which cannot import the engine, reads the few it needs from `train/layout.json`, written
  from the engine's exports and held to them by [Z11-65]. Training under [Z11-65]'s permutation
  presents the observation of a relabelled position, which is still an observation.

  *The first consumer of the observation seam CLAUDE.md describes, which is what [0001 E1-57]
  protects: from the first committed checkpoint on, a change to that layout invalidates a trained
  model that exists.*

- **[Z11-9]** The pre-deal view of the boundary ply from `before` to `after` (non-terminal) MUST be
  `after.encode()` with:
  - every display count `[126, 151)` and display flag `[151, 156)` set to 0;
  - tiles-left `[173, 174)` set to 0;
  - the bag colour counts `[163, 168)` set to `before`'s bag counts;
  - the lid colour counts `[168, 173)` set, per colour, to `after`'s bag plus `after`'s lid plus
    `after`'s displays, minus `before`'s bag;

  each count divided by 20, as the bag and lid fields are. The view is taken from
  `after.current_player()`, the seat that opens the next round.

  *Exact because the bag does not change during a round: it changes only when a deal draws from
  it. So `before`'s bag is the bag the deal started from, and everything else that is now in the
  bag, the lid or the displays was in the lid when scoring finished. The split matters. A deal
  empties the bag first, with certainty, and only then recycles the lid and draws from it at
  random ([0001 E1-33]). Two positions with the same bag-plus-lid total but a different split
  deal different distributions, and the network has to see which one it is in.*

- **[Z11-51]** The network's input MUST account for every tile. For each colour, the counts in the
  bag, the lid, the displays, the centre, both players' pattern lines, floors and walls, read back
  from the input by undoing each field's scaling and rounding to the nearest integer, MUST equal
  that colour's count in the state's own `tile_census()` — 20 for any state reachable from a new
  game, fewer for a posed position ([0001 E1-40]). For a pre-deal view the state is `after`. The
  crate MUST check this with a `debug_assert!` at every expansion and every pre-deal view, so every
  search the suite runs checks it at every position it expands.

  *Against the census, not the constant 20: [0001 E1-40] is stated as invariance on purpose,
  because posed positions — *0010*'s short starts, this spec's own hand-built tests — hold fewer
  tiles, and `play` accepts them.*

  *This is what lets the network weigh a move by the tiles it will need later. What can be dealt
  next round is the bag; when the bag holds fewer than 20 tiles, all of it will be, and the rest
  comes from the lid. What will join the lid when this round resolves is on the floors and in the
  lines that will not complete.
  What is out of play for the rest of the game is on the walls. The observation of [0001 E1-53]
  already carries all of it. This requirement makes it a property the suite checks, so no future
  change to the input, and no mistake in [Z11-9], can hide a tile from the network without failing
  a test.*

- **[Z11-10]** The forward pass MUST be deterministic: its summation order MUST be fixed in the
  source. That order MAY use a fixed number of independent lane accumulators combined in a fixed
  order, which is what lets the compiler vectorise a dot product without reassociating it. It MUST
  NOT allocate.

  *A single sequential accumulator also satisfies "fixed", and measured 7–12× slower than 16
  lanes on the machine of record. [Z11-53] is what keeps that from happening quietly.*

### Checkpoints

- **[Z11-11]** A checkpoint file MUST be, in little-endian throughout:

  | Field | Type | Content |
  | --- | --- | --- |
  | magic | 4 bytes | `AZ11` |
  | version | u32 | `1` |
  | input, width, blocks, policy, value hidden | 5 × u32 | `182, W, B, 180, 64` |
  | generation | u32 | the generation that produced it |
  | tensors | f32 | `S, s`, then per block `B1, b1, B2, b2`, then `P, p, V1, v1, v2, v2b` |

  Matrices are row-major, `[out][in]`, as PyTorch's `nn.Linear.weight` stores them. A
  checkpoint `x.bin`'s parity file ([Z11-12]) is `x.parity`, beside it. The crate MUST
  reject a file whose length differs from the one its header implies, whose magic or version is
  wrong, or whose input or policy size is not `182` or `180`, with an error naming the field.
- **[Z11-55]** The **parity corpus** MUST be 64 observations with their legal sets, taken from
  positions of recorded-seed games, written once by the crate and committed as
  `train/parity-corpus.bin`. Half of them MUST be pre-deal views. The crate MUST compile it in with
  `include_bytes!`, so a parity check needs only the checkpoint and its parity file. The crate
  writes it from an ignored test (`cargo test --locked --test corpus -- --ignored
  write_the_corpus`), and an ordinary test holds the committed file to what the generator writes,
  byte for byte: a corpus that drifted would orphan every parity file ever written. Its layout,
  little-endian:

  | Field | Type | Content |
  | --- | --- | --- |
  | magic, version | 4 bytes, u32 | `AZPC`, `1` |
  | count | u32 | `64` |
  | per entry | 182 × f32, then 23 bytes | the observation, then the legal mask of [Z11-27] |

- **[Z11-12]** Beside every checkpoint, checkpoint `0` included, the trainer MUST write a **parity
  file**, little-endian:

  | Field | Type | Content |
  | --- | --- | --- |
  | magic, version | 4 bytes, u32 | `AZPF`, `1` |
  | corpus | 32 bytes | the sha256 of the parity corpus it was computed on |
  | count | u32 | the corpus's count |
  | per entry | 180 × f32, then f32 | PyTorch's logits (illegal ones included), then the value |

  The crate MUST reject a parity file whose corpus hash is not that of the corpus it compiled in,
  with an error saying so, rather than reporting a parity mismatch.
- **[Z11-13]** The crate MUST refuse to load a checkpoint without its parity file, or one whose
  forward pass differs from the parity file, on any logit or value `r`, by more than
  `1e-4 · (1 + |r|)`. The check runs on every load, in every command.

  *Relative, because a correct export differs from PyTorch by accumulated rounding, which grows
  with the size of the activations: measured, 8e-6 on logits near 11 and 2e-4 on logits near 280.
  An absolute bound would one day reject a correct checkpoint in the middle of a run. A transposed
  matrix, a swapped tensor or a missed bias is an error of order one either way, and surfaces on
  the first load, with a number — in the root suite, which loads the committed fixture checkpoint
  and every committed milestone ([Z11-44]), without the trainer's environment.*

## The search

A PUCT search in the manner of AlphaZero. Each node holds, per legal action, a prior `P`, a visit
count `N` and a value sum `Q·N` from the perspective of the seat to move at that node, and its own
network value `V` from when it was expanded.

- **[Z11-14]** A simulation descends from the root by [Z11-16], applying each action to a `clone`
  ([0001 E1-48]). It stops at the first node that is new, terminal, or reached by a boundary ply.
  The leaf is valued:
  - **terminal**: `+1`, `-1` or `0` for the seat to move there, from `outcome` ([0001 E1-39]);
  - **boundary**: the network's value on the pre-deal view ([Z11-9]), from the seat that opens the
    next round;
  - **new**: the network on `encode()`, whose policy becomes the node's priors and whose value is
    the leaf's and the node's `V`.

  Terminal and boundary nodes are never expanded. Each MUST be valued once, on its first visit, and
  its value stored on the node and reused by every later visit.

  *Late in a round nearly every simulation ends at a boundary, so evaluating one on every visit
  would spend most of the search re-running the same forward pass.*

- **[Z11-15]** No node below a boundary ply may be expanded, and nothing the search computes may
  read a display, bag order or tile dealt by a boundary ply except through the pre-deal view.
- **[Z11-16]** At a node with visit total `Nₜ`, selection MUST take the legal action maximising

  ```
  u(a) = Q(a) + cpuct · P(a) · √Nₜ / (1 + N(a))
  ```

  with `Q(a)` of an unvisited action taken as `V − fpu`, where `V` is the node's own network value.
  The greatest `u` wins strictly, so ties go to the lowest action index.
- **[Z11-17]** Backup MUST follow `current_player`, never ply parity: a value is negated between a
  node and its parent exactly when their seats to move differ. A boundary ply can leave the same
  seat to move, which is [0004 B4-18]'s trap.
- **[Z11-18]** A search MUST run exactly its configured number of simulations. Expanding the root
  — one network call on the root's own observation, before the first simulation — is not a
  simulation, so the root's visits sum to exactly the configured number. Nothing in the crate's
  library may read a clock, so a search is never curtailed.
- **[Z11-19]** In play (the lanes, [Z11-24]) the search MUST start from an empty tree on every
  move, use no noise, and return the action with the most root visits, ties to the lowest index.
  Self-play MAY reuse the subtree of the move played.
- **[Z11-20]** In self-play the root's priors MUST be mixed with Dirichlet noise,
  `P' = (1 − ε) · P + ε · Dir(α)`, and the move MUST be sampled from the root visits raised to
  `1/τ` for the first `tempPlies` plies of the game and taken greedily after. The noise and the
  sampling MUST draw from a generator of the crate's own, and never from the state's shuffler,
  which [0001 E1-47] reserves for shuffles. The two MUST be seeded apart: the shuffler from the
  triple of [Z11-26], the crate's generator from the same triple mixed with a fixed constant, so
  the noise can never be the bag order read another way. The game MUST NOT resign.
- **[Z11-21]** Two states that differ only in the order of their bag and in their shuffler's seed
  MUST get identical root visits and value from a search in play mode.

  *The whole information barrier in one assertion, and it holds by construction if [Z11-15] does.
  Both differences matter: the bag's order decides the next ordinary deal, and the shuffler decides
  the order after a recycle. The eval lanes also hand the player only what `toJSON` shows
  ([0005 M5-2]); self-play has no such seam, so this is what keeps it honest.*

## Interfaces

```rust
/// What the search asks for a leaf. `Network` is the one production implementation; the suite
/// supplies others, such as one that counts its calls ([Z11-42]). A boundary is evaluated with
/// an empty legal set: its policy is not wanted.
pub trait Evaluator: Sync {
    fn evaluate(&self, observation: &[f32; ENCODED_SIZE], legal: &[Action],
                out: &mut Evaluation);                                            // [Z11-6]
}
impl<E: Evaluator + ?Sized> Evaluator for &E { /* … */ }

pub struct Network { /* immutable after load; Send + Sync, shared by reference across threads */ }
impl Network {
    pub fn load(checkpoint: &[u8], parity: &[u8]) -> Result<Network, LoadError>;  // [Z11-11], [Z11-13], [Z11-55]
    pub fn architecture(&self) -> (u32, u32);                                     // (W, B)
    pub fn generation(&self) -> u32;                                              // from the header
    pub fn forward(&self, x: &[f32; ENCODED_SIZE], logits: &mut [f32; 180]) -> f32; // raw logits, value
}
impl Evaluator for Network { /* … */ }
pub struct Evaluation { pub policy: [f32; 180], pub value: f32 }

pub fn pre_deal_view<S: Shuffler>(before: &AzulState<S>, after: &AzulState<S>)
    -> [f32; ENCODED_SIZE];                                                       // [Z11-9]

pub struct SearchConfig { pub simulations: u32, pub cpuct: f32, pub fpu: f32 }
pub struct SelfPlayNoise { pub alpha: f32, pub epsilon: f32 }
pub struct SearchResult { pub action: Action, pub visits: [u32; 180], pub value: f32 }
/// The finished tree by kind: expanded nodes (the root included), non-terminal boundaries,
/// terminals. What [Z11-42]'s once-per-node case counts evaluator calls against.
pub struct TreeStats { pub expanded: u32, pub boundaries: u32, pub terminals: u32 }

pub fn choose<S: Shuffler, E: Evaluator>(net: &E, root: &AzulState<S>, config: &SearchConfig)
    -> Option<SearchResult>;                                                      // [Z11-19], [Z11-62]
/// `choose` with self-play's noise, and the tree's shape. `choose` is this with no noise.
pub fn search<S: Shuffler, E: Evaluator>(net: &E, root: &AzulState<S>, config: &SearchConfig,
    noise: Option<(&SelfPlayNoise, &mut Rng)>) -> Option<(SearchResult, TreeStats)>;
```

*The legal set is a slice, not `azul_engine`'s `ActionList`, because an `ActionList` can only
come from `legal_actions()` — its constructor is private to the engine — and the only one a
boundary could hand over is the dealt position's, whose legal set reads exactly the displays
[Z11-15] keeps from the search.*

- **[Z11-62]** `choose` MUST return `None` for a terminal root, which has no legal actions, and
  MUST NOT call the evaluator for it. `play` answers a terminal position with an error exit naming
  it; the latency lane skips terminal positions and reports how many it skipped.

The binary's commands, each loading one checkpoint and one run's settings:

| Command | Does |
| --- | --- |
| `alphazero play <checkpoint> --config <file> --search play\|milestone` | reads one position from stdin, writes one answer to stdout ([Z11-23]) |
| `alphazero selfplay <checkpoint> --config <file> --generation G --games N --out <file>` | [Z11-26] |
| `alphazero latency <checkpoint> <corpus> --config <file> [--simulations N]` | [Z11-40], [Z11-57] |
| `alphazero throughput <checkpoint> --config <file>` | [Z11-53] |

- **[Z11-60]** Every command MUST take the run's `config.json` and build its `SearchConfig` from it
  in one function, the only place in the crate that reads search settings. `--search` chooses the
  simulation count: `play` for `playSimulations`, `milestone` for `milestoneSimulations`; `selfplay`
  and `throughput` use `selfPlaySimulations`, the noise settings and `threads`. `--simulations`
  overrides the count for `latency` alone, which is how [Z11-57] steps it; every other command
  refuses it.

- **[Z11-22]** No public function and no command may panic on any input. A malformed position,
  checkpoint or corpus is an error exit with a message. The one exception is a debug build's
  census check of [Z11-51]: `pre_deal_view` is meaningful only when `after` is `before` with a
  boundary ply applied, and a debug build asserts that its view then accounts for every tile. A
  release build — the binary every lane runs — does not assert.
- **[Z11-23]** `play` reads one position as the canonical block of [0010 C10-8], in the word
  framing of [0010 C10-12], builds the state with `from_canonical(&block, Seeded::new(0))`, and
  writes the action, the simulations run, the root value's `f32` bits and the search's own
  milliseconds, rounded to a whole number, as four words. It holds no state between invocations.
  The timing is read by the command around `choose`, not by the library ([Z11-18]).
- **[Z11-24]** Given the same checkpoint, the same config, the same `--search` and the same
  position, `play` MUST return the same action and value on the same build, on every run.

## Self-play and training

- **[Z11-25]** A run's settings MUST live in one file, `runs/<name>/config.json`, fixed once
  generation `0` starts ([Z11-58]), and copied into every milestone record. The shipped settings
  are its `width`, `blocks` and `playSimulations`. *Starting values* lists the first run's.
- **[Z11-26]** `selfplay` MUST play its games with `threads` threads over one shared `Network`,
  each game on `AzulState<Seeded>` seeded from the triple (the config's `seed`, the generation
  `G`, the game's index). The config's `seed` MUST be chosen at random by `train init` and
  recorded there. Each game MUST emit:
  - one **move sample** per ply: the observation, the legal set, the root visits, and the game's
    result from the seat to move;
  - one **boundary sample** per non-terminal boundary ply: the pre-deal view and the result from
    the seat that opens the next round, with no policy target.

  *The generation is in the seed because without it game `i` of every generation deals the same
  bag order: the run would train on the same 500 openings, twenty generations deep in the window,
  for its whole life, and nothing would say so.*
- **[Z11-27]** A sample file MUST be a sequence of fixed-size little-endian records:

  | Field | Type | Content |
  | --- | --- | --- |
  | kind | u8 | `0` move, `1` boundary |
  | result | i8 | `+1`, `0`, `-1` |
  | observation | 182 × f32 | the observation or the pre-deal view |
  | legal | 23 bytes | a 180-bit mask, action `a` at bit `a % 8` of byte `a / 8`; all zero for a boundary sample |
  | visits | 180 × u16 | root visits; all zero for a boundary sample |

- **[Z11-28]** The loop MUST, per generation `g`:
  1. run `selfplay` with checkpoint `g` for `gamesPerGeneration` games, unless generation `g`'s
     sample file is already complete;
  2. measure checkpoint `g`'s losses on those samples before training on them ([Z11-54]);
  3. train on the samples of the last `window` generations for `stepsPerGeneration` steps,
     starting from checkpoint `g`'s weights and generation `g`'s optimiser state;
  4. write the optimiser state as its own file for generation `g + 1`, never overwriting
     generation `g`'s, then checkpoint `g + 1` and its parity file, then the manifest
     `generations/<g + 1>.json` naming all three with their sha256. The manifest is the commit
     point: a generation without one is incomplete, and its step 3 runs again;
  5. if `g + 1` is a multiple of `milestoneEvery` and the log has no entry for it, run the
     milestone of [Z11-31] on checkpoint `g + 1` and act on its decision;
  6. advance the run's generation counter.

  A run's directory holds `config.json`; `state.json`, the generation counter and the time the
  run started, whose existence is what "generation `0` has started" means ([Z11-40]);
  `checkpoints/<g>.bin` and `.parity`; `optimiser/<g>.pt`; `samples/<g>.bin`;
  `generations/<g>.json`; `losses.json`; and `throughput.json`.

- **[Z11-58]** `train init --run <name>` MUST create the run's directory, write `config.json` with
  `playSimulations` unset and a random `seed`, and write checkpoint `0` — the network at
  initialisation — with its parity file, generation `0`'s optimiser state (fresh), and manifest.
  `--augment none|displays` sets [Z11-65]'s setting; `--from` starts the run from another's
  checkpoint instead ([Z11-66]).
  The latency lane ([Z11-57]) and the throughput lane ([Z11-53]) then run on checkpoint `0`, and the
  latency lane writes `playSimulations` into the config, lowering `milestoneSimulations` to it if
  it is smaller ([Z11-59]). While it is
  unset, `alphazero latency` MUST require `--simulations`, which [Z11-57]'s search supplies at
  every step, and `play --search play` MUST refuse to run. `train --run <name>` MUST refuse to
  start generation `0` until both have passed; from then on the config is fixed.
- **[Z11-66]** `train init --run <name> --from <parent>:<g>` MUST start a run from generation `g`
  of another run: its config is the parent's with a fresh `seed`, its own `augment`, and `from`
  recording the parent, `g`, the sha256 of the parent's checkpoint `g`, the parent generations
  whose samples start the window, and the run whose latency record holds. Checkpoint `0` MUST be
  the parent's checkpoint `g` with its generation relabelled `0` and a parity file of its own, and
  generation `0`'s optimiser state the parent's at `g`. While the run has fewer than `window`
  generations of its own, step 3 of [Z11-28] MUST fill the window with the parent's latest
  generations before `g`, linked into `runs/<name>/inherited/`, and the losses of [Z11-54] name
  them. `playSimulations` and `milestoneSimulations` come with the parent's config: the latency
  lane refuses the run, and the loop's check of [Z11-58] reads the latency record `from` names.
  Its first milestone starts afresh ([Z11-33]) like any run's.

  *A run is a fixed experiment ([Z11-25]), so a change to how training works is a new run; but a
  new run need not relearn what the last one learned. Starting from its weights, its optimiser
  and its window changes one thing at a time, and the parent's log stays the baseline. The
  architecture is the parent's, so the latency its record measured still holds, and a gate
  measures latency again on the checkpoint it tests ([Z11-35]). The weights are still ours, so
  intent 0009's "from scratch" holds for the lineage; `from` is how the record says so.*

- **[Z11-29]** Training MUST minimise, per batch, the policy cross-entropy against the root visits
  normalised to a distribution (move samples only), plus the squared error of the value against
  the result (all samples), a boundary sample's value term weighted by `boundaryWeight`. The policy
  MUST be the masked softmax of [Z11-6], so illegal actions carry no loss. Weight decay MUST be
  applied by the optimiser alone, once, and not also written into the loss.
- **[Z11-65]** A run's config MAY set `augment` to `displays`; absent means `none`. With
  `displays`, every sample drawn for a training step ([Z11-28] step 3) MUST be trained on under a
  permutation of the five displays drawn uniformly at random for it, from a generator of its own so
  the draws are the same as without augmentation: display `i` of the permuted sample holds display
  `perm[i]`'s colour counts `[126, 151)` and flag `[151, 156)`, and every action from display `i`
  takes the legal bit and the visits of the same colour and destination from display `perm[i]`.
  The centre, the result and every other field are unchanged. [Z11-54]'s `before` losses MUST be
  measured on the samples as written, unpermuted, so they stay comparable across runs. The layout
  the trainer permutes by (`train/layout.json`), and a fixture of positions encoded by the engine
  before and after permuting their displays in the state itself (`train/tests/fixtures/displays.json`),
  MUST be written by `pnpm -F alphazero-bot augment-fixtures`, and the lanes' suite MUST fail when
  either differs from what the engine gives now. The trainer's suite MUST check the permutation
  against the fixture, observation and legal mask both, on cases that change which displays are
  empty.

  *The displays are interchangeable: relabelling them is the same position, the same result, and
  the same search with its visits relabelled. So each sample stands for up to 120, at the cost of
  a reshuffle per batch and no search. It was left out of run `first` so that a bug in it could
  not be mistaken for a bug in training; `first`'s losses then showed the value head fitting its
  own samples at 0.34 and fresh ones at 0.92, the memorising this counters. It adds no game
  results, so it cannot answer the open question of too few value labels on its own.*

- **[Z11-30]** Everything a run writes MUST live under `packages/alphazero-bot/runs/<name>/`, which
  is git-ignored, except the files of [Z11-34], [Z11-35] and [Z11-40], which are written where
  those requirements say, to be committed. Every file the loop or the crate writes MUST be written to a
  temporary name and renamed when complete, so a partial file is never read. Stopping the loop at
  any moment and running `train --run <name>` again MUST continue from the first step of [Z11-28]
  whose output is not on disk.
- **[Z11-54]** For each generation the trainer MUST record, in `runs/<name>/losses.json`, keyed by
  generation so that a step run again replaces its record rather than adding a second: the
  policy and value losses of checkpoint `g` on generation `g`'s own samples before training on them
  (step 2 of [Z11-28]), the mean training losses over the generation's steps, and the **draw
  ratio**: samples drawn in the generation's training over samples in the window. (A sample's
  **reuse**, the number of times it is drawn over its whole life in the window, is the draw ratio
  times `window`.) Each milestone entry MUST carry the records of the generations since the
  previous milestone.

  *The loss on samples the network has not trained on yet is the cheapest overfitting detector
  there is, and it is the first thing to look at when milestones stall.*

## Milestones and the stop rule

Intent 0009: "at milestones during training, the new player plays a batch of games against" `bot`,
"starting with 'ruthless'", and "if two training rounds in a row don't improve how it plays against
ruthless, we stop."

This spec reads "how it plays against ruthless" as progress over the whole ladder, of which
`sharp` is the top rung. `sharp` is played at every milestone. But for most of a run every
milestone loses to `sharp` almost every game, and a rule that looked at `sharp` alone would see no
movement and stop a run that is learning quickly. Summing the ladder lets early milestones register
the progress they make against the weaker rungs; once those saturate, the sum moves only with
`sharp`, and the rule is the intent's as written.

- **[Z11-31]** A milestone MUST play the checkpoint, with the shipped architecture and
  `milestoneSimulations` simulations a move, against each rung of the ladder over the first 100
  seeds of [0005 M5-16]'s wide list, one single-seed `match` per seed with seats alternated, as
  [0008 A8-30] plays its gate. `sharp` and `steady` play at their shipped budgets with the
  fail-safe out of reach ([0005 M5-8]). The player is a chooser that runs
  `alphazero play --search milestone` once per move on `toCanonical(fromJSON(position, 0))`,
  reporting `nodes = simulations`, `depth = 0`, `complete = false`, `curtailed = false`. Games MAY
  run in parallel processes; each game's result does not depend on it.
- **[Z11-32]** Every rung MUST be played at every milestone.

  *A rung played only when the one below it clears a bar makes progress jump by `sharp`'s whole
  winrate when `steady` reads 0.51 rather than 0.49, which is noise.*

- **[Z11-59]** `milestoneSimulations` MUST be fixed for the life of a run and MUST NOT exceed
  `playSimulations`. Only the gate plays at `playSimulations`.

  *Milestones measure whether training is working, and for that they need to be comparable with
  each other, not to be the finished player. At the shipped count a move costs up to 1.5 s
  ([Z11-57]); a milestone is 400 games of about 36 of the player's moves each, about 6 CPU-hours
  on the player's side plus `sharp`'s, which is two to three hours on four cores — as long as the
  self-play it measures. At 800 simulations the player's side is a fraction of that, and a
  milestone is bounded by `sharp`'s own moves: under an hour. Each milestone records its own wall
  time ([Z11-34]), so the figure is measured, not assumed. The price is that a milestone measures a
  player weaker than the one the gate measures. That is why [Z11-33]'s `done` always goes through
  the gate, and why the gate is triggered below the bar it tests ([Z11-33], [Z11-61]).*

- **[Z11-33]** Progress is the sum of the ladder's winrates. Within one run, a milestone
  **improves** when its progress is at least the progress of the milestone before it. Every
  comparison of progress, here and in [Z11-37], MUST be made on the sums rounded to nine decimals,
  never on floating-point sums as they fall: `1 + 0.59 + 0.255 + 0.045` is `1.8899999999999997`
  and `1 + 0.55 + 0.3 + 0.04` is `1.8900000000000001`, and run `first` stopped at generation 160
  on that last bit until its entry was corrected. Winrates are multiples of 1 / (2 · games), so
  nine decimals lose nothing. A milestone
  **starts afresh** — it improves by definition, and no earlier gate failure is carried into it —
  when it is the first of its run, the first after an override ([Z11-36]), or the first measured
  against a different `bot` than the milestone before it ([Z11-63]). The decision MUST be:

  | Condition, checked in order | Decision |
  | --- | --- |
  | the gate is due — which requires a `sharp` winrate of at least 0.50 ([Z11-37]) — and the gate of [Z11-35] then passes | `done` |
  | it does not improve, and neither did the milestone before it | `stop` |
  | otherwise | `continue` |

  The gate is **due** unless the run's **most recent** failed gate since the last fresh start ran
  at a milestone whose progress is at least this milestone's. Only the most recent failure counts:
  comparing against every earlier failure would make the bar the maximum of noisy readings, the
  ratchet the note below rejects. A `continue` or `stop` whose `sharp` winrate reached 0.50 records
  whether the gate ran, and if it did, that it failed, with its numbers.

  *0.50, not the gate's 0.60, because the milestone plays at `milestoneSimulations` and the gate
  at `playSimulations` ([Z11-59]): a checkpoint that reads 0.55 at the milestone's count may clear
  0.60 at the shipped one, and a trigger at 0.60 would let the stop rule end a run whose finished
  player already meets the intent. That is the costliest mistake the loop could make. The cost
  is gate runs of three to four hours each, and without the "due" clause a run sitting near 0.50
  would pay one at nearly every milestone: a true 0.45 reads 0.50 or more over 100 games about
  18% of the time. With it, a gate runs again only after progress has moved past the last failure,
  and the simulation below puts the mean at under two gates a run.*

  *Against the previous milestone, not the best one: the best of several noisy measurements is
  biased upward, and a bar that ratchets on luck stops improving runs. Simulated — each rung
  binomial over 100 games, `sharp` climbing from 0.30 to 0.60 while the rungs below stay
  saturated — the rule as first drafted (best earlier milestone, margin 0.05) stopped a run
  gaining 0.03 a milestone before it reached 0.60 every time, and a real plateau no faster than
  that. This rule's figures are in the table below, produced by the committed simulation of
  [Z11-56].*

  The model: 100 games a rung; `random` and `greedy` at 1.0 and `steady` at 0.95; the player at
  `playSimulations` 0.05 stronger against `sharp` than at `milestoneSimulations`; the gate 200
  games, passing at 0.60, its null left out. A climbing run starts at 0.30 against `sharp` at the
  milestone count and is followed until it reaches 0.60 there; where `stop` and `done` do not sum
  to 1, the rest of the runs were still going when the simulation stopped following them.

  | `sharp` at the milestone count | P(`stop`) | P(`done`) | mean gates run |
  | --- | --- | --- | --- |
  | climbs 0.05 a milestone, 7 milestones | 0.07 | 0.74 | 1.7 |
  | climbs 0.03 a milestone, 11 milestones | 0.31 | 0.56 | 1.7 |
  | climbs 0.02 a milestone, 16 milestones | 0.58 | 0.35 | 1.4 |
  | flat at 0.45 (0.50 shipped), 5 / 10 milestones | 0.37 / 0.71 | 0.00 / 0.00 | 0.7 / 0.9 |
  | flat at 0.55 (0.60 shipped), 5 / 10 milestones | 0.12 / 0.19 | 0.73 / 0.77 | 1.4 / 1.4 |

  *These are the committed simulation's figures, 20 000 runs a row, exactly as
  `pnpm -F alphazero-bot stop-simulation` prints them. They replaced a first simulation's, made
  while revising this spec, and differ from it by at most 0.03. They were last rerun when the
  rule began comparing progress at nine decimals: before that, a tie that floating-point summation
  put a last bit apart counted against the run, which raised P(`stop`) by up to 0.03. A flat 0.45 is `done` a few times in a thousand, not never:
  a true 0.50 at the shipped count clears 120 of 200 about 0.3% of the time.*

  *Read honestly, the intent's rule still stops a slow run more often than not: at 0.02 a
  milestone, two non-improving milestones in a row are likely from noise alone, and doubling the
  games buys little, because a plateau is stopped by the same coin flips at any sample size. The
  early trigger is what rescues a run that is already good enough: flat at a shipped 0.60, three
  runs in four end `done` rather than `stop`. The remaining remedy is the person: every `stop`
  names its numbers ([Z11-34]), and [Z11-36] lets them continue. The 0.05 gap between the two
  simulation counts is an assumption the first milestones and gates will measure.*

- **[Z11-56]** The simulation behind [Z11-33]'s table MUST be committed as
  `eval/stop-rule-simulation.ts`, runnable by `pnpm -F alphazero-bot stop-simulation`, and MUST
  call the two functions of [Z11-37] themselves rather than a copy of the rule, with the gate
  modelled as the table states. A change to the rule
  MUST rerun it and update the table in the same change.
- **[Z11-34]** `packages/alphazero-bot/milestones/log.json` MUST be a list of entries, each with a
  `kind`, a run and a date:

  | Kind | Written by | Also records |
  | --- | --- | --- |
  | `milestone` | the loop, step 5 of [Z11-28] | everything below, and the decision |
  | `override` | the loop, [Z11-36] | the reason given |
  | `manual-gate` | a gate started on its own, when it passes ([Z11-61]) | the gate result's path, and the decision `done` |

  A `milestone` entry records: the generation, the wall-clock time since the run started, the
  milestone's own wall-clock time, the games and samples so far, the config, the simulation count
  `play` reported for every move (which MUST all equal `milestoneSimulations`), every rung's
  `Result` fields of [0005 M5-6], the progress, the previous milestone's progress, whether it
  started afresh and why, whether the gate was due and ran, the losses of [Z11-54], the provenance
  of [Z11-63], the decision, and a **reason**: one sentence naming the numbers the decision was
  taken on. The per-move simulation counts are recorded as a histogram, count to moves, which is
  every move's count without fourteen thousand copies of one number. Each milestone MUST also
  write its checkpoint and parity file to `milestones/<run>/<generation>/`. The loop MUST print the reason when it stops. The loop MUST NOT
  run `git`; committing the milestone is a person's act.
- **[Z11-63]** Every `milestone` entry and every gate result MUST record its **provenance**:
  - the repository's commit;
  - whether any **source path** had uncommitted changes, where the source paths are the ones hashed
    below; `packages/alphazero-bot/src`, `eval` and `train`; the package's `Cargo.toml`,
    `Cargo.lock` and `rust-toolchain.toml`; and `packages/engine-rs/src` with its own
    `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml`, since the player's every move — in
    self-play and in `play` — is made on `azul_engine` ([Z11-2]). The loop's own outputs —
    `milestones/`, `gate/`, `latency/` and `runs/` — are not source paths, so the files the loop
    writes and a person has not yet committed never mark a build dirty;
  - the **ladder hash**: the sha256 over every file under `packages/bot/src` and
    `packages/engine/src`, the four arena files that play — `packages/bot/arena/chooser.ts`,
    `match.ts`, `seeds.ts` and `index.ts` — and `packages/alphazero-bot/eval`'s chooser adapter,
    computed as the sequence, in ascending byte order of repository-relative path,
    of each path, a NUL byte, the file's length as a decimal string, a NUL byte, and its contents.

  Those paths are what decide how the ladder plays: the tiers, `greedy`, `uniformRandom` and
  `match` live in `bot`, and every one of them plays through the TypeScript engine, whose
  legal-move order and rules change `sharp`'s play as surely as its own search does. A milestone
  whose ladder hash differs from the previous milestone of its run starts afresh ([Z11-33]) and
  says so in its reason. The rest of `packages/bot/arena` — the audit corpus and its generator
  ([0005 M5-31]) — is left out on purpose: it measures `bot`, it does not play, and regenerating it
  deliberately must not force a fresh start.

  *Intent 0009 measures against "ruthless" as it is at the time, and `ai-bot`'s history is the
  reason this is written down: a fix to `sharp` moved that gate from 0.72 to 0.45
  ([0008 A8-33]). Without this, a `sharp` change landing mid-run would have the stop rule compare
  progress across two opponents with nothing in the log to show it, and "every milestone result
  can be reproduced" would lack the build it needs.*
- **[Z11-35]** The gate MUST play the checkpoint against `sharp` over all 200 wide seeds, and the
  null — the checkpoint against itself over the same seeds — exactly as [0008 A8-31] does, and pass
  when the winrate is at least 0.60, the null is below 0.60, and a latency measurement of **the
  gated checkpoint itself** at `playSimulations` passes [Z11-40]'s budget, run by the gate and
  recorded inside the gate's result. That latency pass MUST run alone, after every game of the gate
  has finished, never alongside them. Every gate, passing or failing, run by the loop or by hand,
  MUST write its own result, `packages/alphazero-bot/gate/<run>/<generation>.json`, in the manner
  of [0008 A8-32], with the checkpoint's sha256 and the provenance of [Z11-63]. A second gate of
  the same checkpoint writes `<generation>-2.json` and so on; no gate result is ever overwritten.

  *One file per gate, because a single `result.json` would let a failing manual gate of an old
  checkpoint erase the pass that ended a run — and the later intent that offers this player in the
  interface will gate on exactly that pass, as [0008 A8-33] does.*

  *The gate is the expensive lane, and deliberately rare: 200 games against `sharp` and 200 in
  which both seats are the player at up to 1.5 s a move, plus a latency pass of about 50 minutes —
  on the order of three to four hours. It runs only when a milestone has already reached 0.50, and
  again only once progress has passed the last failure ([Z11-33]).*
- **[Z11-36]** After a `stop`, the loop MUST refuse to continue the run unless given
  `--override "<reason>"`, which it MUST record in the log as an entry of its own before the next
  generation runs. The milestone after it starts afresh ([Z11-33]).

  *The rule decides by default and a person can overrule it; either way, the log says why. Without
  the fresh start an override would buy exactly one milestone, compared against the one that had
  just stopped.*

- **[Z11-61]** `gate <checkpoint>` MAY also be run by hand on any milestone's checkpoint. A
  passing manual gate MUST append a `manual-gate` entry for that run to the log ([Z11-34]), naming
  the gate's numbers as its reason, and the loop MUST refuse to continue a run whose log holds a
  `done`. A failing manual gate writes its result file ([Z11-35]) and nothing else: it MUST NOT
  append to the log or change the run's decisions.

  One lock, `packages/alphazero-bot/.lock` (git-ignored), MUST be held for as long as they run by
  the loop, by an independently started gate, and by the `latency` and `throughput` lanes, whatever
  run each serves. Each MUST refuse to start while another holds it, naming the process that does.
  The lock MUST record its holder's process ID and that process's start time, and MAY be taken over
  only when no process with that ID and start time exists, so a reused ID never makes a stale lock
  look live. The lock is taken by the entry points alone — the `pnpm` scripts and the loop — and
  never by the crate's commands, so a command run inside a locked entry point (the gate's latency
  pass, the loop's self-play) never meets its own lock. The loop's own gate (step 5 of [Z11-28])
  runs under the loop's lock, in process or with the lock handed down, and does not check it; only
  a gate started on its own does.

  *One lock for the package, not one per run, because what it protects is shared: `log.json` holds
  every run's entries, and an idle machine ([Z11-40]) is idle for every run at once. Two reasons,
  either sufficient. The latency passes need a machine running nothing else, which a machine
  running self-play is not. And both the loop and a gate append to `log.json`: writing to a
  temporary name and renaming prevents a torn file, not a lost update, and two read-modify-write
  cycles interleaved would drop an entry.*

- **[Z11-37]** The milestone lane's decision logic MUST be two pure functions, exported from the
  lanes and tested there, so the rule the log applies is the rule the suite checks:
  - `due(entries, results)`: whether the gate is due, from the run's earlier log entries and this
    milestone's results. It includes every condition for running the gate: it is false whenever
    the milestone's `sharp` winrate is below 0.50, so row 1 of [Z11-33]'s table reads "the gate is
    due and then passes", and the recorded "gate was due" means the same thing at every
    milestone;
  - `decide(entries, results, gate)`: the decision, where `gate` is the gate's outcome, or absent
    when it was not due or not reached.

  The loop calls `due`, runs the gate if it says so, then calls `decide`. `override` entries enter
  both only as fresh starts; `manual-gate` entries end the run and are never passed to either.

## Latency and throughput

Intent 0009: on an ordinary modern processor, "half of its moves take under 3 seconds and all but
one move in a thousand take under 5". This spec holds the player to 3 seconds at the 95th
percentile rather than the median, which is stricter and implies the intent's figure.

- **[Z11-38]** The latency corpus MUST be at least 2000 positions, recorded once and committed as
  `packages/alphazero-bot/latency/corpus.bin`: every position of `steady`-against-`steady` games
  from recorded seeds, in the block format of [Z11-23], in order.
- **[Z11-39]** Latency depends mostly on the shipped settings and only slightly on the weights:
  with values cached on terminal and boundary nodes ([Z11-14]), how many simulations reach the
  network depends on where the tree goes. The run's measurement is made on checkpoint `0`
  ([Z11-58]), and a run MUST NOT start unless that record exists and meets [Z11-57]'s half-budget
  target. The gate measures again, on the checkpoint it gates, against [Z11-40]'s full budget, and
  writes that measurement into its own result ([Z11-35]), never into the run's latency record.

  *Measuring before training is the point: a network too big to meet the budget is discovered in
  minutes rather than after days of training it. Measuring again at the gate is what makes the
  claim about the finished player rather than about an untrained one.*

- **[Z11-40]** `alphazero latency` MUST time `choose` on every corpus position, single-threaded,
  release build, from the position handed in to the action returned, excluding process start and
  checkpoint load. The `latency --run <name>` lane MUST write the run's record,
  `packages/alphazero-bot/latency/<name>.json`, with the settings, the checkpoint's sha256, the
  machine, the count measured and the count of terminal positions skipped ([Z11-62]), p50, p95,
  p99, p99.9 and max, where pN is the value at rank `⌈N/100 · n⌉` of the sorted times, and
  `passed: p95 < 3000 ms && p99.9 < 5000 ms`. It MUST be run with the machine otherwise idle, as
  [0009 R9-19] is. Once the run's generation `0` has started, the lane MUST refuse to run for that
  run: the record and `playSimulations` are fixed with the config ([Z11-25]).

  *Over 2000 positions p99.9 is the third-largest time. With a fixed simulation count a move's
  cost barely varies, so in practice it is the machine's noise that p99.9 measures, which is what
  the intent's "all but one in a thousand" is guarding against.*

- **[Z11-57]** `playSimulations` MUST be a multiple of 100 whose full measurement meets **half**
  the budget on the machine of record — p95 at most 1500 ms and p99.9 at most 2500 ms — and whose
  next multiple up was measured and seen to miss it. The lane MUST keep every full measurement it
  takes for a run, with its count, p95 and p99.9, in `runs/<name>/latency-measurements.json`, across
  attempts. It MUST find the count as follows:
  - **Start.** With at least three kept measurements, fit a Theil–Sen line (the median of pairwise
    slopes, then the median intercept) to p95 against the count and another to p99.9, solve each
    for half the budget, and start at the lower crossing rounded down to a multiple of 100. With
    fewer, time the corpus at a small count, predict per simulation, and start at the largest
    multiple of 100 whose predicted p95 is under 1200 ms.
  - **Gallop.** Measure the start. Step away from it in the direction of the verdict — up if it
    met half the budget, down if not — by 100, 200, 400, … until the verdict flips, never below 100.
  - **Bisect.** Between the highest count that met it and the lowest that missed, measure the
    multiple of 100 nearest the middle, rounding down, until they are 100 apart.
  - **Outliers.** A measurement that misses half the budget on p99.9 alone MUST be measured once
    more at the same count, and the second pass decides.

  The record is the full measurement at the count it settles on, with the measurement of the count
  above it beside it, the prediction the search started from, and every measurement the search
  took, in order, as `passes`. The record states both verdicts: whether the half-budget target was met, and
  whether [Z11-40]'s budget passed.

  *Two things pull against each other. 800 simulations measured about 0.07–0.5 s a move against a
  3 s budget, and `sharp` takes up to 2 s: unused time is strength left on the table. But the
  intent asks for an "ordinary modern processor", and the machine of record is one laptop. Tuning
  to half the budget spends most of the available strength and leaves a machine twice as slow
  inside the intent's limits. The prediction only chooses where to start: the gallop and bisection
  make the count one that the next count up was seen to exceed, rather than one a guess happened to
  pick. Each full pass takes 20–30 minutes on the machine of record, so the search's cost is its
  number of passes. The first run's lane stepped by 100 from a probe that guessed 8500, measured ten
  passes over three hours, and stopped at 9300 on a p99.9 of 2606 ms at 9400 whose p99 was 1262 ms:
  one busy moment, not the search's cost growing. Theil–Sen ignores such a pass when fitting, and a
  second pass keeps it from deciding the verdict. A miss on p95 is not remeasured, though the second
  attempt showed one can be spoiled too: 11400 measured p95 1516 ms beside 1319 ms at 11300 while
  the machine was in use, so the lane settled at 11300 where the edge lies somewhere below 11800, the
  lowest clean miss. That errs by at most a few percent of simulations, toward the budget. The count is still not claimed to
  be the largest: a count further up could pass where the next one missed.*

- **[Z11-53]** `alphazero throughput` MUST measure, release build, network evaluations per second
  single-threaded and self-play games per hour at the run's `threads`, and write
  `runs/<name>/throughput.json` with the implied minutes of self-play per generation. A run MUST
  NOT start unless that figure is at most `maxGenerationMinutes`.

  *Self-play speed, not latency, decides whether a run finishes this year. A generation is about
  500 games × 73 plies × 200 simulations, 7.3 million evaluations: about 18 minutes on four cores
  at a sequential accumulator's speed, about 3 with lanes.*

## Starting values

The first run's `config.json`, each setting under the key the table names. These are recorded,
not required: [Z11-25] makes the file the record, and a later run MAY change any of them.

| Setting | Value | |
| --- | --- | --- |
| `width`, `blocks` | 256, 4 | about 640 000 weights, 2.5 MB a checkpoint |
| `seed` | random, chosen by `train init` | [Z11-26] |
| `playSimulations` | set by [Z11-57] | the shipped setting |
| `selfPlaySimulations` | 200 | |
| `milestoneSimulations` | 800 | [Z11-59]; lowered to `playSimulations` if that is smaller |
| `cpuct`, `fpu` | 1.25, 0.25 | |
| `alpha`, `epsilon` | 0.3, 0.25 | |
| `tempPlies`, `tau` | 10, 1 | `τ` |
| `gamesPerGeneration` | 500 | about 37 500 samples |
| `window` | 20 generations | |
| `stepsPerGeneration`, `batch` | 1000, 512 | draw ratio about 0.68; reuse about 14 |
| `boundaryWeight` | 1 | boundary samples are about 7% of the data |
| `optimiser`, `momentum`, `learningRate`, `weightDecay` | `"sgd"`, 0.9, 0.02, 1e-4 | |
| `milestoneEvery` | 10 generations | |
| `threads`, `torchThreads` | 8, 4 | self-play's threads, and the trainer's |
| `maxGenerationMinutes` | 30 | [Z11-53] |

## Amendments

- **[Z11-41]** These amendments MUST land in their specs in the same change as the code that needs
  them, as [0008 A8-47] required of its own.

### To 0009 — Engine in Rust

| Requirement | Amendment |
| --- | --- |
| New, [0009 R9-25] | The crate's suite MUST include a case that encodes a state immediately after a boundary ply whose deal recycled the lid, and asserts that the unscaled display, bag and lid fields, with walls, pattern lines and floors, account for all 100 tiles ([0001 E1-40]). |

*CLAUDE.md's new-caller rule. [0001 E1-53]'s observation has had no production caller in Rust;
the pre-deal view ([Z11-9]) reads its display, bag and lid fields at exactly the boundary where a
recycle rearranges them, and the vectors assert the encoding without ever asserting what it
counts.*

CLAUDE.md's sentence "Neither bot consumes it today" about the observation seam becomes false with
this package, and MUST be corrected in the same change.

## Invariants

- `choose(...)` is `None` exactly at a terminal root ([Z11-62]); otherwise its action is legal at
  the root, and `Σ visits = simulations` ([Z11-18]).
- No terminal or boundary node has children, and each was valued once ([Z11-14], [Z11-15]).
- Every input the network is given accounts for every tile of its state's census ([Z11-51]).
- Every sample's `result` is in `{-1, 0, 1}`, and a move sample's visits are zero outside its legal
  mask ([Z11-27]).
- Every committed checkpoint loads, parity included ([Z11-13]).
- `milestones/log.json` only grows.

## Verification

- **[Z11-42]** The crate's suite MUST assert, with a network whose weights are all zero (uniform
  policy, value 0):
  - [Z11-18]: visits sum to the simulation count, and the root's expansion is one evaluator call
    that is not among them;
  - [Z11-62]: a terminal root gives `None` without an evaluator call;
  - [Z11-16]: on a position where every action is a tie, the chosen action is the lowest legal one;
  - [Z11-14]: on a hand-built position where one move ends the game in a win and the rest do not,
    the search chooses it within 200 simulations; and, late in a round, with an `Evaluator` that
    counts its calls, that the total equals the number of nodes the finished tree holds that were
    valued by the network (expanded nodes, the root included, plus non-terminal boundary nodes;
    a game-ending boundary is valued by `outcome` and never reaches the network), however many
    times each was visited. The count is per node, not per observation: two boundary nodes reached
    by transposed move orders can share a pre-deal view, the search keeps no transposition table,
    and correct code evaluates each;
  - [Z11-17]: on a hand-built position whose boundary ply leaves the same seat to move, the value
    backed up to the root has the sign of that seat's terminal result;
  - [Z11-21]: over positions taken from recorded games, including positions one ordinary deal and
    one recycle away, every bag permutation and shuffler seed tried gives identical visits — with
    a **non-zero** network too, since zero weights would make the pre-deal view invisible.
- **[Z11-43]** The crate's suite MUST assert:
  - [Z11-9] on a boundary whose deal recycled the lid, one whose deal did not, and one that
    emptied bag and lid ([0001 E1-34]), each against counts worked out by hand;
  - [Z11-51] by running searches with debug assertions on over positions from recorded games,
    recycles included, and over posed short-census positions, so the `debug_assert!` runs at every
    expansion against censuses of 20 and of fewer;
  - [Z11-12] and [Z11-55]'s layouts by reading the committed corpus and the fixture's parity
    file, and a parity file naming another corpus's hash rejected with the corpus error;
  - [Z11-26] by running `selfplay` for two generations of 16 games with the same config and
    checking that all 32 opening deals are pairwise distinct;
  - [Z11-60] by running `play` with each `--search` on a config whose `playSimulations` and
    `milestoneSimulations` differ, checking the simulation count each reports, and that
    `--simulations` is refused by every command but `latency`;
  - [Z11-11]'s rejections field by field, [Z11-22] by feeding `play` truncated and malformed
    blocks, [Z11-24] by running `play` twice, and [Z11-27]'s layout by writing a sample and reading
    it back.
- **[Z11-52]** The crate's suite MUST test the Dirichlet sampler at `α = 0.3` with 2, 20 and 50
  components, and at `α = 2` with 20. Over 100 000 draws each:
  - every draw sums to 1 within `1e-5`, and no component is negative or NaN;
  - each component's **variance** is within 10% of `(1/k)(1 − 1/k)/(kα + 1)`.

  *The variance is the check that sees α. A symmetric Dirichlet's means are `1/k` for every α, so
  a test of means passes whatever the sampler does to the noise's shape. The realistic bug —
  drawing the Gammas at `α + 1`, which is also what a Gamma sampler's small-shape branch yields
  without its `U^(1/α)` factor — gives `Dir(α + 1)`: noise too flat, which does not crash and
  quietly explores less. At `α = 0.3`, `k = 20` the true variance is 0.00679 and the bug's is
  0.00176, far outside 10%. The Gamma draws are `rand_distr`'s ([Z11-2]); this test is what
  holds them, and the crate's normalising, to the noise the spec asks for.*

- **[Z11-44]** The crate's suite MUST load the **fixture checkpoint** and every checkpoint under
  `milestones/`, which runs [Z11-13]'s parity check on each. The fixture is a small checkpoint
  (`W = 16`, `B = 1`, random weights) with its parity file, exported by the trainer once and
  committed as `test/fixtures/checkpoint.bin` and `test/fixtures/checkpoint.parity`, so the check
  has something to fail on from the first commit, before any run exists.
- **[Z11-45]** The lanes' suite MUST assert [Z11-33]'s decision on hand-written logs covering each
  row of the table, the "neither did the milestone before it" boundary, a milestone equal to the one
  before it, the first milestone of a run, a second run in the same log, [Z11-36]'s override, a
  milestone at 0.50–0.60 whose gate passes and one whose gate fails, a later milestone above 0.50
  whose progress has not passed the failed gate's (no gate) and one whose progress has (gate), two
  failed gates where only the more recent one counts, a fresh start clearing a failed gate,
  a ladder hash change starting afresh ([Z11-63]), and [Z11-61]'s manual gate passing and failing.
  It MUST assert [Z11-63]'s hash against a hand-built directory with a known digest, that changing
  one byte of a file under each hashed path changes it, and that a file written under
  `milestones/` leaves the dirty flag clear.
  It MUST also assert [Z11-61]'s lock: while one entry point holds it, a second refuses and names
  the holder; a lock recording a process that no longer exists is taken over; and a lock recording
  a live process ID with a different start time is taken over too.

  It MUST replay the committed `log.json`: every entry parses and has a known `kind`; each
  `milestone` entry's gate-was-due and decision equal what `due` and `decide` return on the
  entries before it and its own recorded results and gate outcome; each `override` follows a
  `stop` of its run; each `manual-gate` names a gate result file that exists and passed; and no
  entry for a run follows a `done`. Every committed gate and latency result MUST parse and have
  `passed` verdicts that agree with the numbers it records.
- **[Z11-46]** The trainer's suite (`test:train`) MUST assert that a checkpoint it exports is read
  back by `alphazero` with parity, that a sample file written by the crate's test is read with
  every field intact, that [Z11-29]'s loss is unaffected by the logits of illegal actions, and that
  weight decay is applied once.
- **[Z11-47]** A source check MUST cover [Z11-1], [Z11-2] — its list of crates included — and
  [Z11-3], each clause run against a source it exists to reject, and MUST fail on a clock read
  (`Instant`, `SystemTime`) anywhere in the crate's library, which is everything under `src/`
  except `src/main.rs` and the modules only it declares.
- **[Z11-48]** Each mutation below MUST have been seen to turn the named assertion red before that
  assertion is kept, made in a copy with its landing confirmed, and recorded beside the assertion.

  | Mutation | Must fail |
  | --- | --- |
  | The boundary leaf valued on `encode()` instead of the pre-deal view | [Z11-21], with the non-zero network |
  | The pre-deal view's bag set to bag plus displays, lid left as it is | [Z11-43]'s recycle case |
  | The pre-deal view zeroes the displays without moving them anywhere | [Z11-51] |
  | Boundary values recomputed on every visit | [Z11-42]'s once-per-node case |
  | Values negated by ply parity | [Z11-17]'s case |
  | `>` replaced by `>=` in selection | [Z11-16]'s tie case |
  | The Gammas drawn at `α + 1` instead of `α` | [Z11-52]'s variance clause |
  | The Dirichlet draw not normalised | [Z11-52]'s sum clause |
  | One tensor read transposed | [Z11-13], via [Z11-44]'s fixture |
  | The generation left out of the self-play seed | [Z11-43]'s two-generation case |
  | The seed triple combined by adding, `seed + G + index` | [Z11-43]'s two-generation case |
  | The census check against the constant 20 | [Z11-43]'s short-census case |
  | Boundary samples not emitted | [Z11-43]'s sample case |
  | The stop rule comparing against the best milestone instead of the previous one | [Z11-45] |
  | An override not resetting the comparison | [Z11-45] |
  | The gate due at every milestone above 0.50, ignoring the last failure | [Z11-45] |

- **[Z11-49]** Every requirement in this document MUST be either cited by at least one test — Rust,
  TypeScript or Python — by identifier, or listed with a reason in *Traceability exemptions*,
  enforced as [0004 B4-59] enforces it.
- **[Z11-50]** `cargo test` and the lanes' suite together SHOULD finish in under 30 seconds.
- **[Z11-64]** The crate's `[profile.test]` MUST keep debug assertions on with optimisation at
  `opt-level = 2`, so the searches of [Z11-42] and [Z11-43] run [Z11-51]'s check at a speed that
  fits [Z11-50]. The source check of [Z11-47] MUST read `Cargo.toml` and fail if either setting is
  absent or different.

### Traceability exemptions

| Requirement | Why it is not testable here |
| --- | --- |
| [Z11-5] | The trainer's environment; exercised by `test:train`, which the root suite does not run. |
| [Z11-25], [Z11-28], [Z11-30], [Z11-54], [Z11-58], [Z11-59] | The loop is run on purpose, over days. Its outputs are what [Z11-44] and [Z11-45] check. |
| [Z11-29], [Z11-46] | The trainer's own suite, outside the root suite ([Z11-4]). |
| [Z11-31], [Z11-35], [Z11-38], [Z11-40], [Z11-53], [Z11-57] | Lanes that take minutes to hours. The committed gate and latency results are read by [Z11-45]; throughput is a run's own file. |
| [Z11-39] | A process promise about when a run may start; the loop enforces it, nothing observes it. |
| [Z11-41] | A process promise about what lands in which commit. |
| [Z11-50] | A `SHOULD` about the suite's own runtime. |
| [Z11-56] | A simulation run on purpose; its figures are the table in [Z11-33]. |

## Open questions

- **Is the outcome alone enough of a value target?** Azul's result is a margin as much as a win,
  and a second value head predicting the final score difference is a common, cheap way to give an
  early network more signal. It would change [Z11-6] and [Z11-29], not the search. Worth trying if
  the first milestones stall.
- **Should the input spell out what the next deal can hold?** [Z11-9] and [Z11-51] guarantee the
  network can work out, per colour, what the next deal will certainly hold and what it might. They
  do not hand it over. A few extra inputs per colour would cost almost nothing, but they would
  make the input more than [0001 E1-53]'s observation, and they are worth adding only if a trained
  network turns out to misjudge moves that depend on a later round.
- **Are 500 games a generation too few value labels?** Every sample of a game shares its one
  result, about 75 correlated samples to a label, and each is drawn about 14 times. The losses of
  [Z11-54] are what would show it; more games per generation or a shorter window are the remedies.
- **Should self-play permute the displays?** Answered by [Z11-65], in training rather than
  self-play: run `second` tests it, started from run `first` ([Z11-66]).
- **Will committed checkpoints outgrow the repository?** At 2.5 MB each and a milestone every ten
  generations, twenty milestones is 50 MB. If that becomes a problem, keeping only the log and the
  best checkpoint is the fallback, which [Z11-44] would then cover.

## References

- Intent [0009 — An opponent we train ourselves](../intent/0009-an-opponent-we-train-ourselves.md)
- Intent [0006 — A learned opponent](../intent/0006-a-learned-opponent.md) — the 0.60 bar
- Spec [0001 — Engine core](0001-engine-core.md) — the observation, the boundary, `outcome`
- Spec [0004 — Computer opponent](0004-computer-opponent.md) — the tiers measured against; unchanged
- Spec [0005 — Opponent strength](0005-opponent-strength.md) — the arena, the wide seeds, the Wilson bound; unchanged
- Spec [0008 — Expert opponent](0008-expert-opponent.md) — the gate's shape; nothing else
- Spec [0009 — Engine in Rust](0009-engine-in-rust.md) — the engine self-play runs on; amended here
- Spec [0010 — Engines cross-checked](0010-engines-cross-checked.md) — the canonical block and framing `play` reads
- Silver et al., *A general reinforcement learning algorithm that masters chess, shogi, and Go
  through self-play*, Science 362 (2018) — the method
