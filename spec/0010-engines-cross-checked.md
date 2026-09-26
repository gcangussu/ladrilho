---
title: Engines cross-checked
author: Gabriel Cangussu
date: 2026-09-25
status: accepted
intent: 0008 — Engines checked against each other
prefix: C10
depends-on: 0001 — Engine core, 0002 — Engine conformance vectors, 0007 — Scoring explained, 0009 — Engine in Rust
summary: >
  A tool in `packages/crosscheck` that plays invented games through the
  TypeScript engine and the Rust crate with the same bag orders and the same
  moves, compares everything each engine says after every ply, and writes the
  first disagreement as a replayable report. Also how a disagreement is
  settled: the order of authority, the register of rulings, and how a settled
  one becomes a permanent vector — recorded from the Python oracle, corrected
  in the open where the oracle is wrong. Amends 0001, 0002 and 0009.
---

# Engines cross-checked

## Scope

Covers `packages/crosscheck`: the driver that plays games, the checker that replays them on the
Rust crate, the ply record they both produce, the steering of play, the disagreement report, and
the suite that keeps the tool honest. Covers, too, what happens after a disagreement: who decides
([C10-26]), where the decision is written ([C10-27]), and how it becomes a vector that both
engines replay from then on ([C10-29] through [C10-34]).

Does not cover:

- **The rules.** They stay in *0001 — Engine core*. A ruling that changes or clarifies a rule does
  so by amending 0001 ([C10-28]), and [0009 R9-22] then makes it a change to both engines.
- **Either engine.** `packages/engine` and `packages/engine-rs` are not modified by this work
  ([C10-3]). The tool reaches them through their public surfaces and the shuffle seam each already
  has ([0001 E1-61], [0009 R9-12]).
- **The vector format and the generator,** except where [C10-29] through [C10-34] extend them. Both
  remain 0002's.
- **Speed and the computer opponents** (intent 0008, *Not in scope*). The tool reports its own
  throughput, and nothing gates on it.

## Definitions

Terms from 0001 (colour, source, destination, lid, marker, ply, round), 0002 (vector, oracle,
canonical state, census) and 0007 (record) keep their meanings. Added here:

| Term | Meaning |
| --- | --- |
| **The driver** | The TypeScript program in `packages/crosscheck/src` that invents games, plays them on the TypeScript engine, and compares. |
| **The checker** | The Rust program in `packages/crosscheck/checker` that replays a game on the crate and reports what the crate said. It decides nothing. |
| **Game input** | Everything that determines a game: its start ([C10-16]), its shuffles, its actions and its probes. Enough to replay it on either engine without a seed. |
| **Ply record** | What one engine says about one position, in the fixed layout of [C10-8]. Record `0` describes the start; record `k` the position after the `k`-th action. |
| **Disagreement** | The first record index at which the two engines' ply records differ, together with every field that differs there. |
| **Report** | The file a disagreement is written to ([C10-23]). It is also the input the generator records a vector from ([C10-31]). |
| **Ruling** | A written decision of what the rules require in one disagreement's position, entered in *Rulings* ([C10-27]). |
| **Correction** | A named, minimal patch to the oracle that makes it follow a ruling it otherwise breaks ([C10-32]). |
| **Found vector** | A vector recorded from a report, named `found-NN-slug.json` ([C10-31]). |

## Package

- **[C10-1]** The tool MUST live in `packages/crosscheck`, a pnpm workspace package named
  `crosscheck` that depends on the workspace package `engine` and has no other runtime
  dependency. The checker MUST be a binary crate in `packages/crosscheck/checker` named
  `azul_crosscheck`, depending on `azul_engine` by path (`../../engine-rs`) and on nothing else,
  in any dependency section. Its `Cargo.lock` MUST be committed, every `cargo` invocation the
  package makes MUST pass `--locked`, and its `rust-toolchain.toml` MUST be byte-identical to
  `packages/engine-rs/rust-toolchain.toml`.

  *No `serde`: the checker reads and writes the fixed word layout of [C10-8] and [C10-12], which
  needs nothing past `std::io`. A second pinned toolchain that drifts from the first would compile
  the crate under a compiler its own suite never ran.*
- **[C10-2]** The checker MUST satisfy [0009 R9-4], [0009 R9-6] and [0009 R9-7] as though it were under
  `packages/engine-rs`: no async, `#![forbid(unsafe_code)]`, and no panic on any input — a
  malformed message is an error exit with a message, not a panic.
- **[C10-3]** Nothing under `packages/engine` or `packages/engine-rs` changes to make the tool
  work. The driver MUST import the TypeScript engine only through the package root (`'engine'`),
  never a path into its `src`, and the checker reaches the crate only through its public surface,
  which [0009 R9-8] makes the only surface there is. A source scan in the suite MUST fail on any
  other import of the engine. The one exception is [C10-38]'s mutation test, which imports a
  mutated *copy* from a scratch directory, never the tree.
- **[C10-4]** `package.json` scripts:

  | Script | Runs |
  | --- | --- |
  | `check` | the long run of [C10-18], release-built checker |
  | `replay` | [C10-24]: re-run a report |
  | `test` | builds the checker, then the suite of *Verification* |
  | `typecheck` | `tsc --noEmit`, then `cargo clippy --locked --all-targets -- -D warnings` on the checker |

  The root `pnpm test` and `pnpm typecheck` therefore include the tool, as they include
  `engine-rs` ([0009 R9-2]).

## Randomness

The shuffles and the moves come from the tool, never from either engine's seeded path (intent
0008, *Constraints*).

- **[C10-5]** The driver MUST use a generator of its own, `xoshiro128**` seeded by `splitmix32`,
  implemented in `packages/crosscheck/src` and pinned by known answers committed as literals in
  the suite. It MUST NOT use the TypeScript engine's `Rng` nor call either engine's constructor
  without a shuffle.
- **[C10-6]** Game `g` of a run with seed `S` MUST draw everything — its policy, its start, its
  shuffles, its moves and its probes — from one stream seeded by `splitmix32` over `S` and `g`
  combined as the tool's source fixes. A game therefore depends on `(S, g)` and the run's options
  alone, and never on how many games ran before it or in what order ([C10-20]).
- **[C10-7]** The driver's shuffle seam, handed `(bag, index)` by the TypeScript engine, MUST:
  when `index` equals the number of shuffles recorded so far, Fisher–Yates the bag it was handed
  with the game's stream and record the result; when `index` is smaller, write the recorded order
  back ([0002 V2-6]); when `index` is larger, stop the game as a tool error. The recorded order is
  the bag *after* the shuffle, in storage order, as in [0002 V2-6].

## The ply record

Both engines are asked the same questions about every position, and answer in the same layout.
The layout is the comparison: a field not in it is not compared.

- **[C10-8]** A ply record MUST be this sequence of 32-bit words, in this order. Integers are
  two's complement; `f32` values are their IEEE-754 bit patterns, so comparison is exact and no
  decimal formatting is involved on either side.

  | Field | Words | Content |
  | --- | --- | --- |
  | `status` | 1 | `0` position described; `1` the action was rejected; `2` the start was rejected; `3` the shuffle seam was asked for an order the game input does not hold ([C10-13]). After `2`, nothing follows. |
  | `factories` | 25 | per display, per colour |
  | `center` | 5 | |
  | `markerInCenter` | 1 | `0`/`1` |
  | `bag` | 1 + n | length, then storage order |
  | `lid` | 5 | |
  | `walls` | 50 | player 0 then 1, row-major |
  | `plColor` | 10 | `-1` when empty |
  | `plCount` | 10 | |
  | `floor` | 10 | |
  | `floorMarker` | 2 | |
  | `scores` | 2 | |
  | `currentPlayer`, `firstPlayer`, `roundIndex`, `tilesLeft`, `shufflesUsed`, `isTerminal`, `exhausted` | 7 | one word each, in this order |
  | `legal` | 1 + n | `legalActions()` in this position: count, then ascending |
  | `probe` | 2 | the probed action ([C10-10]), then `isLegal` of it, `0`/`1` |
  | `outcome` | 1 | `1`, `0`, `-1`, or `2` while unfinished |
  | `census` | 5 | `tileCensus()` |
  | `inspect` | 8 | per player: `floorPenalty`, `completedRows`, `completedCols`, `completedColors` |
  | `encoded` | 364 | `encodeFor(s, 0)` then `encodeFor(s, 1)`, `f32` bits |
  | `record` | 1 + … | `0` when the ply returned no record; else `1` and [C10-9] |

  *The canonical block is [0001 E1-62]'s field order exactly, so a decoded record reads like a
  vector state. The inspection block repeats what the state determines on purpose: those are
  separate functions in each engine, and two engines that agree on a state can still disagree
  about what it is worth.*
- **[C10-9]** The `record` block is 0007's `RoundScoring` in declaration order: `round`; for each
  player, `placements` (count, then `row`, `col`, `h`, `v`, `points` each), `tiling`,
  `floor.occupied`, `floor.rungs` (count, then values), `floor.markerHeld`, `floor.penalty`,
  `scoreBefore`, `scoreAfterRound`, `forgiven`; then `bonuses` (`0`, or `1` followed by, for each
  player, `rows`, `cols`, `colors`, `rowPoints`, `colPoints`, `colorPoints`, `total`,
  `scoreBefore`, `scoreAfter`).
- **[C10-10]** Every ply MUST be played with `applyExplained` (`apply_explained`), so that a
  round's record is always compared. `apply` is not driven: its agreement with the explained path
  is each engine's own [0007 S7-28] and [0007 S7-29]. The probe is one action drawn from the game's
  stream, uniformly from `0..=255` excluding the position's legal actions as the TypeScript engine
  lists them. Both engines are asked `isLegal` of the same probe, which is how rejection is
  compared without applying an illegal action to either.
- **[C10-11]** Two ply records agree iff they are equal word for word. On the first index where
  they do not, the driver MUST decode both with the layout and name **every** differing field
  there, by path (`scores[1]`, `encoded[0][112]`, `record.players[0].floor.rungs`), with both
  values. Because the layout carries its own lengths, a length mismatch is reported as that field
  differing, and decoding stops for the rest of that record rather than misaligning.

## The checker's protocol

The driver plays each game on the TypeScript engine first, then hands the checker the game input
and compares what comes back. Since a game's input fixes every ply, this finds the same first
differing record a lockstep comparison would, with one message each way per game.

- **[C10-12]** The driver writes to the checker's stdin, and reads from its stdout, messages of
  little-endian 32-bit words, each prefixed by its own length in words. A game message is:
  the game index (2 words); the start (`0` for a new game, or `1` followed by a canonical block of
  [C10-8]); the shuffle count and each shuffle as length then tiles; the action count and the
  actions; and one probe per record. The checker answers with the record count and the records.
- **[C10-13]** The checker MUST construct with an injected shuffler that writes the recorded
  order for `index` — `new_game(recorded)` for a new game, `from_canonical(&start, recorded)`
  otherwise ([0002 V2-36]). The shuffler MUST record in itself, where the checker can read it back
  through `shuffler()`, any call whose `index` has no recorded shuffle or whose bag is not a
  permutation of the recorded order; the checker reports either as status `3` at that ply, and
  emits no further records. It MUST NOT write an order that is not a permutation of the bag it is handed.
- **[C10-14]** When `apply_explained` rejects an action, the checker MUST emit that record with
  status `1` describing the unchanged position, and emit no further records. When
  `from_canonical` rejects the start, it MUST emit one record, status `2`.
- **[C10-15]** The checker holds no state between games. A game message answered twice is
  answered identically.

## Starts, policies and caps

Steering is how the tool reaches what uniform play rarely does (intent 0008, *What good looks
like*): full floors, an empty bag and lid, games that go on for many rounds.

- **[C10-16]** A game MUST start in one of three ways, chosen by `--start`:

  | `--start` | The start |
  | --- | --- |
  | `new` (default) | `newGame` with the driver's shuffle; record `0` is the dealt opening. |
  | `short:K` | A new game dealt by the TypeScript engine with the driver's shuffle, then `k` tiles removed from the end of its bag, `k` drawn per game from `1..=K`, `K` at most 80. Loaded into **both** engines with `fromCanonical`, so that the TypeScript engine's `newGame` is not the only witness of it. |
  | `vector:NAME` | The `initial` of the committed position vector `NAME`, read in place and never written. |

  A short start is lawful and its census is below 100 ([0002 V2-35]); it is the only way the tool
  reaches a refill that finds bag and lid empty ([0001 E1-33], [0001 E1-34], [0001 E1-37]), since a
  full census never does.
- **[C10-17]** The driver MUST offer these policies, each with a uniform fallback for plies where
  it has no preference ([0002 V2-14]), and each named as the generator names its own where both
  have one:

  | Policy | Prefers |
  | --- | --- |
  | `uniform` | nothing |
  | `biggest-pile` | the take with the most tiles |
  | `centre-first` | any take from the centre |
  | `avoid-marker` | any take that does not take the marker, until forced |
  | `prefer-lines` | any destination but the floor |
  | `floor` | the floor as destination, whenever legal |
  | `per-ply` | a policy drawn afresh from the others at every ply |

  `--steer mix` (the default) draws one policy per game, uniformly from all seven; `--steer
  NAME` fixes one. `floor` never completes a pattern line and so never ends a game ([0002 V2-14]);
  it is what the cap is for.
- **[C10-18]** A game that reaches `--cap` plies (default 400) stops, and is counted as capped
  rather than failed. Records up to the cap are compared as usual.
- **[C10-19]** Every run MUST report, beside its verdict, how often it reached the places steering
  is for: games ended by a completed row, ended by exhaustion, and capped; the highest
  `roundIndex` seen; lid recycles; refills that dealt fewer than a full round; floors holding
  seven or more; floors holding more than seven (the marker's eighth slot, [0001 E1-27]); and
  plies per second. These are counted on the TypeScript side, from records both engines agreed on.

## Running

```bash
pnpm -F crosscheck check --games 100000 --seed 7
pnpm -F crosscheck check --games 20000 --steer floor --cap 600
pnpm -F crosscheck check --games 20000 --start short:40
pnpm -F crosscheck replay found/crosscheck-7-412.json
```

- **[C10-20]** A run plays its games in order, `0` to `N − 1`, in one driver paired with one
  checker process, and stops at the first game that disagrees. Two runs with the same options and
  seed report the same game and the same disagreement.

  *Deliberately serial. Parallel workers are an optimisation, and the Open questions settle that
  none is made before a measured run shows it is needed. [C10-6] already makes each game
  independent of the ones before it, so adding workers later changes only which game is reported
  first, and that is the rule to settle then.*
- **[C10-21]** A run exits `0` with the line `no disagreement in N games (P plies)` when none is
  found, `1` after writing a report when one is, and `2` on a tool error — a checker that died,
  a malformed message, a seam called out of order. A tool error is never reported as a
  disagreement, and a disagreement is never reported as a tool error.
- **[C10-22]** A run MUST NOT read a clock for anything but the plies-per-second figure, and that
  figure MUST NOT appear in a report.

## The report

- **[C10-23]** A disagreement MUST be written to `--out` (default `packages/crosscheck/found/`,
  ignored by git) as `crosscheck-<seed>-<game>.json`:

  ```jsonc
  {
    "schema": 1,
    "commit": "<40-hex>",          // the repository's HEAD; "-dirty" appended when it was not clean
    "run": { "seed": 7, "game": 412, "steer": "floor", "start": "new", "cap": 400 },
    "start": null,                 // or a canonical state, for short: and vector: starts
    "shuffles": [[0, 3, 4, …], …], // as [0002 V2-6]: bag after each shuffle, storage order
    "actions": [47, 12, …],        // actions[k-1] leads to record k; ends at the disagreeing one
    "probes": [201, 5, …],         // one per record, 0 through the disagreeing one
    "at": 37,                      // the first record index at which the two differ
    "fields": [{ "path": "scores[1]", "typescript": 12, "rust": 14 }, …],
    "said": {                      // both engines' full records there, decoded
      "typescript": { /* … */ }, "rust": { /* … */ }
    },
    "before": { /* the agreed record at index − 1, decoded; absent at index 0 */ }
  }
  ```

  The shuffles and actions are cut to what reaches the disagreeing record: nothing after it.
- **[C10-24]** `replay` MUST re-run a report from its `start`, `shuffles`, `actions` and `probes`
  — not from its `run` seed — and MUST report the same `at` and `fields`. It exits as
  [C10-21] does, and `0` means the disagreement no longer reproduces: someone has fixed it.
- **[C10-25]** A disagreement traced to the tool itself — the driver or the checker encoding a
  field wrongly — is fixed in the tool and needs no ruling, but its report MUST become a case in
  the tool's own suite before the fix lands, failing before and passing after.

## Settling a disagreement

The engines disagree; the rules decide. Nothing here trusts either engine or the oracle to be
the judge (intent 0008, *Constraints*).

### Authorities

- **[C10-26]** A ruling MUST rest on the highest-ranked authority that addresses the position:

  | Rank | Authority | Identified as |
  | --- | --- | --- |
  | 1 | The publisher's official clarifications (FAQ, errata) | None known for this printing. A rank-1 source found later is added here by a spec change, and outranks the rulebook from then on. |
  | 2 | The rulebook | Next Move Games' English rules, web edition: [`EN-Azul-Rules-Next-Move-web.pdf`](https://cdn.svc.asmodee.net/production-nextmove/uploads/sites/4/2024/06/EN-Azul-Rules-Next-Move-web.pdf), 6 pages, created 2018-01-16, SHA-256 `31ba3d087e8d9ff26dfe3c0fd36813b5f8832f7c8ebe7f56d145b4b4f2103e33`. |
  | 3 | A ruling of our own | This spec's *Rulings*, labelled as ours. |

  The rulebook is identified by its hash, not its address: a file that no longer matches is a
  different printing, and replacing it is a spec change. It is not committed to the repository.

  A rank-1 or rank-2 ruling cites its source by page and heading, and does not quote it at
  length. A rank-3 ruling says what the higher ranks leave open and why the decision was made the
  way it was.

### Rulings

- **[C10-27]** Every settled disagreement that is not the tool's own bug ([C10-25]) MUST have an
  entry below, written before or with the change that fixes an engine, in this shape:

  ```markdown
  #### Ruling N — short title

  - **Position:** `found-NN-slug.json`
  - **Authority:** rank and citation
  - **Decision:** what the rules require here, and why
  - **Referees:** which engine was wrong
  - **Oracle:** agrees | wrong — correction `ruling-N-slug`
  - **Reported upstream:** link, when the oracle was wrong
  - **0001:** the requirements added or revised, or "none"
  ```

  A ruling is kept once written. One overturned later is struck out, not deleted, and the ruling
  that replaces it takes the next number.
- **[C10-28]** A ruling that changes what the engines do, or settles something 0001 does not
  state, MUST amend 0001 in the same change — an edited requirement if 0001 stated it wrongly,
  the next free identifier if it was silent — and [0009 R9-22] then forces the crate's table to
  classify the change. A ruling that finds 0001 right, and one engine's code departing from it,
  amends nothing: the fix is to that engine, under 0001.

*No rulings yet.*

### Found vectors

- **[C10-29]** Every ruling MUST have a found vector, and that vector is the permanent test
  (intent 0008, *The answer is kept*). It lives with the others in
  `packages/engine/test/vectors/`, so both engines' suites replay it with no change to either
  harness ([0009 R9-15]).
- **[C10-30]** A found vector's `note` MUST begin `Ruling N:`, naming its ruling, and its `kind`
  MUST be `game` for a `new` start and `position` otherwise, with 0002's rules for that kind —
  rebasing ([0002 V2-33]), the short-census flag ([0002 V2-35]) and encodings
  ([0002 V2-38]) included.
- **[C10-31]** Found vectors MUST be recorded by the generator, from the report itself, copied
  unedited into `tools/vectors/traces/found-NN-slug.json`. The generator reads every trace there
  on every run, as it reads its own seeds, so regeneration reproduces found vectors with the rest
  ([0002 V2-11]). It MUST inject the trace's shuffles through its shuffle patch — writing each
  recorded order, after asserting it is a permutation of the list the oracle is shuffling — and
  play the trace's actions, then continue to the game's end with the `uniform` policy seeded by
  `generator.pythonSeed`, which for a found vector is `1000000 + NN`. `generator.policy` is
  `"trace"`, and `generator.trace` records the report's `run` block.

  *Continuing to the end keeps a found `game` vector a complete game, which [0002 V2-15] requires
  of every game vector, and leaves the disagreeing ply in the middle of a replay rather than at
  its edge.*

### Corrections

- **[C10-32]** Where a ruling finds the oracle wrong, the generator MUST apply a correction named
  `ruling-N-slug`, defined in `tools/vectors/corrections.py`, while recording. A correction
  replaces oracle code — a method or function, patched as the shuffle already is — and MUST NOT
  edit any recorded value after the oracle produced it: a fixture is still the oracle's opinion
  ([0002 V2-10]), of the oracle as corrected.
- **[C10-33]** Every correction is installed for **every** vector the generator writes, and every
  vector written while any correction is installed MUST list them all, sorted, in
  `generator.corrections`. The field is absent when there are none. A correction that changes a
  vector other than its own found vector changes it in the open, as a regeneration diff
  ([0002 V2-11]).
- **[C10-34]** For each correction, the generator MUST record that correction's found vector a
  second time with that correction alone removed, and MUST fail — writing and deleting nothing —
  if the two recordings are identical. That is the correction no longer landing: the oracle has
  been fixed upstream, or the patch no longer reaches the code it names. Either way the correction
  is retired by a spec change, not carried along doing nothing.
- **[C10-35]** A ruling that finds the oracle wrong MUST be reported to the oracle's maintainers
  with the position, and the entry's *Reported upstream* line MUST link the report.

## Verification

The tool's suite, run by `pnpm -F crosscheck test`.

- **[C10-36]** **The everyday run.** The suite MUST run the tool, with fixed seeds, over: 40 games
  with `--steer mix`; 8 games with a `short:K` start, `K` fixed in the test; and 4 games with
  `--steer floor --cap 400`, and MUST assert that none disagrees. It MUST also assert, from [C10-19]'s counts, that each run
  reached what it steers for — at least one exhausted game under the short start, at least one floor
  past seven under `floor`, at least one lid recycle under `mix` — so a steering option that
  quietly stopped steering fails rather than passing on uniform play.
- **[C10-37]** **The committed vectors.** Every vector in `packages/engine/test/vectors` MUST be
  driven through the tool as game input — its start, its shuffles, its actions — and MUST produce
  no disagreement. The TypeScript side's decoded records MUST equal the vector's `initial` and
  `plies[i].state` field for field, its `legal` the next ply's `legal`, and, for position
  vectors, its `encoded` the recorded encodings ([0002 V2-38]). This is what shows the record
  reads the fields it claims to: the vectors are the oracle's opinion of them.
- **[C10-38]** **A real mistake, caught every time.** The suite MUST copy
  `packages/engine/src` from the working tree to a scratch directory, apply each mutation below to
  the copy, **assert that its anchor matched** before writing, import the copy, and run the
  `mix` run of [C10-36] with the mutated copy in place of the TypeScript engine. Each MUST produce
  a disagreement whose fields include the one named:

  | Mutation | Breaks | Expected among `fields` |
  | --- | --- | --- |
  | A tile joining both runs counts itself twice | [0001 E1-24] | `scores`, `record` |
  | The round's score is not clamped at zero | [0001 E1-28] | `scores`, `record` |
  | A lid recycle keeps the lid's tiles in the lid as well | [0001 E1-33] | `lid`, `census` |

  *This is intent 0008's "it has been seen to catch a real mistake", kept true rather than shown
  once — and the procedure `CLAUDE.md` sets for mutation, run by the suite instead of by hand. The
  copy is of the working tree, not of `HEAD`, because the question is whether the tool catches a
  mistake in the engine as it stands.*
- **[C10-39]** **The other engine.** At least one mutation of a copy of `packages/engine-rs/src`,
  made with `git archive` by the `CLAUDE.md` procedure, MUST have been seen to produce a
  disagreement in the everyday run, and MUST be recorded beside [C10-38]'s test, naming the
  function and the line. It is recorded rather than run because it costs a build of the crate.
- **[C10-40]** **Every field is compared.** For every field of [C10-8] and [C10-9], a unit test
  MUST alter that field in one side's record — in a record where it is present — and assert that
  [C10-11] names exactly that path. A field the comparison skips, or names wrongly, fails here.
- **[C10-41]** **Reports reproduce.** A disagreement produced by a [C10-38] mutation MUST be
  written as a report, re-run with `replay` against the same mutated copy, and yield the same
  `at` and `fields`; and running the same options and seed twice MUST report the same game
  ([C10-20]).
- **[C10-42]** **The generator is pinned.** `xoshiro128**` and `splitmix32` MUST be checked
  against known answers, and the shuffle of [C10-7] against a known bag for a known seed.
- **[C10-43]** **The register holds together.** The suite MUST parse *Rulings* and assert:
  - every entry carries each line of [C10-27]'s shape, and entries are numbered from 1 without
    gaps;
  - every entry names a found vector that exists and whose note begins with its number
    ([C10-30]), and every found vector is named by exactly one entry;
  - every found vector has its trace in `tools/vectors/traces/` under the same name, its
    `generator.trace` equals that trace's `run`, its `generator.policy` is `"trace"` and its
    `generator.pythonSeed` is `1000000 + NN` ([C10-31]);
  - every entry whose oracle is `wrong` names a correction and links an upstream report
    ([C10-35]);
  - the set of corrections named by entries equals the union of `generator.corrections` across
    the committed vectors ([C10-33]).

  While there are no rulings this passes on an empty register, so the same checks MUST also run
  against a fixture register and vector set, written for the purpose, holding one defect of each
  kind above, and MUST name each defect. A check that has only ever seen an empty register has
  not been seen to fail.
- **[C10-44]** The suite, excluding compilation, SHOULD finish in under 30 seconds.

## Traceability

- **[C10-45]** Every `C10` requirement MUST be cited by a test under `packages/crosscheck/test` —
  in the test name for the TypeScript suite, in an adjacent comment for the checker's — or listed
  in *Traceability exemptions*, checked by the scanner the other packages use, with its three
  failure cases ([0002 V2-27]) and its standard for exemptions ([0002 V2-31]).

### Traceability exemptions

| Requirement | Why it is not testable |
| --- | --- |
| [C10-25] | A process rule about the order of a fix and its test. |
| [C10-28] | Whether a ruling changes the rules is a judgement. What it forces is enforced by [0009 R9-22]. |
| [C10-32], [C10-34] | The generator's obligations, carried out in Python at recording time. The suite runs without Python ([0002 V2-8]); what they leave in the committed vectors is checked by [C10-37] and [C10-43]. [C10-34] MUST be seen to fail by the `CLAUDE.md` procedure — remove the correction's effect, watch the generator refuse — when the first correction lands. |
| [C10-39] | A recorded mutation, by design. |
| [C10-44] | A non-gating budget. |

## Amendments

On landing, in the same change as the code:

| Document | Amendment |
| --- | --- |
| `spec/0001-engine-core.md`, *Scope* | "Where this document and that file disagree, this document is a bug" becomes: unless a ruling of *0010 — Engines cross-checked* says otherwise, in which case the ruling decides and this document is amended to match ([C10-28]). |
| [0002 V2-9] | The generator also records found vectors, from `tools/vectors/traces/` ([C10-31]). It remains the only writer. |
| [0002 V2-10] | A fixture is the oracle's opinion *as corrected* ([C10-32]): corrections patch oracle code, never recorded values. |
| [0002 V2-37] | Add `generator.corrections` ([C10-33]) and `generator.trace` ([C10-31]) to the optional fields, and `found-NN-slug.json` to the file names. `schema` stays `1`: nothing a harness reads changes. |
| [0009 R9-16] | "The oracle is authoritative for both" becomes: the oracle, as corrected under 0010, is authoritative for both, and a ruling of 0010 over it. |
| `spec/README.md` | This spec's row in the index (added with this document; `accepted`, then `implemented` when the code lands). |
| `CLAUDE.md` | The sixth package in *Project*, and `pnpm -F crosscheck check`, `replay` and `test` in *Commands*. |

None of the amendments adds a requirement identifier to 0001, 0002 or 0007, so [0009 R9-22]'s table
needs no new rows until a ruling adds one ([C10-28]).

## Open questions

- ~~**Which printing of the rulebook, and are there official clarifications?**~~ **Answered:** Next
  Move Games' English web edition, pinned by hash in [C10-26]. No FAQ or errata is known for it.
- ~~**Shrinking.** A report is the whole game up to the disagreeing ply, which can be a hundred
  plies long; a shrinker would drop actions while the disagreement survives.~~ **Answered: not
  now.** Reports stay whole. Revisit only if a real report proves hard to rule on.
- ~~**Throughput.** Is sending every full record the expensive part?~~ **Answered: build the
  simple design and measure it.** Full records, as [C10-8] and [C10-12] specify. Nothing is
  assumed about which side or which step is slow; [C10-19] reports plies per second, and only a
  measured run that is too slow to use justifies optimising — with the measurement recorded here.

## References

- Intent [0008 — Engines checked against each other](../intent/0008-engines-checked-against-each-other.md)
- Spec [0001 — Engine core](0001-engine-core.md)
- Spec [0002 — Engine conformance vectors](0002-engine-conformance-vectors.md)
- Spec [0007 — Scoring explained](0007-scoring-explained.md)
- Spec [0009 — Engine in Rust](0009-engine-in-rust.md)
- `xoshiro128**` and `splitmix32`: Blackman and Vigna, [prng.di.unimi.it](https://prng.di.unimi.it/)
