---
title: Expert opponent
author: Gabriel Cangussu
date: 2026-09-11
status: draft
intent: 0006 — A learned opponent
prefix: A8
depends-on: 0001 — Engine core, 0004 — Computer opponent, 0005 — Opponent strength, 0006 — Opponent in the interface
summary: >
  The fourth difficulty, expert: a port of a published AlphaZero-style Azul
  player — its network, its search, its settings and its tree lifetime —
  running on our engine in a package of its own, and the lane that decides
  whether it ships. Amends 0003, 0005 and 0006; leaves 0004 untouched.
---

# Expert opponent

## Scope

Covers `packages/ai-bot`: the board encoding, the network, the search, the per-game session, the
fixtures that prove all four against the original, and the lane that decides whether it ships.

Does not cover `bot`. *0004 — Computer opponent* is unchanged by this document. [0004 B4-1] and
[0004 B4-32] stay true as written, because `expert` is not a tier of `bot`: it is a second
package, reached by the interface beside the first. Training is not covered either, and neither is
speed. Intent 0006 puts both out of scope, so this document sets no time budget.

It **amends** three specs, in the manner of *0006*: the edits are enumerated in *Amendments* and
land in those files together with the code that needs them ([A8-47]).

### What "the original" is, and what replicating it means

The original is one specific program: `azul/` in
[cestpasphoto/alpha-zero-general](https://github.com/cestpasphoto/alpha-zero-general) at commit
`5d6d1f129b76659837f6afd6fb082e8da57e5428`, playing the checkpoint `azul/pretrained.pt` the way
`pit.py` plays it. Intent 0006 asks for "a faithful copy of how it plays". This spec reads that as:

- the same input the original's network sees;
- the same network;
- the same search, with the same settings;
- the same guess about the tiles a future round deals;
- the same lifetime for the search tree.

The original's **rules** are not copied. Intent 0006 says our engine decides what is legal and what
happens. Where the two programs disagree about a rule, ours wins, and the disagreement is listed in
*Known deviations* rather than fixed on either side.

### The one place this departs from 0004's discipline

`bot` refuses to search past the end of a round ([0004 B4-6]), because the next deal comes from a
bag whose order no player knows. The original does search past it. It guesses the deal with a fixed
pseudo-random draw computed from the bag's **counts**, which it calls a *universe*. This package
does the same ([A8-22]), because it is how the original plays.

That is a guess, not a peek. Its only input is what both players can already see, and [A8-7] and
[A8-41] hold it to that. The barrier of [0004 B4-5] is kept. What is given up is only 0004's refusal
to guess. That refusal belongs to `bot`, not to a rule of the project.

### Tree lifetime, and how the existing tiers opt out

The original keeps its search tree for the length of a game. `pit.py` builds one `MCTS` object per
player, and `Arena.playGame` discards it when the game ends. A move is therefore a function of the
game so far, not of the position alone. This spec keeps that behaviour ([A8-26]).

It reads intent 0006's "the same position gets the same move every time" as "the same game gets the
same moves" ([A8-27]). A fresh session is still a pure function of the position.

The state lives in an explicit **session**, owned by whoever plays the game. That is the worker in
the interface (proposed `[0006 W6-40]`) and a per-game entrant in the arena (proposed
`[0005 M5-32]`).
The existing tiers opt out by doing nothing: `chooseMove` stays a stateless function. Nothing here
or in the amendments gives `bot` a session, and a caller that never asks for `expert` never
creates one.

## Definitions

Terms from *0001* (action, ply, round, seat), *0004* (tier, boundary ply) and *0006* (seating,
request, generation) carry their meaning there.

| Term | Meaning |
| --- | --- |
| **Original** | The program named in *Scope*, at the pinned commit. |
| **Checkpoint** | `azul/pretrained.pt` at that commit: sha256 `7d2fbf9203e46837668cd5b8f7bb29b7ea6f9e500f25f148c79e0038a76fe2f9`, last changed upstream in `6b75052`. |
| **Board** | The original's 23×6 grid of 8-bit integers, from one seat's perspective ([A8-8]). |
| **Board key** | The board's 138 values in row-major order. Two positions with equal keys are one node ([A8-10]). |
| **Their action** | The original's action index, `0..179` ([A8-11]). |
| **Perspective** | The seat to move. "Me" is `position.currentPlayer`, and "them" is the other seat. |
| **Session** | One `Expert`: the node table for one seat of one game ([A8-26]). |
| **Simulation** | One descent from the root to a leaf and the backup along it ([A8-18]). |
| **Universe draw** | The original's deterministic guess at a deal, a pure function of bag counts ([A8-22]). |

Constants, all read from the checkpoint's stored arguments and from `pit.py`. The fixtures check
them ([A8-34]):

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

`pit.py` also sets `prob_fullMCTS` to 1 and builds its `MCTS` without Dirichlet noise, so every
search is a full search with no noise. Neither setting has a counterpart here.

## Data model

### The board

Rows are listed top to bottom and columns 0 to 5. Colours are in the engine's order, which is also
the original's: blue, yellow, red, black, and teal (the original calls it white). A cell the table
does not mention is 0.

| Row | Columns 0–4 | Column 5 | Taken from `AzulJSON` |
| --- | --- | --- | --- |
| 0 | `[my score, their score, round + 1, 0, 0]` | 0 | `players[·].score`, `round` |
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

Row 2 is why the floors appear twice. The original moves a tile to its discard pile the moment the
tile reaches a floor line. Our engine keeps it on the floor until the round ends ([0001 E1-3]). The
sum is the same number either way.

### Actions

Both programs encode an action as `source * 30 + color * 6 + destination`, with destination `5` for
the floor. They differ only in where the centre sits. For us it is source `5` (`CENTER`); for the
original it is source `0`, and displays `0..4` become `1..5`.

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
  the tests may import `bot`, and nothing under `src/` may import `bot` or `ui`.
- **[A8-2]** The package MUST NOT touch the DOM, the network, the filesystem or storage. It MUST
  NOT read a clock, and MUST NOT consult `Math.random` or an `Rng`. There is no fail-safe, so a
  search is never curtailed.

  *`bot` needs a wall clock for [0004 B4-28] because its budget is large enough to starve a phone.
  This package's budget is 100 simulations, and intent 0006 puts speed out of scope. A clock here
  would be one more way to make [A8-27] false, and it would buy nothing.*

- **[A8-3]** The package MUST NOT hold module-level mutable state. All mutable state MUST live in
  a session, and two sessions in one process, interleaved or not, MUST NOT influence each other.
- **[A8-4]** `choose` MUST be synchronous and MUST NOT schedule work. Keeping the page alive is
  the worker's job ([0006 W6-10]), exactly as it is for `bot` ([0004 B4-4]).

### What it may know

- **[A8-5]** A session MUST be handed a position as `AzulJSON` and nothing else. It builds every
  state it searches from that value through the engine ([A8-22]).
- **[A8-6]** The board ([A8-8]) is an input to the network and a key to the node table, and
  nothing more. Legality MUST come from `legalActions`, transitions from `apply`, and results from
  `outcome` and `isTerminal`. Nothing in the package may compute any of these from the board.

  *[0004 B4-8]'s line, drawn in the same place: the original's own rules are exactly the second
  copy this repository is organised against, and the board is where one would creep in.*

- **[A8-7]** The universe draw of [A8-22] MUST be the only source of the tiles dealt inside a
  search, and its only inputs MUST be bag and lid counts.

### The board

- **[A8-8]** `encodeBoard(position)` MUST return the board of the table in *Data model*, from the
  perspective of `position.currentPlayer`, as 138 values in row-major order.
- **[A8-9]** Every value MUST be stored as an 8-bit two's-complement integer, as the original
  stores it. A value outside `[-128, 127]` MUST wrap (`score 130` is stored as `-126`). Only a
  score can reach that range.

  *Faithful rather than sensible. The original's network has only ever seen wrapped scores, so
  sending it an unwrapped one would be a second deviation layered on the first. It is rare in a
  two-player game.*

- **[A8-10]** The node table MUST be keyed by the board key. Two positions reached by different
  paths that encode to the same board MUST share one node, as they do in the original.

  *This is how the original handles transpositions. It is not an optimisation that can be dropped:
  merging two paths merges their visit counts, and visit counts choose the move.*

- **[A8-11]** `toTheirAction` and `fromTheirAction` MUST be exact inverses over `0..179`, and MUST
  implement the formula in *Data model*.
- **[A8-12]** For every fixture position, the set of `toTheirAction` over `legalActions` MUST
  equal the set of actions the original's `valid_moves` accepts on the encoded board.

### Known deviations

Every place the two programs disagree. Each follows from our engine deciding the rules, and each
is rare. The fixture tests of [A8-36] recognise these cases by name and report them, and treat any
other disagreement as a failure.

| Case | Our engine ([0001]) | The original | Consequence here |
| --- | --- | --- | --- |
| Floor full | Overflow past seven slots goes to the lid ([0001 E1-20]). | The floor count keeps rising. The penalty is capped at seven. | The encoded floor count is at most 7, where the original's history might show more. |
| Nobody took from the centre | The start alternates ([0001 E1-31]). | Seat 0 starts. | The next round opens with a different seat to move. |
| Bag and lid both empty | The game ends ([0001 E1-37]). | Its draw divides by zero. | We follow the rules; the original cannot reach a comparable state. |
| Exact tie in root visits, late game | Lowest action index ([A8-24]). | Random, once `pit.py`'s temperature falls to 0.02 or below, around ply 47. | The same move whenever the original's pick is not random. |

### The network

- **[A8-13]** The forward pass MUST compute the function the checkpoint's network (`nn_version`
  84) computes in PyTorch's eval mode. Dropout is the identity, and batch normalisation uses its
  running statistics with ε = 1e-5. The input is the board as numbers, unscaled, with shape 23×6
  (23 channels of length 6). Arithmetic is float64.

  | Stage | Shape out | Composition |
  | --- | --- | --- |
  | `first_layer` | 23×6 | linear across channels 23→23, no bias, then batch norm; no activation |
  | `trunk.0` | 23×6 | inverted residual, expand 115, ReLU, squeeze-excite 32, residual add |
  | policy `output_layers_PI.0` | 46×6 | inverted residual, expand 115, Hardswish, squeeze-excite 32, no residual |
  | policy tail | 180 | flatten to 276, linear 276→180, ReLU, linear 180→180, mask, log-softmax |
  | value `output_layers_V.0` | 23×6 | inverted residual, expand 46, Hardswish, squeeze-excite 16, residual add |
  | value tail | 2 | flatten to 138, linear 138→2, ReLU, linear 2→2, tanh |

  An **inverted residual** block is:
  - *expand*: linear across channels, no bias, then batch norm and the activation;
  - *mix*: a 6→6 linear along each channel's length, shared across channels, no bias, then batch
    norm and the activation (upstream calls it `depthwise`);
  - *squeeze-excite*: the mean over the length, then linear with bias, ReLU, linear with bias,
    Hardsigmoid, scaling each channel;
  - *project*: linear across channels, no bias, then batch norm; no activation;
  - the residual add, when the input and output widths are equal.

  Flattening is channel-major (`c * 6 + l`). The mask replaces every illegal logit with `-1e8`
  before the softmax. Hardswish is `x · relu6(x + 3) / 6` and Hardsigmoid is `relu6(x + 3) / 6`.

  *Squeeze-excite is present in **every** block, including the trunk. Upstream switches it on by
  passing the strings `"RE"` and `"HS"` where a boolean is expected, and a non-empty string is
  true. Anyone porting from the constructor's apparent intent rather than from the weights will
  leave it out. The checkpoint's `se.fc1`/`se.fc2` tensors in all three blocks are the evidence,
  and [A8-37] is the check.*

- **[A8-14]** The network MUST return the policy as probabilities (`exp` of the log-softmax),
  indexed by **their** action, and the value as a pair `[me, them]`.
- **[A8-15]** The weights MUST come from a generated module in `packages/ai-bot/src`, produced from
  the checkpoint's `state_dict` by a committed script under `packages/ai-bot/tools`. The module
  MUST open with a header naming the upstream commit, the checkpoint's sha256 and the script. The
  script MUST refuse a checkpoint whose sha256 differs. Regenerating the module is a deliberate
  act with a commit message, like [0005 M5-31]'s reference values.
- **[A8-16]** The `num_batches_tracked` buffers MUST be omitted, and every other tensor of the
  `state_dict` MUST be present in the module. A test MUST fail if the module's tensor names and
  shapes differ from those the script recorded.

### The search

A port of the original's `MCTS.search`, `pick_highest_UCB` and `getActionProb`, restricted to the
path `pit.py` takes. For each node the session stores its legal mask, its prior `P` (by their
action), its visit count `Ns`, its running value `Qs`, and per action `Nsa` and `Qsa`, where `Qsa`
starts unset.

- **[A8-17]** The node table MUST belong to the session, and MUST store statistics only. States
  are re-derived on every simulation by `clone` and `apply` ([A8-21]), as the original re-derives
  its boards.
- **[A8-18]** A simulation at a node with state `s`, viewed from `s.currentPlayer`, MUST do exactly
  this:
  1. If `s` is terminal, return `[1, -1]` if the seat to move won, `[-1, 1]` if it lost, and
     `[0.01, 0.01]` on a draw. The winner comes from `outcome` ([0001 E1-39]).
  2. If the node has not been expanded: evaluate the network on `encodeBoard(toJSON(s))`. Set `P`
     to the policy, normalised to sum to 1. Set `Ns = 0`, every `Nsa = 0`, every `Qsa` unset, and
     `Qs` to the value's first component. Return the value.
  3. Otherwise select an action `a` ([A8-19]), and compute the child as
     `apply(clone(s), fromTheirAction(a))`. Simulate the child and get `v`. If the child's
     `currentPlayer` differs from `s.currentPlayer`, swap `v`'s components. Then update, in this
     order:
     - `Qsa[a] ← (Nsa[a] · Qsa[a] + v[0]) / (Nsa[a] + 1)`, counting an unset `Qsa[a]` as 0 when
       `Nsa[a] = 0`;
     - `Qs ← ((Ns + 1) · Qs + v[0]) / (Ns + 2)`;
     - `Nsa[a] ← Nsa[a] + 1`;
     - `Ns ← Ns + 1`.

     Return `v`.
- **[A8-19]** Selection MUST visit the legal actions in ascending order of **their** action index.
  For each, in order:
  1. If `forcedPlayouts` is set and `Nsa[a] < ⌊√(k · P[a] · i)⌋`, select `a` immediately. Here
     `i` is the 0-based index of the current simulation within the current `choose` call, and it
     is the same at every node of the descent.
  2. Otherwise score `u = Qsa[a] + cpuct · P[a] · √Ns / (1 + Nsa[a])` when `Qsa[a]` is set, and
     `u = (Qs − fpu) + cpuct · P[a] · √(Ns + EPS)` when it is not.

  The action with the **strictly** greatest `u` is selected, so on a tie the lowest index of their
  actions wins.

  *The order is theirs because the tie-break is theirs. Iterating in our encoding puts the centre
  last instead of first, and changes which of two equal moves is explored, without changing any
  single number a test would look at.*

- **[A8-20]** The sign MUST follow `currentPlayer`, never ply parity. This is the trap of
  [0004 B4-18], handled the original's way: a boundary ply can leave the same seat to move, and
  step 3 of [A8-18] swaps the value only when the seat changes.
- **[A8-21]** Every child MUST be produced by `apply` on a `clone` ([0001 E1-48]), starting from
  the root of [A8-22]. No state MUST be reached any other way, and no state MUST be edited.
- **[A8-22]** Each `choose` MUST build its root state as

  ```
  fromCanonical({ ...toCanonical(fromJSON(position, 0)), bag: universeOrder(position.bag) },
                0, universeShuffle)
  ```

  - `universeOrder(counts)` is the order in which the universe draw would empty a bag holding
    `counts`, laid out so that the engine, which draws from the end ([0001 E1-32]), draws it in
    that order.
  - `universeShuffle` is the shuffle seam of [0001 E1-61]. It reorders a recycled bag into
    `universeOrder` of its own counts.
  - One universe draw from counts `b` takes colour `c`, the least colour whose cumulative count
    `b[0] + … + b[c]` exceeds

    ```
    t = (DRAW_MULTIPLIER · (universeSeed + Σ b[j] · 2^j)) mod Σ b
    ```

    and then decrements `b[c]`.

  *Why this reproduces the original with no change to the engine. The original's draw depends
  only on the current counts, so the whole sequence from a given bag is fixed in advance and can be
  written down as an order. Our engine deals by popping that order. It recycles the lid exactly
  when the original does: when a display finds the bag short, that display takes what is left, the
  lid becomes the bag, and dealing continues from it. At that moment the seam hands the recycled
  bag to `universeShuffle`, which writes down the same kind of order again. Every deal in every
  round of every simulation then matches the original's, and [A8-36] checks it ply by ply. Both
  constructors are the engine's supported way in ([0001 E1-61], [0001 E1-62]), and nothing edits a
  state after construction.*

- **[A8-23]** `choose` MUST run exactly `simulations` simulations from the root, adding to whatever
  statistics the session already holds for the boards it passes through.
- **[A8-24]** `choose` MUST return the action with the most root visits (`Nsa` as accumulated by
  the session), ties broken by the lowest index of their actions, translated back by
  `fromTheirAction`. `value` MUST be the root's `Qs`.

  *`pit.py` plays `argmax` over probabilities derived from the visit counts. Its forced-playout
  pruning only lowers counts other than the best, and its temperature is a monotone power, so
  neither changes which count is greatest. What remains is `argmax` over the counts.*

- **[A8-25]** `choose` MUST throw on a terminal position and on one with no legal actions, as
  [0004 B4-16] does.

### Sessions

- **[A8-26]** `createExpert` MUST return a session with an empty node table. A session serves
  **one seat of one game**. It binds to the seat of the first position it is asked about, and MUST
  throw on a position for the other seat.

  *The binding is the cheap half of "not shared between seats": it catches the mistake that is
  easy to make, one session answering for both seats in a computer-against-computer game. The
  other half, a session carried into a second game, cannot be detected from a position. It is the
  owner's to prevent (proposed `[0006 W6-40]` and `[0005 M5-32]`).*

- **[A8-27]** Two fresh sessions handed the same sequence of positions MUST return the same
  sequence of choices (`action`, `value`, `simulations`, `rootVisits`), on any machine and any run.
  In particular, a fresh session's first choice is a pure function of the position.

  *This is intent 0006's "the same position gets the same move every time", read for a player
  whose memory is part of how it plays. With [0006 W6-4] it keeps the property the interface
  already has: a seed, a seating and the person's own moves replay the whole game, `expert`'s moves
  included, because every game starts with a fresh worker ([0006 W6-13]) and so with fresh
  sessions.*

- **[A8-28]** `createExpert` MUST throw a `TypeError` on a `simulations` override that is not a
  positive integer.
- **[A8-29]** `ExpertChoice` MUST be plain, structurally cloneable data. It crosses the worker
  boundary, as [0004 B4-40] requires of `Choice`.

### The gate

Intent 0006: it ships only if it wins "60 or more games in every 100" against our hardest setting.

- **[A8-30]** An on-demand lane, `pnpm -F ai-bot gate`, MUST play `expert` against `sharp` using
  the arena of *0005*:
  - `expert` at its shipped settings, with a fresh session per seat per game through the per-game
    entrant of proposed `[0005 M5-32]`;
  - `sharp` at its shipped budget, with the fail-safe pushed out of reach ([0005 M5-8]);
  - over the wide seed list ([0005 M5-16]), with seats alternated ([0005 M5-3]).

  The lane reports `expert`'s work in the arena's `Play` as `nodes = simulations`, `depth = 0`
  and `complete = false`, because its search is not depth-bounded and neither field means anything
  for it.
- **[A8-31]** The gate passes when `expert`'s winrate point estimate is **at least 0.60**. The lane
  MUST report the Wilson lower bound ([0005 M5-14]) and the per-seat winrates beside it. It MUST
  also play and print the null, `expert` against itself over the same seeds, and MUST fail as
  uninformative if the null itself reaches 0.60.

  *The null for the reason [0005 M5-13] gives one: two identical players can split far from 50% on
  seat advantage alone, and a threshold the null already clears gates nothing.*

- **[A8-32]** The lane's `Result`s MUST be committed as a baseline file under `packages/ai-bot`,
  recording the commit, the checkpoint sha256, the seed list, `sharp`'s budget and the machine. A
  failing result MUST be committed too. Intent 0006 asks that a copy that does not clear the bar
  be written down.
- **[A8-33]** The interface MUST NOT offer `expert` unless the committed baseline passes [A8-31].

### Verification

- **[A8-34]** A fixture generator MUST live under `packages/ai-bot/tools`. It MUST be pinned to the
  original's commit and the checkpoint's sha256, with its Python environment pinned in a
  requirements file. It is run by `pnpm -F ai-bot fixtures` and never by a test. Its input is
  positions **our** code exported:
  - a position corpus: recorded-seed games played by `bot`'s tiers and the uniform-random chooser,
    covering every round, the last two rounds included;
  - at least two whole recorded games, each fed to the original **seat by seat**, with one `MCTS`
    object per seat. The recorded moves are played whatever the original chooses, so each seat's
    sequence of positions is fixed in advance.

  For each position it MUST record the board, the legal mask, the network's output, and the
  original's next board after the recorded ply, with the search dealing by the universe draw. For
  each call in a whole game it MUST also record the root visit counts, the chosen action, and
  every `(board key → normalised P over legal actions, value)` the search evaluated. It MUST
  record the constants table as the original reads it. The committed fixtures SHOULD stay under
  5 MB.

  *Positions flow from us to the original, not the other way. The original deals randomly in real
  play and differently from our engine, so its own games could not be replayed here. Feeding it
  ours sidesteps that entirely, and the whole-game records exercise the tree carried between moves
  without the original ever having to choose the moves.*

- **[A8-35]** The suite MUST assert [A8-8] and [A8-12] on every fixture position: the encoded
  board equals the recorded board, and the legal sets agree.
- **[A8-36]** The suite MUST assert, for every recorded ply, that
  `encodeBoard(toJSON(apply(root, action)))` equals the original's next board, where `root` is
  built as [A8-22] builds it. Boundary plies are included, which is what checks the universe draw.
  A mismatch MUST fail unless it is one of the *Known deviations*, recognised by its condition and
  reported by name.
- **[A8-37]** The suite MUST assert that the forward pass agrees with the recorded network output
  on every fixture position, to within 1e-5 absolute on each policy probability and on each value
  component.
- **[A8-38]** The suite MUST replay every recorded whole-game sequence through fresh sessions whose
  network is replaced by a lookup of the recorded outputs. It MUST assert that the root visit
  counts and the chosen action equal the recorded ones on **every** call. A key the lookup cannot
  find MUST fail the test, because it means the search visited a board the original did not.

  *This isolates the search from the network. With the network's numbers held equal, any
  difference is the port's own: an order, a sign, a tie-break or a formula. The requirement is
  exact because nothing legitimate is left to differ. One caveat: upstream compiles its selection
  with `fastmath`, which licenses reassociation, so a last-bit tie between two actions could in
  principle go the other way. If one is ever observed, the fixture records it with both numbers.
  Loosening this requirement is not the fix.*

- **[A8-39]** The suite MUST replay the same sequences with the real network, and MUST assert that
  the chosen action agrees with the recorded one on at least 99% of calls. It MUST print every
  disagreement with both sides' root visit counts.

  *Not 100%: float64 here against float32 in the original moves outputs in the sixth decimal, and
  that can flip a near-tie. [A8-38] is where exactness lives. This is the end-to-end check that
  the two parts agree often enough to be one player.*

- **[A8-40]** The fast suite MUST play whole games from recorded seeds with `expert` at a reduced
  `simulations` against `bot`'s tiers and against itself, one fresh session per seat per game. It
  MUST assert that every action is in `legalActions` and every game terminates, and MUST assert
  [A8-27] by replaying a game with fresh sessions and comparing every choice.
- **[A8-41]** The suite MUST assert invariance under the bag's order, as [0004 B4-55] does: take
  `toJSON` of every permutation of a real state's bag, and the choices of fresh sessions must be
  equal.
- **[A8-42]** The suite MUST assert that every returned action is a member of the position's
  `legalActions`, that [A8-26]'s seat binding throws, and that [A8-25] and [A8-28] throw.
- **[A8-43]** The suite MUST include a source check over `packages/ai-bot/src` that fails on:
  - `Math.random`, `Rng`, `Date` or `performance` ([A8-2]);
  - a module-level `let`, `var` or mutable collection ([A8-3]);
  - an import of `bot` or `ui` ([A8-1]);
  - either penalty ladder, or `%` with a right operand of `5` or `NUM_COLORS` ([A8-6]).

  It uses the same instrument as [0004 B4-51], and each clause MUST be run against a source it
  exists to reject.
- **[A8-44]** Each of the following mutations MUST have been seen to turn the named assertion red
  before that assertion is kept. The record MUST sit beside the assertion, naming the function it
  mutated. Per the repository's mutation rules, the mutation is made in a copy and its landing is
  confirmed.

  | Mutation | Must fail |
  | --- | --- |
  | Forced playouts removed | [A8-38] |
  | The swap in [A8-18] step 3 removed | [A8-38] |
  | `>` replaced by `>=` in [A8-19] | [A8-38] |
  | Selection iterates in our action order | [A8-38] |
  | `round + 1` encoded as `round` | [A8-35] |
  | `universeSeed` changed | [A8-36] |
  | Squeeze-excite removed from the trunk | [A8-37] |
  | Floors left out of row 2 | [A8-35] |

- **[A8-45]** Every requirement in this document MUST be either cited by at least one test, by
  identifier, or listed with a reason in the *Traceability exemptions* table. This is enforced
  exactly as [0004 B4-59] enforces it.
- **[A8-46]** The fast suite SHOULD finish in under 30 seconds. The lane of [A8-30] and the
  generator of [A8-34] are outside it.

### Traceability exemptions

| Requirement | Why it is not testable |
| --- | --- |
| [A8-15] | A process promise about where the weights come from. [A8-16] is its checkable part. |
| [A8-32] | A process promise about what is committed after a run. |
| [A8-33] | Asserted in `packages/ui`, by the test that lands with the [0006 W6-1] amendment, not by this package's suite. |
| [A8-34] | A tool that is run on purpose, not in the suite. Its output is what [A8-35] through [A8-39] consume. |
| [A8-46] | A `SHOULD` about the suite's own runtime. |
| [A8-47] | A process promise about what lands in which commit. |

## Amendments

These are edits to three living specs. Identifiers stay append-only: a widened requirement is
edited in place, and a new one takes the next free number. The new identifiers named here
(`[0005 M5-32]`, `[0005 M5-33]`, `[0006 W6-40]`, `[0006 W6-41]`, the next free numbers today) are
proposals. They are written in backticks, as [0004 B4-9] wrote its proposed engine requirement,
and are fixed when they land.

- **[A8-47]** These amendments MUST land in their specs in the same change as the code that needs
  them, as [0006 W6-28] required of its own.

### To 0003 — Web interface

| Requirement | Amendment |
| --- | --- |
| [0003 U3-7] | Widen: `ui` may also depend on `ai-bot`. Like `bot`, it knows how to play and asks the engine what is legal. |
| [0003 U3-74] | Widen the allowlist to include `ai-bot`, and assert that it is a `workspace:` range. |

### To 0005 — Opponent strength

| Requirement | Amendment |
| --- | --- |
| New, `[0005 M5-32]` | `MatchSpec.a` and `.b` MUST accept either a `Chooser` or a **per-game entrant**, `{ perGame(): Chooser }`. For an entrant, `match` MUST call `perGame()` once per side per game, before that game's first ply, and MUST NOT reuse a chooser across games. A plain `Chooser` is used as today. The arena's tests MUST include a match with an entrant on each side, asserting one `perGame()` call per game and [0005 M5-7]'s determinism in that configuration. |
| New, `[0005 M5-33]` | `bot` MUST export the arena as `bot/arena`, so another workspace package can run a match. Nothing under `bot/src` changes. |
| [0005 M5-7] | Extend: the rebuilt-choosers rule covers entrants too, rebuilt for each run. |

*The entrant is additive, and it is how the existing tiers opt out: every current `Chooser` stays a
`Chooser`, and no call site changes. The arena's test in the new configuration is CLAUDE.md's rule
for a change that adds a caller to an existing seam: until now `match` has only ever seen stateless
choosers.*

### To 0006 — Opponent in the interface

| Requirement | Amendment |
| --- | --- |
| [0006 W6-1] | Extend: offer `expert` as a fourth difficulty after `sharp`, subject to [A8-33]. |
| *Data model* | `Seating.players` becomes `[Level \| null, Level \| null]`, with `type Level = Tier \| 'expert'` declared in `ui`. `ToWorker.tier` becomes `Level`. `FromWorker`'s `choice` and `lastChoice` become `Choice \| ExpertChoice`. |
| [0006 W6-4] | Extend: the seating URL parameter accepts `expert`. |
| [0006 W6-12] | Widen: the worker may import `ai-bot`, and remains the only thing in the client that does. [0006 W6-31]'s clause extends to `ai-bot`. |
| New, `[0006 W6-40]` | The worker MUST hold at most one `Expert` per seat. It creates one on the first `expert` request for that seat, and it MUST NOT let one outlive the worker. [0006 W6-13]'s termination on a new game or a seating change is therefore also what ends every session. The per-seat logic MUST live in a module importable without a `Worker`. |
| New, `[0006 W6-41]` | The fast suite MUST assert `[0006 W6-40]` with an `expert` on **both** seats: each seat's session is asked only about its own seat's positions, and a new game starts with none. [0006 W6-29]'s property test MUST also run with one seat `expert`. |
| [0006 W6-15] | Extend: a throw from `createExpert` or `choose` is caught and reported the same way. |
| [0006 W6-24], [0006 W6-25] | Unchanged, and they now cover `ExpertChoice.value`, which MUST NOT be rendered. |
| [0006 W6-26], [0006 W6-35] | Unchanged, and they apply to `expert`: the page stays responsive however long it thinks. This is intent 0006's one performance promise. |
| [0006 W6-30] | Extend: the browser lane also plays one complete game against a real worker running `expert`. |
| [0004 B4-47], [0004 B4-48] | Not amended. They are `bot`'s budgets and do not apply to `expert`. Intent 0006 exempts it from intent 0003's "a couple of seconds at most". |

*`[0006 W6-41]` exists for the same reason as the arena's new test. Two computer seats in one worker
is exactly the configuration in which a session would first be shared by mistake, and nothing in
0006's suite has ever held state between requests to find out.*

## Invariants

- `choose(position).action ∈ position.legalActions` ([A8-42]).
- `fromTheirAction(toTheirAction(a)) === a` for every `a` in `0..179` ([A8-11]).
- A session's node table only grows, and only during `choose` ([A8-17], [A8-23]).
- No state inside a search was reached except by `clone` and `apply` from the root of [A8-22]
  ([A8-21]).

## Open questions

- **Does the floor deviation measurably cost parity?** It is the only deviation reachable in normal
  play. [A8-39]'s printed disagreements will show whether positions with a full floor are
  over-represented. If they are, the choice is between accepting it and teaching the encoder a
  history it cannot see. The second is not available from `AzulJSON`.
- **Should the lane also measure `expert` against `steady` and `easy`?** Intent 0006 asks only
  about the hardest setting, and so does [A8-31]. The ladder of [0005 M5-12] would read more
  naturally with a fourth rung, but adding one is a change to 0005's gates, not to this spec.

## References

- Intent [0006 — A learned opponent](../intent/0006-a-learned-opponent.md)
- Intent [0003 — Computer opponent](../intent/0003-computer-opponent.md) — "a couple of seconds"
  applies to the other three settings only
- Spec [0001 — Engine core](0001-engine-core.md) — `fromJSON`, `toCanonical`, `fromCanonical` and
  the shuffle seam, used unchanged
- Spec [0003 — Web interface](0003-web-interface.md) — amended here
- Spec [0004 — Computer opponent](0004-computer-opponent.md) — unchanged
- Spec [0005 — Opponent strength](0005-opponent-strength.md) — amended here
- Spec [0006 — Opponent in the interface](0006-opponent-in-the-interface.md) — amended here
- The original: [cestpasphoto/alpha-zero-general](https://github.com/cestpasphoto/alpha-zero-general)
  at `5d6d1f129b76659837f6afd6fb082e8da57e5428`, MIT licence; `azul/` was contributed by Peter Finn
