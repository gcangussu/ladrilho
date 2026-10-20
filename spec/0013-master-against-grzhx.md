---
title: Master against grzhx's AlphaZero
author: Gabriel Cangussu
date: 2026-10-19
status: implemented
intent: 0015 — Our master against another AlphaZero
prefix: G13
depends-on: 0001 — Engine core, 0010 — Engines cross-checked, 0011 — AlphaZero training, 0012 — Master opponent
summary: >
  A command-line harness that plays 0011's trained player against generation
  2300 of github.com/grzhx/azul-alpha-zero, refereed by our TypeScript engine:
  how their release is pinned, fetched and built outside the repository, the
  process that hosts their player, the lockstep game their search plays on and
  the per-ply comparison that catches a rules or translation disagreement, every
  setting of both players and its default, clocks, paired matches, results,
  replay, and the timing table. Amends 0011 so our player can be stopped by a
  clock its library never reads.
---

# Master against grzhx's AlphaZero

## Scope

Covers `pnpm -F alphazero-bot grzhx <command>`, a harness under `packages/alphazero-bot/grzhx`
that plays our player against *theirs*: the two-player generation-2300 actor of
[grzhx/azul-alpha-zero](https://github.com/grzhx/azul-alpha-zero), searched by their own native
Gumbel search. It covers:

- the pinned release and how it is fetched, checked and built ([G13-1] to [G13-7]);
- the **host**, a Python process of ours that loads their code from the cache ([G13-8] to
  [G13-11]);
- the **lockstep** game their search plays on, the translation of our position, and the per-ply
  comparison of the two engines ([G13-12] to [G13-20]);
- every setting of both players, its default and syntax, and the clocks ([G13-21] to [G13-29]);
- matches, repeatability, results and replay ([G13-30] to [G13-43]);
- `verify`, `timing` and the fairness note ([G13-44] to [G13-49]).

It does not cover our player itself: the network, the search and `serve` are
*0011 — AlphaZero training*'s, and the one change they need, a stop the library never times, is an
amendment listed in *Amendments*. The harness against danluu.com/game/tile (`tile/`) is
unspecified and unchanged; this one follows its conventions where they fit. Nothing here touches
`ui`, `bot`, `ai-bot`, `eval/chooser.ts` or the training loop.

### What their program is

At the pinned commit their repository is a C++20 rules engine and search behind a C ABI
(`include/azul/c_api.h`), a `ctypes` binding (`python/azul.py`), and PyTorch networks and
drivers (`python/azul_ai`). The weights are in release `v2300.1`, not in the repository. What the
harness relies on, read at the pinned commit:

- **Their encoding is ours.** An action is `(source·5 + colour)·6 + destination`, with the centre
  as source 5 and the floor as destination 5, and a colour `c` in row `r` sits in wall column
  `(r + c) mod 5`: the layout of [0001 E1-6] and our wall. Action ids and colour indices cross
  unchanged.
- **A manual game.** On a one-environment batch, `azul_manual_reset` starts a game with a full
  bag, player 0 to move and nothing dealt; `azul_batch_manual_deal` deals twenty given tiles
  factory-major, drawing each from the bag in order, refilling the bag from the lid when it is
  empty, and taking 255 for a tile a short deal leaves out; `azul_manual_step` applies one move
  and never deals. Their batch step, by contrast, deals from their own generator at a round end.
- **Import of a public position.** `azul_batch_import_public` builds a state from the sources'
  colour counts, both walls, scores, pattern lines, floors, the bag's and the lid's colour counts,
  the round, the player to move, the next round's first player and whether the marker is in the
  centre, and refuses one their `validate` rejects, including any whose census is not 20 of each
  colour. The state it builds has `ply` 0 and a fixed generator state.
- **The search.** A Gumbel search, sequential halving at the root, sampling deals at round ends
  from the bag's counts with its own seeded generator. It is configured by `AzulSearchConfig` and
  `AzulSearchTuning` (fields in [G13-23]) and is valid only within `valid_config`'s ranges. Its
  subtree reuse matches a new root against the previous tree by whole-state equality, `ply`
  included, so it finds nothing to reuse under an imported state.
- **Their match protocol.** `scripts/audit_ai.py` plays two actors with the search and tuning
  each actor records, `gumbel_scale` forced to 0, one `PipelineSearch` per actor kept across the
  moves of the games it plays, over real stepped games.
- **Their local player.** The release's `.zip` holds the program its author ships for play
  (`web_game.py`). It plays a `manual_reset` game, searched by a `PipelineSearch` with one queue
  and one thread, and its AI always moves on a fixed count of simulations. Its advice mode for the
  human player ("keep thinking", `_advice_work`) searches chunks of 1024 simulations on the same
  root, each run to its end, each with `subtree_reuse` 0, `candidates` clamped to the chunk and
  `gumbel_scale` 0, and keeps their vote by `rank_search_actions`, updated only when a chunk
  finishes; a chunk still running when the person stops is thrown away. That is the only timed
  search their author ships, so this harness borrows it for their clock. The `azul_ranked_*`
  functions belong to an integration their release notes say was removed, and are not used here.
- **Independent-tree voting.** `scripts/evaluate_tree_counts.py` copies one position into a batch
  of `trees` environments, searches them under one seed (one stream per root), with
  `subtree_reuse` 0 and `candidates` clamped to the simulations, and plays the vote of
  `rank_search_actions`.
- **Build options.** CMake `AZUL_SEARCH_MAX_SIMULATIONS` (default 4096) bounds `valid_config` and
  continuation and nothing else; `AZUL_NATIVE` adds `-march=native`; `AZUL_ANYTIME` makes visit
  counts 64-bit and value sums double, which changes the search's arithmetic.
- **No licence.** The repository carries no licence file and the GitHub API reports none.

## Definitions

| Term | Meaning |
| --- | --- |
| **Ours** | 0011's player: `alphazero serve` on a logged milestone, the one `web/shipped.json` names by default. |
| **Theirs** | Generation 2300's actor, searched by their native search through the host. |
| **Cache** | `~/.cache/azul-grzhx`, or `$XDG_CACHE_HOME/azul-grzhx`, or `--cache` ([G13-3]). |
| **Pin** | `grzhx/pinned.json` ([G13-1]). |
| **Host** | `grzhx/host/host.py`, our Python program that loads their code from the cache ([G13-8]). |
| **Lockstep state** | The host's manual game in their engine, advanced only by the moves played and the tiles our engine dealt ([G13-12]). Their search plays on it. |
| **Imported state** | Their state built from our position by `azul_batch_import_public` at each ply ([G13-15]). It is compared, never searched. |
| **Disagreement** | Any failed comparison of [G13-17]. |
| **Cell** | One pair of budgets, ours and theirs, in a match's grid ([G13-31]). |
| **Deal pair** | The two games of one seed in one cell, one from each seat ([G13-32]). |

| Constant | Value |
| --- | --- |
| Their commit | `b1d5f5dc5cbe14ae39fd96328b999dd87f92accb` |
| Their release | `v2300.1` |
| `THEIR_CAP` | 65 536: the build's `AZUL_SEARCH_MAX_SIMULATIONS` ([G13-6]) |
| `OUR_CAP` | 4 294 967 295 (`u32::MAX`): 0011's `MAX_PLAY_SIMULATIONS`, the most `playSimulations` may be ([0011 Z11-60]) |
| `MOVE_TIMEOUT` | 10 minutes, or the move's clock plus 60 s if that is longer ([G13-38]) |

## Data model

### `pinned.json`

Committed, and written only by `grzhx pin` ([G13-2]):

```jsonc
{
  "repository": "grzhx/azul-alpha-zero",
  "commit": "b1d5f5dc5cbe14ae39fd96328b999dd87f92accb",
  "release": "v2300.1",
  "assets": {                                   // sha256 of the downloaded bytes
    "azul-generation-2300.pt": "…", "azul-generation-2300.json": "…", "SHA256SUMS.txt": "…",
    "azul-2300-local-play-windows-x64.zip": "…" // read by the fairness audit only, never run
  },
  "blobs": { "<path at the commit>": "<sha256 of the blob's bytes>", … }
}
```

A blob's bytes are `git cat-file blob <commit>:<path>`, never the checked-out file, which their
`.gitattributes` rewrites for `*.ps1`.

### A player's budget

`--us` and `--them` each take a comma-separated list, which makes the grid ([G13-31]):

| Spec | Meaning |
| --- | --- |
| `<n>` or `sims:<n>` | exactly `n` simulations per move |
| `ms:<n>` | a clock of `n` milliseconds per move ([G13-27], [G13-28]) |

Every other setting is fixed for the match, given as `--us-set <key>=<value>` or
`--them-set <key>=<value>`, repeatable ([G13-21] to [G13-24]).

### The host's messages

Line-delimited JSON on stdin and stdout, one request then one answer, flushed:

| Request | Answer |
| --- | --- |
| `hello` | their commit, the actor's sha256, the build's options, torch's and NumPy's versions |
| `configure {cells}` | per cell, every resolved setting of theirs and where it came from, or the library's refusal ([G13-25]) |
| `game {cell, seed}` | `ok`: a new lockstep game and a new search object ([G13-12], [G13-13]) |
| `deal {tiles}` | `ok` or `{disagreement}` ([G13-14]) |
| `ply {imported, legal, scores}` | `ok` or `{disagreement}` ([G13-17]) |
| `move {}` | `{action, simulations, value, ms}`, with `chunks`, each chunk's action, the vote's tally and `overrun` under a clock ([G13-13], [G13-28]) |
| `step {action}` | `{scores, roundFinished, terminated, winner}` or `{disagreement}` |
| `time {cell, index, imported}` | `{action, ms, simulations}`: one fresh search of an imported position, for `timing` alone ([G13-47]) |

Malformed input, or a request out of order, ends the host with an error naming it.

### Result files

`<out>.jsonl`, one line per game as it finishes; `<out>.json`, the summary; and
`<out>.disagreements/`, one report per disagreement ([G13-19], [G13-39], [G13-40]). `<out>`
defaults to `runs/grzhx/<ISO time>`, git-ignored.

### `timing.json`

Committed by a person, written by `grzhx timing` ([G13-47]):

```jsonc
{
  "measured": "<ISO date>",
  "machine": { "cpu": "…", "logicalCores": 8, "os": "…" },
  "ours": { "checkpoint": "<run>/<generation>", "sha256": "…", "settings": { … } },
  "theirs": { "commit": "…", "build": [], "cxxFlags": [], "settings": { … } },
  "positions": 200,
  "rows": [ { "side": "ours", "simulations": 1000,
              "ms": { "median": 0, "p90": 0, "mean": 0, "max": 0 } }, … ],
  "movesPerGame": { "games": 20, "mean": 0, "max": 0 }   // one player's moves in a game
}
```

## Behaviour

### Their release

- **[G13-1]** `grzhx/pinned.json` MUST name the commit and release of *Definitions*, the sha256
  of the four assets, and the sha256 of every blob in their tree at the commit, as *Data model*
  defines it. Nothing else in the repository may name a commit or release of theirs.
- **[G13-2]** `grzhx pin <commit> <tag>` MUST rewrite `pinned.json` from a fresh fetch of that
  commit and tag, and print what changed. It is the only command that writes the file. Moving the
  pin starts every comparison afresh, as a change to `sharp` does ([0011 Z11-63]).
- **[G13-3]** Nothing of theirs may enter the repository: no source file, weight or build
  product. `grzhx fetch` MUST clone their repository into the cache, check out the pinned commit,
  download the four assets, and check each asset against `pinned.json`, and the `.pt`, `.json`
  and `.zip` also against their own `SHA256SUMS.txt`, before anything is built or loaded. A
  mismatch MUST fail naming the file and both hashes, and leave nothing in the cache a later
  command would load. `play`, `info`, `verify`, `replay` and `timing` fetch first when the cache
  is missing.
- **[G13-4]** The package's suite MUST check that no file tracked in the repository has the sha256
  of an asset or a blob in `pinned.json`. *This catches a file copied whole, byte for byte, and
  nothing else: a copied function, a file edited after copying, or one whose line endings changed
  passes it. It is a tripwire for the likely mistake, not proof of a clean room.*
- **[G13-5]** `grzhx check-updates` MUST ask GitHub for their default branch's head and the
  release's assets, report a new commit or any asset whose digest differs from the pin, and exit 1
  if either changed. It writes nothing.

### Building their program

- **[G13-6]** The harness MUST build their native library from the cached tree with CMake, in a
  build directory under the cache named by its options, never in their source tree, with
  `-DCMAKE_BUILD_TYPE=Release -DAZUL_SEARCH_MAX_SIMULATIONS=65536` and, from their setting `build`
  ([G13-23]), `-DAZUL_NATIVE=ON` and `-DAZUL_ANYTIME=ON`. Every result MUST record the options.
  *One build serves every budget: the cap enters only `valid_config` and continuation, so below
  4096 it plays as their README's build does.*
- **[G13-7]** Their Python code MUST run in its own environment, `grzhx/host/.venv`, built by
  `grzhx/host/venv.sh` as [0011 Z11-5] builds the trainer's: uv, binary wheels only, every hash
  checked against `grzhx/host/requirements.txt`, Python 3.12, and the trainer's torch and NumPy
  versions. The same environment holds the cmake that builds their library, from its pinned PyPI
  wheel, so nothing is installed on the machine. Before building, the harness MUST check for `uv`
  and configure and build a scratch CMake project, with their `CMakeLists.txt`'s C++ standard,
  whose one source includes `<algorithm>`, so the compiler is checked as CMake will drive it. On
  macOS, when that fails and the SDK's own `usr/include/c++/v1` holds `<algorithm>`, it MUST try
  again with `-isystem` naming those headers, and, if that builds, build their library with the
  same flag and record it in every result. Otherwise it fails naming whichever is missing or
  broken. *A Command Line Tools install whose own `include/c++/v1` is partial shadows the SDK's
  complete one; the machine of record has one.*

### The host

- **[G13-8]** The host MUST be our own program. It puts the cached `python/` directory on its
  import path and uses their modules and their library's exported functions unchanged. It MUST NOT
  patch or replace anything of theirs at run time.
- **[G13-9]** It MUST load the actor with their `load_actor` on the CPU, wrap it in their
  `FrozenActor` in float32, call `torch.set_num_threads` with `torchThreads` ([G13-23]), and
  refuse an actor whose sha256 is not the pin's.
- **[G13-10]** It MUST answer the messages of *Data model* and nothing else, and MUST NOT write to
  stdout except answers.
- **[G13-11]** A host lives as long as its worker ([G13-35]). Nothing may carry from one game to
  the next but the loaded actor and the configured cells, so a game plays the same whichever
  games its host played before.

### Lockstep, translation and comparison

- **[G13-12]** For each game the host MUST start a lockstep state with `azul_manual_reset`, on a
  one-environment batch of its own, and advance it only by `deal` and `step`, which call
  `azul_batch_manual_deal` and `azul_manual_step`. It MUST never call a function of theirs that
  deals from their generator.
- **[G13-13]** Their move MUST be searched on the lockstep state, with the search object built for
  the game ([G13-12]) and kept for all of it:
  - with one tree and a count, a `PipelineSearch` with one queue, as `audit_ai.py` runs it;
  - with `trees` > 1, the lockstep state copied by their snapshot and restore into a batch of
    `trees` environments and searched as `evaluate_tree_counts.py` does, its vote played;
  - with a clock, [G13-28]'s chunks.

  The move played MUST be the search's decision: the native sequential-halving action, or the
  vote. The policy's most probable action is never played. Each move's search seed MUST be derived
  from the match seed, the game's seed and the ply by a hash with its own domain tag, never from
  our engine's shuffler or its state.
- **[G13-14]** The harness MUST deal the lockstep game exactly as our engine dealt ours: at the
  start and at every round end, `deal` carries the twenty tiles of our deal factory-major, 255 for
  each tile a short deal leaves out, and, within the factory being filled when our bag ran out,
  the tiles drawn before the refill first. The order is computed from our position before the
  deal and the factories after it, in `grzhx/convert.ts`.
- **[G13-15]** At every ply the harness MUST translate our position into the arguments of
  `azul_batch_import_public`, in `convert.ts`, from its public fields alone: factories, centre,
  walls, pattern lines, floors, scores, the bag's and the lid's colour counts, the round, the
  player to move and the marker. It MUST NOT read our state's shuffler or the bag's order.
- **[G13-16]** Ours MUST be handed each position as [0011 Z11-23]'s block of
  `toCanonical(fromJSON(toJSON(state), 0))`, as `eval/chooser.ts` builds it, so the bag reaches
  it in an order rebuilt from counts and the state is rebuilt on `Seeded::new(0)`
  ([0011 Z11-15]). Two of our states that differ only in the bag's order and the shuffler's seed
  MUST be framed to identical bytes. The harness MUST spawn `serve` itself and MUST NOT import
  `eval/chooser.ts`, whose changes [0011 Z11-63] already governs through the ladder hash.
- **[G13-17]** At every ply, before the move, the host MUST import the imported state into a
  scratch environment and compare, exactly:
  - its observation (172 floats) and legal mask against the lockstep state's;
  - the lockstep state's legal mask against the `legal` our engine sent;
  - the lockstep state's scores against the `scores` our engine sent.

  After each `step` the harness MUST compare the totals the host returns, and at a round end and
  at game end whether the round or game finished, against our engine's; at game end also the
  winner, ties and the complete-rows tie-break included. A refusal by `import_public` or
  `manual_deal`, a move of theirs our engine refuses, or a move our engine applies that
  `manual_step` refuses, is a disagreement too. Only totals are compared at a round end: their
  engine reports no breakdown.
- **[G13-18]** The report of a disagreement MUST say which comparison failed first. It MUST NOT
  say whether the translation or a rule is at fault: that is a person's ruling, by the order of
  authority of *0010 — Engines cross-checked*. *By construction the imported state is our
  position, so a rule that differs shows up as imported ≠ lockstep, exactly as a translation bug
  does.*
- **[G13-19]** A disagreement MUST end that game at once. The harness writes
  `<out>.disagreements/<cell>-<seed>-<seat>.json`: the game's seed, our seat, the moves played,
  the ply, our canonical position, the import arguments, both observations and masks, the
  comparison that failed, and the pin's commit. The game and its deal pair are left out of the
  result ([G13-40]); the match plays on.
- **[G13-20]** The comparisons MUST run in every match and in every command that plays a ply, and
  cannot be turned off. Their cost is counted in neither side's move time ([G13-29]).

### Settings

- **[G13-21]** Every setting MUST be settable from the command line. An unknown key or a value of
  the wrong type MUST fail before any game starts, naming the key. The summary and every game
  line MUST record every setting of both sides as resolved, defaults included.
- **[G13-22]** Ours, by `--us-set`:

  | Key | Default | Meaning |
  | --- | --- | --- |
  | `checkpoint` | the milestone `web/shipped.json` names | a logged milestone, `run/generation` |
  | `cpuct`, `fpu` | the milestone's logged config | selection's constants ([0011 Z11-16]) |
  | `endgame` | `web/shipped.json`'s endgame cap ([0012 T12-33]) | the endgame proof's node cap; 0 is off ([0011 Z11-76]) |
  | `ceiling` | `OUR_CAP`: in effect none, so the clock alone decides | the most simulations a clocked move may run ([G13-27]) |

  The harness MUST hand `serve` a copy of the milestone's config with `cpuct`, `fpu` and
  `playEndgameNodes` replaced, and `playSimulations` set to the move's count, or to `ceiling`
  under a clock; nothing else changed. `--us`'s default is the milestone's `playSimulations`.
  *That is the milestone's logged setting, as the tile harness defaults to; the browser plays
  10 000 ([0012 T12-16]).*
- **[G13-23]** Theirs, by `--them-set`:

  | Key | Default |
  | --- | --- |
  | `candidates`, `maxDepth`, `chanceInitial`, `chanceCap`, `valueScale`, `maxvisitInit` | the actor's recorded `search` |
  | `gumbelScale` | 0, as `audit_ai.py` plays |
  | `qMode`, `subtreeReuse`, `cacheCapacity`, `symmetricCache`, `qFloor`, `chanceCoefficient`, `chanceExponent`, `chanceSensitivity`, `afterstatePrior` | the actor's recorded `tuning` |
  | `trees` | 1 |
  | `threads` | 1: native threads across a move's `trees` roots, so it matters only when `trees` > 1 |
  | `torchThreads` | 1 |
  | `chunk` | 1024: the simulations of each chunk of a clocked search, the local player's ([G13-28]) |
  | `build` | none; `native`, `anytime` or both, joined by `+` ([G13-6]) |

  Where the actor's record omits a field, the default MUST be that field's default in their
  `SearchConfig` or `Tuning` dataclass at the pinned commit. Defaults MUST be read from their
  files at run time, never copied into ours, so a new pin brings its own; `chunk`'s 1024 is the one
  exception, copied from the local player because `play` never loads the `.zip`. `--them`'s
  default is the actor's recorded `search.simulations`. *These are the defaults `audit_ai.py` plays
  at; the local player's differ (512 simulations, `candidates` 32, `maxDepth` 128,
  `cacheCapacity` 4096), which [G13-49] reports.*
- **[G13-24]** `candidates` MUST be clamped to a move's simulations, or to `chunk` under a clock,
  as `evaluate_tree_counts.py` and the local player clamp it, and the clamped value recorded. With
  `trees` > 1, and under a clock, `subtreeReuse` MUST be 0, as those programs set it, and the
  resolved settings say so.
- **[G13-25]** Before any game, the harness MUST send `configure`, and the host MUST create and
  configure each cell's search with their own `azul_search_create` and `azul_search_configure`. A
  refusal MUST stop the harness, naming the cell and every resolved setting. *Their library knows
  its ranges; the harness does not copy them.* A count or `chunk` above `THEIR_CAP` for theirs, a
  count above `OUR_CAP` for ours, and a clock for theirs with `trees` > 1, MUST be refused at the
  same point.
- **[G13-26]** `grzhx info` MUST print every resolved setting of both sides for the arguments
  given, and where each value came from, and exit without playing. It needs the cache and the
  host's environment, and builds them if missing.

### Clocks

- **[G13-27]** `ms:<n>` for ours MUST run `serve --clock-ms <n>` ([0011 Z11-78]): the search
  stops after the first whole simulation that ends at or past `n` ms, or at `ceiling`, and the
  endgame proof follows as usual, outside the clock. The simulations run MUST be recorded. The
  move is the one a search configured for exactly that many simulations chooses, so a clocked
  move of ours can be replayed from its count.
- **[G13-28]** `ms:<n>` for theirs MUST search the lockstep state as their local player's advice
  mode does, borrowed for their move: chunk after chunk of `chunk` simulations, each a fresh
  search of the same root under its own seed ([G13-13], the chunk's index added to the hash), each
  run to its end. When `n` ms have passed since the first chunk began, the chunk in flight is
  abandoned and plays no part; the first chunk, though, always runs to its end, past `n` if need
  be. The move is the vote of `rank_search_actions` over the finished chunks. The chunks finished,
  each one's own action, the simulations they ran and the milliseconds past `n` the move took
  (`overrun`) MUST be recorded. *The count and the seeds are recorded, but a clocked move of
  theirs is not guaranteed to replay from them: their evaluation cache lives as long as the search
  object, the abandoned chunk has already written to it, and with `symmetricCache` on a hit
  returns a permuted input's logits, equal to a fresh evaluation only up to rounding. Their cache
  stays as their author runs it. Ours, by [0011 Z11-78] and the memo's exact match
  ([0011 Z11-69]), does replay from its count.*
- **[G13-29]** A clock MUST be measured by the process that searches, around the search alone, so
  neither the harness's work nor the comparisons count against either side. Move milliseconds in
  the results are measured the same way for counts. Our endgame proof, which theirs has no
  counterpart of, is outside the clock: the harness MUST run `serve --split-ms`
  ([0011 Z11-79]) so the search's and the proof's milliseconds are recorded per move apart, and
  the summary reports both. `endgame=0` turns it off.

### Matches

- **[G13-30]** A setting's effect MUST be the same in `play` and `timing`: both resolve settings by
  the same function, which `info` prints.
- **[G13-31]** `grzhx play` MUST play every pair of an `--us` budget and a `--them` budget, one
  cell each, in the order given.
- **[G13-32]** Game seed `seed + k`, for `k` from 0, MUST be played twice in every cell, once with
  ours as player 0 and once as player 1, and every cell MUST play the same seeds. `--games` is per
  cell, rounded up to even. The deal comes from our engine's shuffler on that seed ([0001 E1-47]).
  Our engine is the referee: it decides what is legal, applies every move, and scores the game,
  ties included.
- **[G13-33]** A match is **repeatable** when neither side has a clock and `torchThreads` is 1. A
  repeatable match, rerun with the same arguments and the same cache, MUST play the same games
  move for move, whatever `--workers` is. The summary's header MUST say whether the match is
  repeatable, and if not, why; for a clock of theirs, that their evaluation cache depends on
  timing ([G13-28]).
- **[G13-34]** The harness MUST build our release binary first unless `--no-build`, and refuse a
  checkpoint without its parity file ([0011 Z11-13]) before any game starts.
- **[G13-35]** `--workers` games MUST run at once. The default is `⌊L ÷ t⌋`, where `L` is the
  machine's logical cores and `t` the larger of their `threads` and `torchThreads`, less one when
  `t` is 1. Each worker holds one host for its life and spawns one `serve` per game.
- **[G13-36]** A worker that dies, or a host or `serve` that ends with an error, MUST stop the
  match, keeping the games already written. It is not a disagreement.
- **[G13-37]** `play` MUST exit 0 when every game was played, disagreements or not, and non-zero
  when the match stopped.
- **[G13-38]** A move unanswered for `MOVE_TIMEOUT` MUST stop the match with an error naming the
  side, cell, seed and ply.

### Results and replay

- **[G13-39]** Each line of `<out>.jsonl` MUST hold the cell, seed, our seat, both final scores,
  the winner, the plies, and per move the side, action, simulations, milliseconds and value, with
  the proof's milliseconds for ours and `chunks` and `overrun` for theirs under a clock; or, for a game a disagreement ended, the ply and the report's path.
- **[G13-40]** `<out>.json` MUST hold a header and one entry per cell. The header: the match's
  arguments, our checkpoint and its sha256, the pin's commit and asset hashes, the build's options,
  torch's and NumPy's versions, the machine, whether the match was stopped, whether it was
  repeatable, and every resolved setting of both sides. Each cell: deal pairs counted, deal pairs
  left out with their reports, our wins, draws and losses, our score (a win 1, a draw ½) with a
  Wilson 95% interval over the counted games, the Elo difference it implies, our mean margin, our
  score from each seat, and each side's mean and 90th-percentile milliseconds and mean
  simulations per move. A deal pair counts only when both its games finished with no
  disagreement, so every counted deal was played from both seats.
- **[G13-41]** The summary MUST also be printed as a table, whose first line says that their
  player ran on the CPU, which is not how its author trained or measured it.
- **[G13-42]** A stopped match MUST still write `<out>.json` from the games in `<out>.jsonl`, with
  the header saying it was stopped. The summary MUST be computed from the `.jsonl` alone, by one
  function, whether the match finished or stopped.
- **[G13-43]** `grzhx replay <report>` MUST replay a disagreement report from its seed and moves,
  with our engine and a fresh lockstep game, running every comparison of [G13-17], and report the
  first failure. It exits 0 when the disagreement no longer reproduces, as `crosscheck replay`
  does ([0010 C10-24]). It searches nothing.

### `verify`, `timing` and the fairness note

- **[G13-44]** `grzhx verify --games <n>` (default 200) MUST play `n` games of uniformly random legal moves from
  recorded seeds, running every comparison of [G13-17] at every ply, plus one search of theirs on
  the lockstep state at 16 simulations per ply. It MUST print games, plies, round ends,
  disagreements, the deals that refilled the bag inside a factory, and the plies where a floor
  overflowed past seven tiles; write a report per disagreement as [G13-19] does; and exit 1 if
  there was a disagreement, or if either of the last two counts is zero, saying in that case that
  the run was too short to reach the case and that more games are needed. *A full census never
  empties bag and lid together, so a short deal is unreachable in a match and is not required
  here; their import refuses a census below 100, so the cross-check's short starts cannot be
  used.*
- **[G13-45]** `grzhx/README.md` MUST record the last `verify` run the pin was checked with: its
  date, games, plies, round ends, disagreements and the two counts of [G13-44].
- **[G13-46]** The package's suite MUST hold `convert.ts` to a fixture, `grzhx/fixtures/convert.json`,
  written by `grzhx fixtures` from `verify` games: for each recorded ply, our position, and the
  import arguments and deal order `convert.ts` produced, which their engine accepted and matched
  at that ply. The suite asserts `convert.ts` produces them again. *It catches a change to the
  translation, not a translation that was wrong when recorded: that is `verify`'s job, which is
  why `fixtures` writes nothing from a run with a disagreement.*
- **[G13-47]** `grzhx timing` MUST measure both sides one move at a time on every tenth
  non-terminal position of the latency corpus ([0011 Z11-38]), with one `serve` and one host, one
  position in flight, and a fresh search per position for both. It takes `--us` and `--them` as
  lists of counts, default `500,1000,2000,4000,8000,11300,16000` and
  `128,256,512,1024,2048,4096,8192`, and the settings of [G13-21]. It MUST also play `--games`
  games (default 20) of ours against theirs at the smallest count of each list, and record the
  mean and largest number of moves a player makes in a game. It writes `grzhx/timing.json`, and
  renders the README's table from it ([G13-48]).
- **[G13-48]** `grzhx/README.md` MUST carry the timing table between the lines `<!-- timing -->`
  and `<!-- /timing -->`: one row per side and count, with median, 90th-percentile and mean
  milliseconds per move; then the moves per game, the machine and the date; then how to estimate
  a cell's length, about `games × moves per game × (our mean + their mean) ÷ workers`. Beside it,
  the README MUST say that in a match with one tree and a count their search reuses its tree
  across a game's moves while `timing` searches each position fresh, so such a match's moves of
  theirs may cost less than the table says; that a clocked move of theirs is not the search of the
  count it reached ([G13-28]); and that our endgame proof's time is on top of the table's search
  time ([G13-29]). The suite MUST check the committed table is exactly what `timing.json` renders to.
- **[G13-49]** `grzhx/FAIRNESS.md` MUST audit whether a match gives their player the game it plays
  in its own programs: the settings against `audit_ai.py`'s and against the local player in the
  release's `.zip`, read from the cached archive, naming each default of [G13-23] that differs
  from the local player's; that their clock is borrowed from its advice mode, since its AI moves
  only on a count, and whether `chunk` and the vote of [G13-28] match that mode; the information each side is given; where the two are treated differently, our
  endgame proof outside the clock among them, and in whose favour. It MUST name the pinned commit and release,
  and the suite MUST check that they are the ones in `pinned.json`.

## Interfaces

```text
pnpm -F alphazero-bot grzhx play   [--games n] [--seed n] [--us spec,...] [--them spec,...]
                                   [--us-set k=v]... [--them-set k=v]... [--workers n]
                                   [--out path] [--cache dir] [--no-build]
pnpm -F alphazero-bot grzhx info   [the settings of play]
pnpm -F alphazero-bot grzhx verify [--games n] [--seed n] [--cache dir]
pnpm -F alphazero-bot grzhx replay <report.json>
pnpm -F alphazero-bot grzhx timing [--us n,...] [--them n,...] [--us-set k=v]... [--them-set k=v]...
                                   [--games n]
pnpm -F alphazero-bot grzhx fixtures | fetch | check-updates | pin <commit> <tag>
pnpm -F alphazero-bot test:grzhx   # [G13-51]: needs the cache, the host's environment and a build
```

The `grzhx` script bundles the harness and runs it, as `tile` does.

## Invariants

- No file tracked in the repository is byte for byte a file of theirs ([G13-4]).
- Their search plays only on the lockstep state, which has been dealt only tiles our engine dealt
  and stepped only by moves our engine applied ([G13-12], [G13-13]).
- Neither side is handed the bag's order or a seed derived from our shuffler ([G13-13],
  [G13-15], [G13-16]).
- Every counted deal pair finished both games with no disagreement ([G13-40]).
- A repeatable match replays move for move ([G13-33]).

## Verification

- **[G13-50]** The package's vitest suite, which needs no cache, MUST cover: [G13-4]; the
  fixture of [G13-46]; the grid, seeds and seats of [G13-31] and [G13-32] for several `--workers`;
  the setting parser's refusals of [G13-21] and the clamps of [G13-24]; [G13-22]'s config copy;
  the `--workers` default of [G13-35]; the summary of [G13-40] and [G13-42] from a fixture `.jsonl`
  with a stopped match and a deal pair holding one disagreement; [G13-48]'s table; [G13-49]'s
  names; [G13-34]'s refusal of a checkpoint without its parity file; and, against a fake host and
  a fake `serve` that it scripts, [G13-36], [G13-37], [G13-38], [G13-39]'s line contents,
  [G13-29]'s split of search and proof milliseconds through to the summary, and
  [G13-16]'s framing: the bytes the fake `serve` receives for two states that differ only in the
  bag's order and the shuffler's seed MUST be identical.
- **[G13-51]** `pnpm -F alphazero-bot test:grzhx`, a separate script outside the root suite,
  MUST cover what needs the cache, the environment and a build:
  - [G13-3]'s checks, by fetching into a scratch cache with one asset's pinned hash altered;
  - [G13-9]'s refusal of an actor with one byte flipped;
  - one game of theirs against itself at 256 simulations, both seats through the host, played
    twice, with every comparison of [G13-17] passing, the same moves both times, and every move
    equal to the native action of a `PipelineSearch` the test drives itself, over a second manual
    game it deals the same tiles ([G13-13]);
  - two host games run as a match runs them, one search object per seat, each seat's moves fed
    to the other as its opponent's, at 256 simulations: their search's reused nodes, read from
    `azul_search_diagnostics`, above zero on some plies after each seat's first ([G13-13]).
    *In a match the next root is two plies below the last, under a reply the other side chose,
    so reuse is rarer than in one search object's self-play, where it is one ply below; the case
    tests the configuration a match uses.*
  - a `trees: 3` move equal to `evaluate_tree_counts.py`'s vote on the same position and seed;
  - clocked moves of theirs at 50 ms and at 5 s with `chunk` 256: at 50 ms exactly one chunk and
    a positive `overrun`; at 5 s `simulations` equal to `chunks × 256`; and, from the host's own
    record of each move, a vote tally summing to `chunks`, each recorded chunk action equal to that
    chunk's native decision as the host read it, and the move equal to `rank_search_actions`
    over exactly those actions, recomputed by the test without searching again ([G13-28]);
  - [G13-25]'s refusal of `candidates=0` by their library;
  - [G13-43]'s replay of a report made by mutating one deal tile, exiting 1, and of a clean ply,
    exiting 0.
- **[G13-52]** Each mutation below MUST have been seen to turn the named check red before the
  check is kept, made in a copy with its landing confirmed (CLAUDE.md, *Mutation testing*), and
  recorded beside the check:

  | Mutation | Must fail |
  | --- | --- |
  | `convert.ts` sending the floor count without the marker | `verify`, and [G13-46] |
  | `convert.ts` sending the floor count uncapped at seven | [G13-51]'s full-floor case |
  | `convert.ts` leaving the lid out of the discard counts | `verify`, and [G13-46] |
  | `convert.ts` sending the round 0-based | `verify`, and [G13-46] |
  | the deal order putting post-refill tiles first in the refilling factory | [G13-50]'s deal-order case and [G13-46]'s fixture |
  | the host searching the imported state instead of the lockstep state | [G13-51]'s reuse case |
  | the host playing the policy's most probable action | [G13-51]'s `PipelineSearch` case |
  | a tracked file holding a copy of one of their blobs | [G13-4] |
  | `timing.json` edited after the table was rendered | [G13-48] |
  | `serve --clock-ms` answering with the ceiling's move | [0011 Z11-78]'s `serve` case |
  | `framedPosition` building the block from a state other than `fromJSON(position, 0)` (its bag reversed) | [G13-50]'s framing case |
  | a report's illegal last move left out of its `moves`, or replayed without our rules' check | [G13-51]'s replay case |
  | the clocked vote counting the abandoned chunk's partial decision | [G13-51]'s clock case |

  *The first three are mistakes the tile harness's translation made when it was written; their
  engine takes a position the same way.*
- **[G13-53]** Every requirement in this document MUST be either cited by a test in
  `packages/alphazero-bot`, by identifier, or listed with a reason in the *Traceability
  exemptions* table, enforced by a `traceability-0013` test beside 0011's and 0012's. Which
  requirements only [G13-51] holds, which the root suite never runs, the table below says.

### Which check holds which requirement

| Requirements | Held by |
| --- | --- |
| [G13-1], [G13-4] | the pin's and the tripwire's cases, needing no cache |
| [G13-14], [G13-15], [G13-16], [G13-19], [G13-21], [G13-22], [G13-29], [G13-31], [G13-32], [G13-34] to [G13-42], [G13-46], [G13-48], [G13-49] | [G13-50]. Its timeout case checks only that the error stops the match and names where; the reader's own timeout, and a process that exits or is missing, are its real-process cases |
| [G13-33] | [G13-50]'s fake matches hold that the worker count does not change which games are played; [G13-51]'s game played twice through one host holds that nothing carries from one game to the next |
| [G13-3], [G13-9], [G13-11], [G13-12], [G13-13], [G13-15], [G13-17], [G13-20], [G13-23], [G13-24], [G13-25], [G13-28], [G13-33], [G13-43] | [G13-51], run by `test:grzhx` alone |
| [G13-14], [G13-15], [G13-17], [G13-19], [G13-20] | also `verify` |
| [G13-16]'s import ban | also the source check of [0011 Z11-3], extended to `grzhx/` |
| [G13-27] | [0011 Z11-78]'s cases in the crate's suite |

### Traceability exemptions

| Requirement | Why it is not testable here |
| --- | --- |
| [G13-2], [G13-5] | Commands that move the pin or ask GitHub, run on purpose against the network. |
| [G13-6], [G13-7] | Build steps, run by every command that needs the cache; [G13-51] runs on their product. |
| [G13-8], [G13-10] | Properties of the host's source and protocol, exercised by every [G13-51] case and reviewed rather than asserted. |
| [G13-18] | A rule about what a report does not say. |
| [G13-26] | A command's printed output. |
| [G13-30] | Structural: `play`, `timing` and `info` call one function in `cli.ts`, and none resolves a setting anywhere else. |
| [G13-44], [G13-45], [G13-47] | Lanes run on purpose, with the cache, on an idle machine, and the README a person writes from them. |
| [G13-52] | A process promise about how checks were kept. |
| [G13-54] | A process promise about what lands in which commit. |

## Amendments

Identifiers are append-only. A widened requirement is edited in place, and a new one takes the
next free number.

- **[G13-54]** These amendments MUST land in 0011 in the same change as the code that needs
  them, as [0012 T12-32] required of its own.

### To 0011 — AlphaZero training

| Requirement | Amendment |
| --- | --- |
| [0011 Z11-18] | Widen: a search runs exactly its configured simulations unless its caller stops it after a whole simulation ([0011 Z11-78]). Nothing in the crate's library reads a clock. |
| [0011 Z11-23] | Extend: `play` and `serve` take `--clock-ms <n>`. The command reads the clock and stops the search through [0011 Z11-78]; the second word is then the simulations run. `playSimulations` is the ceiling. |
| [0011 Z11-24] | Carve out `--clock-ms`: the simulations run may differ between runs. Given the count it reports, the action and value are those `play` returns configured for that count, bit for bit. |
| [0011 Z11-60] | Widen: `--clock-ms` is a stop the command applies, not a search setting. The count, as before, comes only from the config, through the one function. |
| [0011 Z11-72] | Extend: under `--clock-ms`, each answer is the one `play` gives that position configured for the count `serve` reports. Under `--split-ms` ([0011 Z11-79]), each answer has five words. |
| [0011 Z11-3] | Extend: the source check covers `grzhx/`, the host included, and also fails there on an import of `eval/chooser.ts` ([G13-16]). Like every clause of [0011 Z11-47], the new one carries a fixture source it rejects. |
| [0011 Z11-4] | Add the scripts `grzhx` and `test:grzhx`. The root `pnpm test` runs [G13-50] with the lanes' vitest suite, and does not run `test:grzhx`, for the reason it does not run `test:train`. |
| New, [0011 Z11-78] | The library MUST let a caller stop a search after any whole simulation, at least one, without reading a clock itself. A search stopped after `k` simulations MUST return the action, visits and value that a search configured for `k` returns, bit for bit, and the endgame proof follows it as it follows any search. The crate's suite MUST assert it at several `k` on several latency-corpus positions, and MUST assert that `serve --clock-ms 0` answers each position with one simulation and the move `play` makes at `playSimulations: 1`. |
| New, [0011 Z11-79] | `serve --split-ms` MUST answer each position in five words: [0011 Z11-23]'s first three, then the search's milliseconds and the endgame proof's, read by the command around each part. `play` and `serve` (through `choose_memoised`) MUST be split the same way, and MUST still answer exactly as `choose` and `choose_memoised` would. Without the flag `serve`'s answer is exactly as before, so `eval/chooser.ts` and the ladder hash ([0011 Z11-63]) are untouched. The crate's suite MUST assert both forms, and that with the proof off the fifth word is 0. |

*[0011 Z11-78] and [0011 Z11-79] are 0011's next free numbers as this is written; if another amendment takes it
first, these take the next.*

## References

- Intent [0015 — Our master against another AlphaZero](../intent/0015-master-against-another-alphazero.md)
- Spec [0011 — AlphaZero training](0011-alphazero-training.md): our player, and amended here
- Spec [0012 — Master opponent](0012-master-opponent.md): the shipped milestone and its endgame cap
- Spec [0010 — Engines cross-checked](0010-engines-cross-checked.md): the canonical block, replay,
  and how a disagreement between engines is ruled on
- `packages/alphazero-bot/tile/README.md` and `FAIRNESS.md`: the harness this one follows
- [grzhx/azul-alpha-zero](https://github.com/grzhx/azul-alpha-zero) at the pinned commit, and
  release [v2300.1](https://github.com/grzhx/azul-alpha-zero/releases/tag/v2300.1)
