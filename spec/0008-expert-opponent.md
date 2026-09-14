---
title: Expert opponent
author: Gabriel Cangussu
date: 2026-09-11
status: implemented
intent: 0006 — A learned opponent
prefix: A8
depends-on: 0001 — Engine core, 0004 — Computer opponent, 0005 — Opponent strength, 0006 — Opponent in the interface
summary: >
  The fourth difficulty, expert: a port of a published AlphaZero-style Azul
  player — its network, its search, its settings and its tree lifetime —
  running on our engine in a package of its own, and the lane that decides
  whether it ships. Amends 0001, 0003, 0005 and 0006; leaves 0004 untouched.
---

# Expert opponent

## Scope

Covers `packages/ai-bot`: the board encoding, the network, the search, the per-game session, the
fixtures that prove all four against the original, and the lane that decides whether it ships.

Does not cover `bot`'s player. *0004 — Computer opponent* is unchanged by this document, and
[0004 B4-1] and [0004 B4-32] stay true as written: `expert` is not a tier of `bot`, but a second
package the interface reaches beside the first. The one edit to `packages/bot` is a single export
line in its manifest, so the arena can be imported ([0005 M5-32]). It changes no source,
no test and no behaviour. Training is out of scope, and so is speed: intent 0006 excludes both,
and this document sets no time budget.

It **amends** four specs, in the manner of *0006*. The edits are enumerated in *Amendments* and
land in those files together with the code that needs them ([A8-47]).

### What "the original" is, and what replicating it means

The original is one specific program: `azul/` in
[cestpasphoto/alpha-zero-general](https://github.com/cestpasphoto/alpha-zero-general) at commit
`5d6d1f129b76659837f6afd6fb082e8da57e5428`, playing the checkpoint `azul/pretrained.pt` the way
`pit.py` plays it. That means inference goes through ONNX Runtime, as `GenericNNetWrapper`'s
`inference` target selects. Intent 0006 asks for "a faithful copy of how it plays", which this spec
reads as five things kept the same: the input the network sees, the network, the search and its
settings, the guess about what a future round deals, and the lifetime of the search tree.

The original's **rules** are not copied. Intent 0006 says our engine decides what is legal and what
happens. Where the two programs disagree about a rule, ours wins, and the disagreement is listed in
*Known deviations* by a name the fixture tests use.

### The one place this departs from 0004's discipline

`bot` refuses to search past the end of a round ([0004 B4-6]), because the next deal comes from a
bag whose order no player knows. The original does search past it. It guesses the deal with a fixed
pseudo-random draw computed from the bag's **counts**, which it calls a *universe*. This package
does the same ([A8-22]), because that is how the original plays. It is a guess and not a peek: the
input is what both players can already see. [A8-5] and [A8-7] keep it that way, and [A8-36] checks
the guess ply by ply against the original's. The barrier of [0004 B4-5] is kept. What is given up
is only 0004's refusal to guess, and that refusal belongs to `bot`, not to a rule of the project.

### Tree lifetime, and how the existing tiers opt out

The original keeps its search tree for the length of a game. `pit.py` builds one `MCTS` object per
player, and `Arena.playGame` discards it when the game ends. A move is therefore a function of the
game so far, not of the position alone. This spec keeps that behaviour ([A8-26]), and reads intent
0006's "the same position gets the same move every time" as "the same game gets the same moves"
([A8-27]). A fresh session is still a pure function of the position.

The state lives in an explicit **session**, owned by whoever plays the game. In the interface that
is the worker ([0006 W6-40]); in the gate it is the lane, which builds fresh sessions for
every game ([A8-30]). The existing tiers opt out by doing nothing: `chooseMove` stays a stateless
function, nothing here gives `bot` a session, and a caller that never asks for `expert` never
creates one.

## Definitions

Terms from *0001* (action, ply, round, seat), *0004* (tier, boundary ply) and *0006* (seating,
request, generation) keep their meaning.

| Term | Meaning |
| --- | --- |
| **Original** | The program named in *Scope*, at the pinned commit, with ONNX Runtime inference. |
| **Reference search** | The original's search with its `numba` functions recompiled with `fastmath=False`, and nothing else changed ([A8-38]). |
| **Checkpoint** | `azul/pretrained.pt` at that commit: sha256 `7d2fbf9203e46837668cd5b8f7bb29b7ea6f9e500f25f148c79e0038a76fe2f9`, last changed upstream in `6b75052`. |
| **Board** | The original's 23×6 grid of 8-bit integers, from one seat's perspective ([A8-8]). |
| **Board key** | The board's 138 values in row-major order. Two positions with equal keys are one node ([A8-10]). |
| **Their action** | The original's action index, `0..179` ([A8-11]). |
| **Perspective** | The seat to move. "Me" is `position.currentPlayer`; "them" is the other seat. |
| **Session** | One `Expert`: the node table for one seat of one game ([A8-26]). |
| **Simulation** | One descent from the root to a leaf, and the backup along it ([A8-18]). |
| **Universe draw** | The original's deterministic guess at a deal, a pure function of bag counts ([A8-22]). |
| **Deviation condition** | A named case in *Known deviations*, decidable from the original's board and the ply. |

Constants, read from the checkpoint's stored arguments and from `pit.py`. [A8-34] records them from
the original:

| Constant | Value | Source in the original |
| --- | --- | --- |
| `simulations` | 100 | checkpoint `numMCTSSims`, used by `pit.py` |
| `cpuct` | 0.5 | checkpoint `cpuct` |
| `fpu` | 0.05 | checkpoint `fpu` |
| `forcedPlayouts` | `true` | checkpoint `forced_playouts` |
| `k` | 0.5 | `MCTS.py` constant |
| `universeSeed` | 31416 | `magic_seeds[0]`, because checkpoint `universes` is 1 |
| `drawValue` | 0.01 | `check_end_game`, both seats |
| `EPS` | 1e-8 | `MCTS.py` |
| `DRAW_MULTIPLIER` | 4594591 | `select_tiles_from_bag` |

`pit.py` sets `prob_fullMCTS` to 1 and builds its `MCTS` without Dirichlet noise, so every search
is a full search with no noise. Neither setting has a counterpart here. Upstream's tree pruning
(`MCTS.getActionProb`, active because `no_mem_optim` is false) is not ported either: it runs only
once the round passes 20, and it discards only nodes from rounds more than five behind the current
one. The round is part of every board key, so a discarded node is one no later search can reach,
and dropping the pruning changes no choice.

## Data model

### The board

Rows run top to bottom and columns 0 to 5. Colours use the engine's order, which is also the
original's: blue, yellow, red, black, teal (the original calls it white). Any cell the table does
not mention is 0.

| Row | Columns 0–4 | Column 5 | Taken from `AzulJSON` |
| --- | --- | --- | --- |
| 0 | `[my score, their score, round + 1, 0, 0]` | 0 | `players[·].score` ([A8-9]), `round` |
| 1 | bag count per colour | 0 | `bag` |
| 2 | **lid plus both floors**, per colour | 0 | `lid[c] + players[0].floor[c] + players[1].floor[c]` |
| 3 | centre count per colour | 1 if the marker is in the centre | `center`, `markerInCenter` |
| 4–8 | display `0..4`, count per colour | 0 | `factories` |
| 9 | my pattern-line colours, `-1` when empty | 1 if I hold the marker | `patternLines[r].color`, `floorMarker` |
| 10 | their pattern-line colours, `-1` when empty | 1 if they hold the marker | the same, for them |
| 11 | my pattern-line counts | my floor count: tiles plus marker | `patternLines[r].count`, `Σ floor + floorMarker` |
| 12 | their pattern-line counts | their floor count | the same, for them |
| 13–17 | my wall, rows `0..4` | 0 | `wall` |
| 18–22 | their wall, rows `0..4` | 0 | `wall` |

Row 2 counts the floors because the original moves a tile to its discard pile the moment the tile
reaches a floor line, while our engine keeps it there until the round ends ([0001 E1-3]). The sum is
the same number.

### Actions

Both programs encode an action as `source * 30 + color * 6 + destination`, with destination `5` for
the floor. They differ only in where the centre sits: for us it is source `5` (`CENTER`), for the
original source `0`, with displays `0..4` becoming `1..5`.

```
theirs(a) = ((source(a) + 1) % 6) * 30 + color(a) * 6 + destination(a)
```

### Interfaces

```ts
interface ExpertOptions {
  /** Simulations per `choose`. Defaults to 100. For the fast suite only [A8-40]. */
  simulations?: number;
}

/** What a session returns. Plain, structurally cloneable data [A8-29]. */
interface ExpertChoice {
  /** Always a member of `position.legalActions` [A8-42]. Our encoding, not theirs. */
  action: number;
  /** The root's running value for the seat to move, in [-1, 1]. Not points [A8-24]. */
  value: number;
  /** Simulations run by this call. */
  simulations: number;
  /** The chosen action's visit count at the root, this session's history included. */
  rootVisits: number;
}

interface Expert {
  choose(position: AzulJSON): ExpertChoice;
}

function createExpert(options?: ExpertOptions): Expert;         // [A8-26]
function encodeBoard(position: AzulJSON): Int8Array;            // [A8-8]; length 138
function toTheirAction(action: number): number;                 // [A8-11]
function fromTheirAction(theirs: number): number;               // [A8-11]
const EXPERT: Readonly<{                                        // the constants table
  simulations: 100; cpuct: 0.5; fpu: 0.05; forcedPlayouts: true;
  k: 0.5; universeSeed: 31416; drawValue: 0.01;
}>;
```

## Behaviour

### Package

- **[A8-1]** `packages/ai-bot` MUST declare exactly one runtime dependency, `engine`, as a
  workspace dependency. It MAY declare `bot` as a **dev**Dependency. Only the lane of [A8-30] and
  the tests may import `bot`; nothing under `src/` may import `bot` or `ui`.
- **[A8-2]** The package MUST NOT touch the DOM, the network, the filesystem or storage. It MUST
  NOT read a clock, and MUST NOT consult `Math.random` or an `Rng`. There is no fail-safe, so a
  search is never curtailed.

  *`bot` needs a wall clock for [0004 B4-28] because its budget is large enough to starve a phone.
  This package's budget is 100 simulations, and intent 0006 puts speed out of scope. A clock here
  would be one more way to make [A8-27] false, and it would buy nothing.*

- **[A8-3]** The package MUST NOT hold module-level mutable state. All mutable state MUST live in
  a session, and two sessions in one process, interleaved or not, MUST NOT influence each other.
  The weights are no exception ([A8-15]).
- **[A8-4]** `choose` MUST be synchronous and MUST NOT schedule work. Keeping the page alive is
  the worker's job ([0006 W6-10]), exactly as it is for `bot` ([0004 B4-4]).
- **[A8-48]** `packages/ai-bot` MUST ship the original's `LICENSE` file verbatim as
  `packages/ai-bot/LICENSE.alpha-zero-general`: MIT, "Copyright (c) 2018 Surag Nair". The
  generated weights module's header ([A8-15]) MUST name that file. A test MUST assert that the
  file exists and that its sha256 equals the one recorded by [A8-34].

  *Intent 0006: "credit its authors, and follow its open-source licence". MIT requires the notice
  to travel with substantial portions, and the port of the search and encoder, plus the weights,
  are exactly that.*

### Arithmetic that repeats on every machine

- **[A8-49]** Nothing under `src/` may call a function that ECMA-262 marks
  *implementation-approximated*: `Math.exp`, `Math.log`, `Math.tanh`, `Math.pow`, the `**`
  operator, and the rest of that list. Where the network needs `exp`, the package MUST implement it
  from IEEE-754 basic operations alone, as a port of fdlibm's `__ieee754_exp`. `tanh` and the
  softmax are then built from that `exp`. `Math.sqrt` and `Math.fround` are exact by specification
  and are permitted.

  *Without this, [A8-27]'s "on any machine" is false in the one place it matters. V8,
  SpiderMonkey and JavaScriptCore may disagree in the last bit of `Math.exp`. That can flip a
  near-tie in visits, the tree carries the flip through the rest of the game, and [0006 W6-4]'s
  "seed, seating and moves replay the whole game" quietly stops holding across browsers. Neither
  `engine` nor `bot` calls any of these functions today, so this package would otherwise be the
  first result in the repository to depend on the JavaScript engine.*

### What it may know

- **[A8-5]** A session MUST be handed a position as `AzulJSON` and nothing else. It builds every
  state it searches from that value, through the engine ([A8-22]).
- **[A8-6]** The board ([A8-8]) is an input to the network and a key to the node table, and
  nothing more. Legality MUST come from `legalActions`, transitions from `apply`, and results from
  `outcome` and `isTerminal`. Nothing in the package may compute any of these from the board.

  *[0004 B4-8]'s line, drawn in the same place. The original's own rules are exactly the second
  copy this repository is organised against, and the board is where one would creep in.*

- **[A8-7]** The universe draw of [A8-22] MUST be the only source of the tiles dealt inside a
  search, and its only inputs MUST be bag and lid counts.

### The board

- **[A8-8]** `encodeBoard(position)` MUST return the board of the table in *Data model*, from the
  perspective of `position.currentPlayer`, as 138 values in row-major order.
- **[A8-9]** A score MUST be encoded **saturated** to 127. No other field can leave `[-128, 127]`.

  *The original keeps scores in 8 bits. A score that crosses 127 while walls are tiled wraps
  negative, and then the floor penalty's `max(score − penalty, 0)` (`score_round`) clamps it to 0 in
  the same call. So the original's network has never seen a score above 127 or below 0 on any board
  it evaluated. 127 is the nearest value it has seen. Encoding the wrap instead would feed it the
  one class of value it has certainly never met. The original's own game in this situation is
  listed under* Known deviations.

- **[A8-10]** The node table MUST be keyed by the board key. Two positions reached by different
  paths that encode to the same board MUST share one node, as they do in the original.

  *This is how the original handles transpositions. It cannot be dropped as an optimisation:
  merging paths merges visit counts, and visit counts choose the move.*

- **[A8-11]** `toTheirAction` and `fromTheirAction` MUST be exact inverses over `0..179`, and MUST
  implement the formula in *Data model*.
- **[A8-12]** For every fixture position, the set of `toTheirAction` over `legalActions` MUST
  equal the set of actions the original's `valid_moves` accepts on the encoded board.

### Known deviations

Every place the two programs disagree. Each follows from our engine deciding the rules. The
fixture tests recognise each case by its condition, report it by name, and treat any disagreement
not listed here as a failure ([A8-36], [A8-38]).

| Name | Condition | Our engine | The original | Consequence here |
| --- | --- | --- | --- | --- |
| `terminal-deal` | The ply ends the game. | Ends before any refill ([0001 E1-36]). | Deals five displays and increments the round, then scores bonuses (`make_move` → `setup_new_round` → `check_game_over`). | After this ply only row 0's two scores and rows 9–22 can be compared. The search is unaffected: a terminal node is valued by [A8-18] step 1 before any board is read. |
| `floor-overflow` | A floor count on the original's board exceeds 7. | Tiles past the seventh slot go to the lid ([0001 E1-20]). The marker is placed regardless, so up to 8 slots show. | The count keeps rising; only the penalty is capped. | Rows 11–12, column 5 differ from then on. |
| `no-centre-take` | A round ends with the marker still in the centre. | The other seat starts ([0001 E1-31]). | Inside a search, which calls `make_move(a, 0)` on the canonical board, the last mover starts. | The next round opens from the other perspective. On this ply the boards are compared **with the seats swapped**: row 0's two scores, rows 9↔10, 11↔12 and 13–17↔18–22. Rows 1–8, which hold the deal, and the round in row 0 are compared as they are. |
| `score-wrap` | A score would reach 128. | The score is kept; the encoding saturates ([A8-9]). The winner comes from `outcome`. | The score wraps while walls are tiled, and the floor step clamps it to 0 in the same `score_round` call. In `score_bonuses` it wraps, and `check_end_game` compares wrapped scores. | Row 0 differs, and so can a terminal value. |
| `exhausted` | Bag and lid are both empty at a refill. | The game ends ([0001 E1-37]). | Its draw divides by zero. | Unreachable in a game dealt from a full census ([0001 E1-37]). Listed only for completeness. |
| `late-tie` | An exact tie in root visits, once `pit.py`'s temperature is at or below 0.02 (about ply 47). | Lowest action index ([A8-24]). | Random. | The same move whenever the original's pick is not random. |

### The network

- **[A8-13]** The forward pass MUST compute the function the original evaluates: the checkpoint's
  network (`nn_version` 84) in eval mode, as exported to ONNX Runtime by `GenericNNetWrapper`.
  Dropout is the identity, and batch normalisation uses its running statistics with ε = 1e-5. The
  input is the board as numbers, unscaled, with shape 23×6 (23 channels of length 6). Arithmetic is
  float64, under [A8-49].

  | Stage | Shape out | Composition |
  | --- | --- | --- |
  | `first_layer` | 23×6 | linear across channels 23→23, no bias; batch norm; no activation |
  | `trunk.0` | 23×6 | inverted residual, expand 115, ReLU, squeeze-excite 32, residual add |
  | policy `output_layers_PI.0` | 46×6 | inverted residual, expand 115, Hardswish, squeeze-excite 32, no residual |
  | policy tail | 180 | flatten to 276, linear 276→180, ReLU, linear 180→180, mask, softmax |
  | value `output_layers_V.0` | 23×6 | inverted residual, expand 46, Hardswish, squeeze-excite 16, residual add |
  | value tail | 2 | flatten to 138, linear 138→2, ReLU, linear 2→2, tanh |

  An **inverted residual** block is:
  1. *expand*: linear across channels, no bias; batch norm; the activation;
  2. *mix*: a 6→6 linear along each channel's length, shared across channels, no bias; batch norm;
     the activation (upstream calls it `depthwise`);
  3. *squeeze-excite*: the mean over the length, then linear with bias, ReLU, linear with bias,
     Hardsigmoid, scaling each channel;
  4. *project*: linear across channels, no bias; batch norm; no activation;
  5. the residual add, when input and output widths are equal.

  Flattening is channel-major (`c * 6 + l`). The mask replaces every illegal logit with `-1e8`
  before the softmax. The original computes `exp` of a log-softmax, which is the same function.
  Hardswish is `x · relu6(x + 3) / 6`; Hardsigmoid is `relu6(x + 3) / 6`.

  *Squeeze-excite is present in **every** block, the trunk included. Upstream turns it on by
  passing the strings `"RE"` and `"HS"` where a boolean is expected, and a non-empty string is true.
  A port written from the constructor's apparent intent, rather than from the weights, will leave
  it out. The checkpoint's `se.fc1`/`se.fc2` tensors in all three blocks are the evidence, and
  [A8-37] is the check.*

- **[A8-14]** The network MUST return the policy as probabilities indexed by **their** action, and
  the value as a pair `[me, them]`.
- **[A8-15]** The weights MUST come from a generated module in `packages/ai-bot/src`, produced from
  the checkpoint's `state_dict` by a committed script under `packages/ai-bot/tools`. The module
  MUST export only immutable values:
  - one string constant holding every tensor as little-endian float32, base64-encoded, concatenated
    in a recorded order;
  - a frozen table of tensor names, shapes and offsets.

  Each session MUST decode its own typed arrays from the string, and MUST NOT share them. The
  module MUST open with a header naming the upstream commit, the checkpoint's sha256, the script,
  and the licence file of [A8-48]. The script MUST refuse a checkpoint whose sha256 differs.
  Regenerating the module is a deliberate act with a commit message, like [0005 M5-31]'s reference
  values.

  *A typed array cannot be frozen, so a module-level `Float32Array` would be exactly the mutable
  state [A8-3] forbids. A string can't be written to, and decoding one per session is a
  negligible cost against a budget intent 0006 does not set.*

- **[A8-16]** The `num_batches_tracked` buffers MUST be omitted, and every other tensor of the
  `state_dict` MUST be in the table. A test MUST fail if the table's names and shapes differ from
  those the script recorded.

### The search

This is a port of the original's `MCTS.search`, `pick_highest_UCB` and `getActionProb`, restricted
to the path `pit.py` takes. For each node the session stores its legal mask, its prior `P` (by
their action), its visit count `Ns`, its running value `Qs`, and per action `Nsa` and `Qsa`, where
`Qsa` starts unset.

- **[A8-17]** The node table MUST belong to the session, and MUST store statistics only. States
  are re-derived on every simulation by `clone` and `apply` ([A8-21]), as the original re-derives
  its boards.
- **[A8-18]** A simulation at a node with state `s`, viewed from `s.currentPlayer`, MUST do exactly
  this:
  1. If `s` is terminal, return `[1, -1]` if the seat to move won, `[-1, 1]` if it lost, and
     `[fround(0.01), fround(0.01)]` on a draw, with the winner taken from `outcome`
     ([0001 E1-39]). The values are float32, as `check_end_game` builds them ([A8-50]).
  2. If the node has not been expanded, evaluate the network on `encodeBoard(toJSON(s))`. Then:
     - set `P` to the policy normalised to sum to 1 ([A8-50]);
     - set `Ns = 0`, every `Nsa = 0` and every `Qsa` unset;
     - set `Qs` to the value's first component;
     - return the value.
  3. Otherwise select an action `a` ([A8-19]) and compute the child
     `apply(clone(s), fromTheirAction(a))`. Simulate the child and call its result `v`. If the
     child's `currentPlayer` differs from `s.currentPlayer`, swap `v`'s components. Then update, in
     this order:
     1. `Qsa[a] ← (Nsa[a] · Qsa[a] + v[0]) / (Nsa[a] + 1)`, counting an unset `Qsa[a]` as 0 when
        `Nsa[a] = 0`;
     2. `Qs ← ((Ns + 1) · Qs + v[0]) / (Ns + 2)`;
     3. `Nsa[a] ← Nsa[a] + 1`;
     4. `Ns ← Ns + 1`.

     Return `v`.
- **[A8-50]** The search MUST reproduce the original's number types:
  - `P`, every value the network returns, and every terminal value of [A8-18] step 1 are float32.
  - `Qs` is float32, as NumPy 2 computes it ([A8-34] pins the version): it MUST be rounded with
    `Math.fround` when set and after every arithmetic step of its update.
  - `Qsa` is float64.
  - Every `u` of [A8-19] is computed in float64 from those stored values.
  - `P` MUST be normalised as the reference search normalises it. The sum is a float32 running
    total: it starts at 0, adds all 180 entries in ascending order of their index, and is rounded
    with `Math.fround` after every addition. Then each entry is divided by that sum and rounded to
    float32. This is numba's `sum` of a float32 array compiled without `fastmath`: a sequential
    accumulation in the array's own type.
  - A `P` supplied by [A8-38]'s lookup is already normalised, and MUST be used as given, not
    normalised again. [A8-53] checks the normalisation separately.

  *Because the original's numbers are these types, **under NumPy 2**, which [A8-34] pins. ONNX
  Runtime returns float32, and `MCTS.search` stores `v[0]` as `Qs`. NumPy 2's scalar promotion
  (NEP 50) treats the Python int `Ns` as weak, so it keeps `((Ns + 1) · Qs + v[0]) / (Ns + 2)` in
  float32. NumPy 1.x promotes the same expression to float64 from a node's first update on, so the
  original's arithmetic depends on the NumPy it runs under, and upstream pins none.
  NumPy 2 is chosen because a fresh install of upstream's unpinned dependency list resolves to it
  today. What matters more is that the choice is written down and enforced ([A8-34]), rather than
  inherited from whichever environment ran the generator. `Qsa` is a float64 array under either
  version. `Qs` feeds every first-play-urgency score in [A8-19], so a float64 `Qs` moves
  comparisons between visited and unvisited actions that sit within about 1e-7 of each other.
  `Math.fround` of a double's sum, difference, product or quotient equals the correctly rounded
  float32 result, so step-by-step rounding reproduces float32 exactly.*

- **[A8-19]** Selection MUST visit the legal actions in ascending order of **their** action index.
  For each, in order:
  1. If `forcedPlayouts` is set **and this is the node the simulation started from**, and
     `Nsa[a] < ⌊√(k · P[a] · i)⌋`, select `a` immediately. Here `i` is the 0-based index of the
     current simulation within the current `choose` call.

     *Only at that node. `MCTS.search` takes `forced_playouts` as a parameter defaulting to
     `False`, `getActionProb` passes it when it starts a simulation, and the recursive call is
     written `self.search(next_s)` — so the flag is false at every node below the first. An
     earlier reading of this requirement said the bound applied at every node of the descent;
     that explores a different tree, and [A8-38] caught it by reaching boards the original never
     evaluated.*
  2. Otherwise score `u = Qsa[a] + cpuct · P[a] · √Ns / (1 + Nsa[a])` if `Qsa[a]` is set, and
     `u = (Qs − fpu) + cpuct · P[a] · √(Ns + EPS)` if it is not.

  The action with the **strictly** greatest `u` is selected, so on a tie the lowest of their
  indices wins.

  Every expression here MUST be evaluated left to right, as written in `pick_highest_UCB`. `Qs −
  fpu` is formed once per node, before the loop. The exploration term is
  `cpuct · P[a] · √Ns / (1 + Nsa[a])` in that order, and the forced-playout bound is
  `⌊√(k · P[a] · i)⌋`, likewise. Reassociating any of them changes the last bit, and with it
  [A8-38].

  *The order is theirs for two reasons, and either one alone would decide it. A forced playout
  selects the **first** qualifying action in iteration order, so the order is visible without any
  tie. And the tie-break is by first-seen. Iterating in our encoding puts the centre last instead of
  first.*

- **[A8-20]** The sign MUST follow `currentPlayer`, never ply parity. This is the trap of
  [0004 B4-18], handled the original's way: a boundary ply can leave the same seat to move, and
  step 3 of [A8-18] swaps the value only when the seat changes.
- **[A8-21]** Every child MUST be produced by `apply` on a `clone` ([0001 E1-48]), starting from
  the root of [A8-22]. No state may be reached any other way, and no state may be edited.
- **[A8-22]** Each `choose` MUST build its root state as

  ```
  fromCanonical({ ...toCanonical(fromJSON(position, 0)), bag: universeOrder(position.bag) },
                0, universeShuffle)
  ```

  - `universeOrder(counts)` is the order in which successive universe draws would empty a bag
    holding `counts`, laid out so that the engine, which draws from the end ([0001 E1-32]), draws
    it in that order.
  - `universeShuffle` is the shuffle seam of [0001 E1-61]. It reorders a recycled bag into
    `universeOrder` of its own counts.
  - One universe draw from counts `b` takes colour `c`, the least colour whose cumulative count
    `b[0] + … + b[c]` exceeds

    ```
    t = (DRAW_MULTIPLIER · (universeSeed + Σ b[j] · 2^j)) mod Σ b
    ```

    and then decrements `b[c]`. `2^j` is computed without `**` ([A8-49]). Every intermediate is
    an integer below 2^38 (the product is at most about 1.47e11), so it is exact in a double.

  *Why this reproduces the original with no change to the engine. The original's draw depends only
  on the current counts, so the whole sequence from a given bag is fixed in advance and can be
  written down as an order. Our engine deals by popping that order. It recycles the lid exactly
  when the original does: when a display finds the bag short, that display takes what is left, the
  lid becomes the bag, and dealing continues from it (`setup_new_round` against [0001 E1-33]). At
  that moment the seam hands the recycled bag to `universeShuffle`, which writes down the same kind
  of order again. Every deal in every round of every simulation then matches the original's,
  [A8-36] checks it ply by ply, and [A8-51] guarantees the recycle is among what it checks. Both
  constructors are the engine's supported way in ([0001 E1-61], [0001 E1-62]). This is a new
  production caller of that seam, so the seam's own suite gains a case in the new configuration
  ([0001 E1-72]).*

- **[A8-23]** `choose` MUST run exactly `simulations` simulations from the root, adding to whatever
  statistics the session already holds for the boards it passes through.
- **[A8-24]** `choose` MUST return the action with the most root visits (`Nsa` as the session has
  accumulated it), with ties broken by the lowest of their indices and the result translated back
  by `fromTheirAction`. `value` MUST be the root's `Qs`.

  *`pit.py` plays `argmax` over probabilities derived from the visit counts. Its forced-playout
  pruning only lowers counts other than the best, and its temperature is a monotone power, so
  neither changes which count is greatest. What remains is `argmax` over the counts, which takes
  the first index; the one exception is `late-tie`.*

- **[A8-25]** `choose` MUST throw on a terminal position and on one with no legal actions, as
  [0004 B4-16] does.

### Sessions

- **[A8-26]** `createExpert` MUST return a session with an empty node table. A session serves
  **one seat of one game**. It binds to the seat of the first position it is asked about, and MUST
  throw on a position for the other seat.

  *The binding is the cheap half of "not shared between seats". It catches the easy mistake: one
  session answering both seats in a computer-against-computer game. The other half, a session
  carried into a second game, cannot be seen from a position. Preventing it is the owner's job:
  [0006 W6-40] in the interface, and [A8-30] in the gate.*

- **[A8-27]** Two fresh sessions handed the same sequence of positions MUST return the same
  sequence of choices (`action`, `value`, `simulations`, `rootVisits`), on any machine and in any
  JavaScript engine ([A8-49]). In particular, a fresh session's first choice is a pure function of
  the position.

  *Intent 0006's "the same position gets the same move every time", read for a player whose
  memory is part of how it plays. With [0006 W6-4] it keeps a property the interface already has:
  a seed, a seating and the person's own moves replay the whole game, `expert`'s moves included.
  Every game starts with a fresh worker ([0006 W6-13]), and so with fresh sessions.*

- **[A8-28]** `createExpert` MUST throw a `TypeError` on a `simulations` override that is not a
  positive integer.
- **[A8-29]** `ExpertChoice` MUST be plain, structurally cloneable data. It crosses the worker
  boundary, as [0004 B4-40] requires of `Choice`.

### The gate

Intent 0006 says it ships only if it wins "60 or more games in every 100" against our hardest
setting.

- **[A8-30]** An on-demand lane, `pnpm -F ai-bot gate`, MUST play `expert` against `sharp`. For
  each seed of the wide list ([0005 M5-16]) it runs one single-seed `match` from the arena of
  *0005*, unchanged.
  - `expert` is a chooser over fresh sessions built for that game alone. It is `a` on even-indexed
    seeds and `b` on odd ones, which alternates seats ([0005 M5-3]), because a single-seed match
    seats `a` first.
  - `sharp` plays at its shipped budget, with the fail-safe pushed out of reach ([0005 M5-8]).

  The lane aggregates the games into the fields of 0005's `Result`, from `expert`'s side, with the
  arena's own `wilsonLowerBound`. It reports `expert`'s work in the arena's `Play` as
  `nodes = simulations`, `depth = 0`, `complete = false` and `curtailed = false`: its search is
  not depth-bounded and is never curtailed.

  *One match per game, rather than a new "per-game entrant" in the arena, keeps `match` and every
  gate that runs through it untouched. The lane does its own bookkeeping, which is one loop and a
  formula it imports.*

- **[A8-31]** The gate passes when `expert`'s winrate point estimate is **at least 0.60**. The lane
  MUST report the Wilson lower bound ([0005 M5-14]) and the per-seat winrates beside it. It MUST
  also play and print the null, `expert` against itself over the same seeds the same way, and MUST
  fail as uninformative if the null itself reaches 0.60.

  *The null for the reason [0005 M5-13] gives one: two identical players can split far from 50% on
  seat advantage alone, and a threshold the null already clears gates nothing.*

- **[A8-32]** The lane MUST write its result to `packages/ai-bot/gate/baseline.json`, recording:
  - `winrate`, `lowerBound`, `bySeat` and `nullWinrate`;
  - `threshold: 0.6`;
  - `passed`, which is `winrate >= 0.6 && nullWinrate < 0.6`;
  - the commit, the checkpoint sha256, the seed list, `sharp`'s budget and the machine.

  The file MUST be committed whether the gate passed or failed, because intent 0006 asks that a
  copy which does not clear the bar be written down. A test MUST assert that `passed` agrees with
  the recorded numbers.
- **[A8-33]** The interface MUST offer `expert` if and only if the committed
  `packages/ai-bot/gate/baseline.json` has `passed: true`.

### Verification

- **[A8-34]** A fixture generator MUST live under `packages/ai-bot/tools`. It MUST be pinned to the
  original's commit and the checkpoint's sha256, and its Python environment (`numpy`, `numba`,
  `torch`, `torchvision`, `onnx`, `onnxruntime`) pinned in a requirements file. NumPy MUST be 2.x,
  and `numba` MUST be a release that supports the pinned NumPy. The generator MUST assert at run time that
  a node's `Qs` is `numpy.float32` after an update, and MUST record the NumPy and `numba` versions
  and that type in the manifest. A test MUST fail if the manifest records any other type. It is
  run by `pnpm -F ai-bot fixtures`, never by a test.

  It contains a **Python encoder** implementing the board table from the same `AzulJSON`. That is
  how it hands our positions to the original's `valid_moves`, `make_move` and `predict`. It hooks
  `predict` to record exactly what the search received.

  Its input is positions **our** code exported:
  - a position corpus: recorded-seed games played by `bot`'s tiers and the uniform-random chooser,
    covering every round, the last two included, plus the plies [A8-51] requires;
  - at least two whole recorded games, fed to the original **seat by seat** with one `MCTS` object
    per seat. The recorded moves are played whatever the original chooses, so each seat's sequence
    of positions is fixed in advance;
  - one whole-game sequence searched with a **uniform-prior stub** network, which returns uniform
    `P` over legal actions and value `[0, 0]`. It produces exact ties in `u` ([A8-44]).

  For each position it MUST record the board, the legal mask, the network output, and the
  original's next board after the recorded ply, with the search dealing by the universe draw.

  For each call in a sequence it MUST record the following twice, once from the as-shipped search
  and once from the reference search:
  - the root visit counts;
  - the chosen action, taken as the first-index maximum of those counts per [A8-24]. It is never
    `pit.py`'s pick, which is random on a `late-tie`. A `late-tie` is reported, never compared;
  - every `(board key → normalised P over legal actions, value)` the search evaluated, along with
    the raw policy the network returned before normalisation;
  - every deviation condition its search tripped.

  It MUST also rerun the reference search with `Qs` held in float64 over exactly the calls
  [A8-38] compares: the recorded sequences, each up to its first cutting condition. It records as
  the **float32 witness** the first of those calls whose visit counts differ from the reference
  search's. If there is no such call, it MUST say so in the manifest.

  It MUST record the constants table as the original reads it, and the sha256 of the original's
  `LICENSE`. Keys, priors and values MUST be stored as binary files (int8 and little-endian
  float32) beside a JSON manifest. The committed fixtures SHOULD stay under 5 MB.

  *Positions flow from us to the original, not the other way. The original deals randomly in real
  play, and differently from our engine, so its games could not be replayed here. Feeding it ours
  sidesteps that. The whole-game records exercise the tree carried between moves without the
  original ever choosing the moves.*

- **[A8-35]** The suite MUST assert, on every fixture position, that `encodeBoard` equals the
  generator's board and that the legal sets of [A8-12] agree.

  *Stated honestly, this is a cross-language regression check between two encoders written from
  one table. If both share a mistake it passes. [A8-12] is independent where it reaches, because
  the original's `valid_moves` interprets rows 3–22 by its own rules. [A8-52] is the independent
  anchor for the rest.*

- **[A8-52]** The suite MUST compare `encodeBoard(toJSON(newGame(seed)))` with the board the
  original's `getInitBoard()` returns, recorded by [A8-34], on every row no deal touches: row 0,
  row 3's column 5, and rows 9–22.

  *This anchors the conventions only the original can vouch for. The round starts at 1, not 0.
  Empty pattern lines are −1. The marker starts in the centre. Nothing on either side was written
  from the table.*

- **[A8-36]** The suite MUST assert, for every recorded ply, that
  `encodeBoard(toJSON(apply(root, action)))` equals the original's next board, with `root` built
  as [A8-22] builds it. Boundary plies are included, which is what checks the universe draw. A ply
  whose deviation condition holds MUST be compared only where that row of *Known deviations* says,
  and reported by name. Any other mismatch MUST fail.
- **[A8-51]** The plies of [A8-36] MUST include at least one deal in which the bag runs short
  partway through a display, and at least one deal that follows a round which left the bag at
  exactly zero ([0001 E1-33]). The suite MUST fail if the fixtures lack either.

  *The second is the ordinary case: after the first deal the bag holds 80 tiles, four more deals
  empty it, and the sixth round's deal recycles. The first is rare. It needs a bag left short
  of a display's worth, which takes long games with floor-heavy random play, and this
  requirement is what makes the generator include them.*

  *Without this, the claim at the heart of [A8-22], that the lid is recycled exactly when the
  original recycles it, is checked only if some fixture happens to recycle. A check that depends on
  luck is a description outrunning its behaviour.*

- **[A8-37]** The suite MUST assert that the forward pass agrees with the recorded network output
  on every fixture position, within 1e-5 absolute on each policy probability and each value
  component.
- **[A8-53]** The suite MUST assert that the normalisation of [A8-50], applied to each raw policy
  the reference search recorded, reproduces the recorded normalised `P` bit for bit.

  *[A8-38] hands the search `P` already normalised, so without this the port's own normalisation
  is exercised by nothing that can tell float32 sequential summation from anything else.*
- **[A8-38]** The suite MUST replay every recorded sequence through fresh sessions whose network is
  replaced by a lookup of the **reference** search's recorded outputs. It MUST assert that the
  root visit counts and the chosen action equal the reference search's on every compared call.
  - A sequence is compared up to, and not including, its first call whose reference search tripped
    `floor-overflow`, `no-centre-take` or `score-wrap`, since the tree carries those into every
    later call. `terminal-deal` does **not** cut, because a terminal node is valued before any
    board is read. `exhausted` is unreachable, and `late-tie` is a property of the root pick, which
    [A8-34] records as the first-index maximum.
  - Within a compared call, a key the lookup cannot find MUST fail the test.
  - The suite MUST report the fraction of recorded calls compared, and MUST fail if it is below
    one half.

  *The reference search is what makes "exact" achievable. Upstream compiles selection and
  normalisation with `fastmath`, which licenses reassociation and fused operations whose rounding
  no fixed-order TypeScript loop can match. Recompiled without it, the original's arithmetic is
  plain IEEE, [A8-50] reproduces it, and nothing legitimate is left to differ. The as-shipped
  search, `fastmath` included, is what [A8-39] measures against.*

- **[A8-39]** The suite MUST replay the same compared calls with the real network, and MUST
  assert that the chosen action agrees with the **as-shipped** search's on at least 99% of them. It
  MUST print every disagreement with both sides' root visit counts, and report how many calls the
  as-shipped and reference searches themselves disagree on.

  *Not 100%, because float64 layers here against ONNX Runtime's float32 ones move outputs around
  the sixth decimal, and that can flip a near-tie. [A8-38] is where exactness lives. This is the
  end-to-end check that the two parts agree often enough to be one player.*

- **[A8-40]** The fast suite MUST play whole games from recorded seeds with `expert` at a reduced
  `simulations` against `bot`'s tiers and against itself, one fresh session per seat per game. It
  MUST assert that every game terminates, and MUST assert [A8-27] by replaying a game with fresh
  sessions and comparing every choice.
- **[A8-41]** The suite MUST assert invariance under the bag's order, as [0004 B4-55] does: take
  `toJSON` of every permutation of a real state's bag, and fresh sessions must choose the same.

  *Vacuous by construction today, since `AzulJSON` reports the bag as counts, and kept for the
  reason [0004 B4-44] keeps its twin. It is the guard that fails the day someone widens the seam to
  hand the package a state. The counts-only property of the universe draw is held by [A8-7], and
  checked by [A8-36].*

- **[A8-42]** The suite MUST assert that every returned action is in the position's
  `legalActions`, that [A8-26]'s seat binding throws, and that [A8-25] and [A8-28] throw.
- **[A8-43]** The suite MUST include a source check over `packages/ai-bot/src` that fails on:
  - `Math.random`, `Rng`, `Date` or `performance` ([A8-2]);
  - every function [A8-49] forbids, and the `**` operator;
  - a module-level `let`, `var`, typed array or mutable collection ([A8-3], [A8-15]);
  - an import of `bot` or `ui` ([A8-1]);
  - either penalty ladder, or `%` with a right operand of `5` or `NUM_COLORS` ([A8-6]).

  It is the same instrument as [0004 B4-51], and each clause MUST be run against a source it exists
  to reject.
- **[A8-44]** Each mutation below MUST have been seen to turn the named assertion red before that
  assertion is kept. The record MUST sit beside the assertion, naming the function it mutated, and
  the mutation MUST be made in a copy with its landing confirmed, per the repository's mutation
  rules.

  | Mutation | Must fail |
  | --- | --- |
  | Forced playouts removed | [A8-38] |
  | The swap in [A8-18] step 3 removed | [A8-38] |
  | `>` replaced by `>=` in [A8-19] | [A8-38], on the uniform-prior sequence |
  | Selection iterates in our action order | [A8-38] |
  | `Qs` kept in float64 ([A8-50]) | [A8-38], on the float32 witness call. If [A8-34] found no witness, this row is struck and the manifest's statement is its record |
  | Normalisation summed in float64 | [A8-53] |
  | `round + 1` encoded as `round` | [A8-52] |
  | `universeSeed` changed | [A8-36] |
  | Squeeze-excite removed from the trunk | [A8-37] |
  | Floors left out of row 2 | [A8-36] |

- **[A8-45]** Every requirement in this document MUST be either cited by at least one test, by
  identifier, or listed with a reason in the *Traceability exemptions* table. This is enforced
  exactly as [0004 B4-59] enforces it.
- **[A8-46]** The fast suite SHOULD finish in under 30 seconds. The lane of [A8-30] and the
  generator of [A8-34] run outside it.

### Traceability exemptions

| Requirement | Why it is not testable here |
| --- | --- |
| [A8-15] | A process promise about where the weights come from. [A8-16] and [A8-43] are its checkable parts. |
| [A8-33] | Asserted in `packages/ui`, by the test that lands with the [0006 W6-1] amendment, which reads the baseline file. |
| [A8-34] | A tool that is run on purpose, not in the suite. Its output is what [A8-35] through [A8-39] and [A8-51] through [A8-53] consume. |
| [A8-46] | A `SHOULD` about the suite's own runtime. |
| [A8-47] | A process promise about what lands in which commit. |

## Amendments

These are edits to four living specs. Identifiers are append-only: a widened requirement is edited
in place, and a new one takes the next free number. The new identifiers named here —
[0001 E1-72], [0005 M5-32], [0006 W6-40], [0006 W6-41] — were proposals when this document was
written, in the manner of [0004 B4-9]'s proposed engine requirement. They have since landed in
their own specs, and are cited here as the requirements they now are.

- **[A8-47]** These amendments MUST land in their specs in the same change as the code that needs
  them, as [0006 W6-28] required of its own.

### To 0001 — Engine core

| Requirement | Amendment |
| --- | --- |
| [0001 E1-61] | Widen "production callers pass a seed": `ai-bot` passes a shuffle derived from bag counts alone ([A8-22]). It is still a pure function of `(bag, index)`, so sharing it by reference across `clone` is sound. |
| New, [0001 E1-72] | The engine suite MUST include a case in which a **clone** of a state built with an injected shuffle recycles the lid during a later `apply`. It MUST assert that the shuffle is called exactly once, with the recycled bag and the clone's `shufflesUsed`, and that the source state is unaffected. |

*CLAUDE.md's new-caller rule. Until now the seam has been driven only by the conformance harness
replaying recorded orders into states it never clones; the search drives it through `clone` on
every simulation.*

### To 0003 — Web interface

| Requirement | Amendment |
| --- | --- |
| [0003 U3-7] | Widen: `ui` may also depend on `ai-bot`, which, like `bot`, knows how to play and asks the engine what is legal. |
| [0003 U3-74] | Widen the allowlist to include `ai-bot`, and assert it is a `workspace:` range. |

### To 0005 — Opponent strength

| Requirement | Amendment |
| --- | --- |
| New, [0005 M5-32] | `bot`'s manifest MUST export the arena as `bot/arena`, so another workspace package can run a match. The arena's source, tests and behaviour are unchanged. |

### To 0006 — Opponent in the interface

| Requirement | Amendment |
| --- | --- |
| [0006 W6-1] | Extend: offer `expert` as a fourth difficulty after `sharp`, if and only if [A8-33] allows. The test reads `packages/ai-bot/gate/baseline.json`. |
| *Data model* | `Seating.players` becomes `[Level \| null, Level \| null]`, with `type Level = Tier \| 'expert'` declared in `ui`. `ToWorker.tier` becomes `Level`. `FromWorker`'s `choice` and `lastChoice` become `Choice \| ExpertChoice`. |
| [0006 W6-4] | Extend: the seating URL parameter accepts `expert`. |
| [0006 W6-12] | Widen: the worker's module graph MUST reach `ai-bot`, and [0006 W6-31]'s clause extends to `ai-bot` — the components and the state module may not reach either player. The main-thread seam reaches `ai-bot` for its types and for the committed gate result, which is a JSON subpath and does not carry the weights; nothing else in the client reaches the package at all. The worker's bundle carries the weights module — about 630 KB, which MUST stay under 1 MB — whatever setting it runs. Intent 0006's "plays exactly as it did before" is about play, and this cost to loading is accepted here, in writing. |
| New, [0006 W6-40] | The worker MUST hold at most one `Expert` per seat, created on the first `expert` request for that seat, and MUST NOT let one outlive the worker. [0006 W6-13]'s termination on a new game or seating change is therefore also what ends every session. The per-seat logic MUST live in a module importable without a `Worker`. |
| New, [0006 W6-41] | The fast suite MUST assert [0006 W6-40] with an `expert` on **both** seats: each seat's session is asked only about its own seat's positions, and a new game starts with none. [0006 W6-29]'s property test MUST also run with one seat `expert`. |
| [0006 W6-15] | Extend: a throw from `createExpert` or `choose` is caught and reported the same way. |
| [0006 W6-24], [0006 W6-25] | Unchanged, and they now cover `ExpertChoice.value`, which MUST NOT be rendered. |
| [0006 W6-26], [0006 W6-35] | Unchanged, and applying to `expert`: the page stays responsive however long it thinks. This is intent 0006's one performance promise. |
| [0006 W6-30] | Extend: the browser lane also plays one complete game against a real worker running `expert`. |
| [0004 B4-47], [0004 B4-48] | Not amended. These are `bot`'s budgets and do not apply to `expert`; intent 0006 exempts it from intent 0003's "a couple of seconds at most". |

*[0006 W6-41] exists for the same reason as [0001 E1-72]. Two computer seats in one worker is
exactly the configuration in which a session would first be shared by mistake, and nothing in
0006's suite has ever held state between requests to find out.*

## Invariants

- `choose(position).action ∈ position.legalActions` ([A8-42]).
- `fromTheirAction(toTheirAction(a)) === a` for every `a` in `0..179` ([A8-11]).
- A session's node table only grows, and only during `choose` ([A8-17], [A8-23]).
- No state inside a search was reached except by `clone` and `apply` from the root of [A8-22]
  ([A8-21]).

## Open questions

- **How much of the fixture set survives [A8-38]'s prefix rule?** *Answered: 87%.* `floor-overflow`
  is indeed the only deviation the recorded searches reach, and it arrives late — the earliest
  cutting call is the 19th of 24 in one sequence, and the uniform-prior sequence is never cut at
  all. 107 of 123 recorded calls are compared exactly. The floor of one half stands, with room to
  spare, and neither fallback was needed.
- **Should the lane also measure `expert` against `steady` and `easy`?** Intent 0006 asks only
  about the hardest setting, and so does [A8-31]. A fourth rung on [0005 M5-12]'s ladder would read
  naturally, but adding it is a change to 0005's gates, not to this spec.

## References

- Intent [0006 — A learned opponent](../intent/0006-a-learned-opponent.md)
- Intent [0003 — Computer opponent](../intent/0003-computer-opponent.md) — "a couple of seconds"
  applies to the other three settings only
- Spec [0001 — Engine core](0001-engine-core.md) — `fromJSON`, `toCanonical`, `fromCanonical` and
  the shuffle seam; amended here
- Spec [0003 — Web interface](0003-web-interface.md) — amended here
- Spec [0004 — Computer opponent](0004-computer-opponent.md) — unchanged
- Spec [0005 — Opponent strength](0005-opponent-strength.md) — amended here, by one export
- Spec [0006 — Opponent in the interface](0006-opponent-in-the-interface.md) — amended here
- The original: [cestpasphoto/alpha-zero-general](https://github.com/cestpasphoto/alpha-zero-general)
  at `5d6d1f129b76659837f6afd6fb082e8da57e5428`. MIT licence, "Copyright (c) 2018 Surag Nair",
  shipped as [A8-48] requires. The CPU-optimised fork is by cestpasphoto; `azul/` was contributed
  by Peter Finn.
- fdlibm's `e_exp.c`, the basis of [A8-49]'s `exp`.
