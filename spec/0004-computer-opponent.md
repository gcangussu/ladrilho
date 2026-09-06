---
title: Computer opponent
author: Gabriel Cangussu
date: 2026-09-06
status: draft
intent: 0003 — Computer opponent
prefix: B4
depends-on: 0001 — Engine core, 0003 — Web interface
summary: >
  The player: how a position reaches it, what it is allowed to know, how it
  values a position, how it searches, and what the three difficulty tiers
  actually differ in. How strong it is belongs to 0005 — Opponent strength;
  where it runs and how the page stays alive belong to 0006 — Opponent in the
  interface.
---

# Computer opponent

## Scope

Covers `packages/bot`: a synchronous, dependency-free move chooser that is handed a position and
returns an action. It knows how to play Azul. It knows no rule of Azul that it did not ask
`packages/engine` for.

Does not cover the rules (*0001 — Engine core*), how strong the result is and how that is
measured (*0005 — Opponent strength*), or the worker, the thinking state and the controls
(*0006 — Opponent in the interface*). This spec is about a pure function of a position; every
asynchronous thing about the opponent is 0006's.

It **does** cover two additions to the engine, because the bot cannot be written without them
and neither is the bot's to own: [B4-9] and [B4-10] name new requirements to be appended to
*0001 — Engine core*.

### What this costs the engine, and why intent 0004 pays half of it

The evaluation function has to know what a tile is worth where it will land — a finished pattern
line that completes a run of three across and two down is worth five, and one that lands alone is
worth one. That is [0001 E1-24], and the engine does not export it: `tileWall` is private to
`round.ts`, and `apply` resolves a whole round atomically and reports a total.

So there are exactly two ways to build this bot. Either it re-implements adjacency scoring — a
second copy of a rule, in the one repository organised around not having those — or the engine
exports the primitive it already computes. This spec takes the second, as [B4-9].

That is the same wall *intent 0004 — Scoring explained* runs into, from the other side, and it
says so: "the part of the program that does the scoring has to report how, not only how much."
[B4-9] is the hot, allocation-free half of that — one tile, one number — and intent 0004's
per-tile report is expected to be built on it rather than beside it. Intent 0004 also states the
constraint that makes this ordering the right one: "It costs nothing when nobody is looking. A
program playing thousands of games against itself should not pay for explanations no one reads."
This bot is that program. It calls [B4-9] a few million times a move and must not allocate to do
it.

### The three open questions, answered

Intent 0003 leaves three questions open. This spec answers two; the third is 0006's.

| Intent 0003's question | Answer | Where |
| --- | --- | --- |
| What is the honest strength target? | **"Beats a competent human comfortably, and never blunders."** Not a club player, not superhuman. Expressed as a measured ladder rather than a claim. | *0005 — Opponent strength* |
| One adjustable opponent, or a genuinely different easy player? | **Genuinely different.** The tiers differ in *how far ahead they can see* — one move, one exchange, the rest of the round — so the easy one is structurally incapable of the denial play the hard one is built for, rather than a slowed copy of it. | [B4-32] through [B4-36] |
| Can the player watch two computer opponents play each other? | Deferred to *0006 — Opponent in the interface*, which owns every control. | *0006* |

### The tension this spec had to break

Intent 0003 asks for two things that cannot both hold of a wall-clock-bounded search:

> Its turn takes a couple of seconds at most, and the page stays responsive the whole time.

> Given the same position twice, it plays the same move — so a surprising choice can be looked at
> again afterwards.

An iterative deepening search that stops when a timer fires reaches depth 6 on an idle laptop and
depth 4 on a busy phone, and returns a different move. The second sentence would then be false in
exactly the circumstances that make someone want it — a surprising move, looked at again on a
different machine.

This spec makes the **node count** the budget ([B4-26]) and the clock a fail-safe that is reported
when it fires ([B4-28]). The bot is then deterministic wherever it finished its budget, which is
everywhere it is not being starved, and honest about the positions where it did not. The wall
clock becomes a property to be *validated* on real hardware ([B4-47], [B4-48]) rather than a
parameter the answer depends on.

## Definitions

Terms from *0001* — colour, source, destination, action, ply, round, marker, seat — carry their
meaning there. Terms from *0003* — the view model, `submit` — carry theirs.

| Term | Meaning |
| --- | --- |
| **Seat** | The player the bot is choosing for: `position.currentPlayer` at the root. |
| **Round interior** | A ply that leaves `tilesLeft` above zero. It moves no tile the players cannot see and consumes no randomness ([B4-6]). |
| **Boundary ply** | A ply that empties the board, triggering `endRound` ([0001 E1-21]) — wall-tiling, scoring, the marker handoff, and either the end of the game or a fresh deal. |
| **Boundary node** | The node a boundary ply produces. A **leaf**, always ([B4-19]). |
| **Horizon** | Where the search stops looking: a boundary node, a terminal node, or exhausted depth. |
| **Complete search** | One in which every leaf is a boundary or terminal node — the rest of the round has been searched exactly, and deepening cannot change the answer ([B4-20]). |
| **Node** | One expansion: a `clone`, an `apply`, and the `legalActions` of the result. The unit [B4-26] budgets in. |
| **Tier** | One of the three opponents of [B4-32]. |

Constants this document fixes:

| Constant | Value | Where |
| --- | --- | --- |
| `TIERS` | `'easy' \| 'steady' \| 'sharp'` | [B4-32] |
| `WIN` | `1_000_000` | [B4-13] |
| Node budgets | `ACTION_SPACE` (180), `20_000`, `400_000` | [B4-33], [B4-34], [B4-35] |
| Fail-safe cap | 4000 ms | [B4-28] |

## Data model

```ts
type Tier = 'easy' | 'steady' | 'sharp';

interface Options {
  tier: Tier;
  /** Overrides the tier's node budget [B4-26]. For tests and 0005's arena. */
  nodes?: number;
  /** Overrides the fail-safe [B4-28]. */
  milliseconds?: number;
}

/** What the bot returns. Plain data, structurally cloneable [B4-40]. */
interface Choice {
  /** The action to play. Always a member of `position.legalActions` [B4-16]. */
  action: number;
  /** Its value in points, from the seat's perspective [B4-11]. */
  value: number;
  /** Plies of lookahead completed. `1` for `easy` [B4-33]. */
  depth: number;
  /** Nodes expanded [B4-26]. */
  nodes: number;
  /** Every leaf was a boundary or terminal node [B4-20]. */
  complete: boolean;
  /** The clock stopped the search before its node budget [B4-28], [B4-29]. */
  curtailed: boolean;
}
```

The bot declares **no state type of its own**. A position arrives as `AzulJSON` ([0001 E1-52]) and
becomes an `AzulState` through the engine ([B4-10]); a search node is an `AzulState`. There is no
bot-side mirror of the board, because a mirror is a place a rule can be re-implemented into.

## Behaviour

### Package and build

- **[B4-1]** `packages/bot` MUST declare exactly one runtime dependency, `engine`, as a workspace
  dependency. It MUST NOT depend on `ui`.
- **[B4-2]** The package MUST NOT touch the DOM, the network, the filesystem, or storage, and MUST
  NOT read a wall clock other than through the single reading [B4-28] permits. It runs unchanged
  in a worker, on the main thread, and under Vitest in Node — the same bar [0001 E1-50] sets for
  the engine.
- **[B4-3]** The package MUST NOT hold module-level mutable state. Two searches in one process,
  interleaved or not, MUST NOT influence each other's result.

  *`packages/engine` is held to this by [0001 E1-51] and it matters more here: a transposition
  table ([B4-25]) is exactly the tempting place to put a module-level cache, and a cache that
  outlives a call is a cache that can make [B4-30] false without any test noticing.*

- **[B4-4]** `chooseMove` MUST be synchronous and MUST NOT schedule work — no `setTimeout`, no
  promise, no `queueMicrotask`. Keeping the page alive is done by *where* this runs, which is
  0006's, not by yielding inside it.

### What the bot may know

This section is intent 0003's "It gets no private information and no shortcuts a human player
wouldn't have", made decidable.

- **[B4-5]** The bot MUST be handed a position as `AzulJSON` and MUST NOT be handed an `AzulState`
  or a `CanonicalState`. `AzulJSON` reports the bag as per-colour counts and never its order
  ([0001 E1-52], [0001 E1-55]), so the barrier is the transport: there is no order to leak because
  the position never carried one.
- **[B4-6]** The bot MUST NOT search past a boundary ply ([B4-19]). The tiles the next round deals
  are drawn from a bag whose order no player knows, and a search that walks into them is guessing
  at hidden information and calling the guess a line of play.

  *The interior of a round is free of this entirely, and measurably so: over 21 268 plies of random
  play, every shuffle the engine performed fell on a boundary ply and not one fell inside a round.
  So the search this spec describes is not an approximation of an imperfect-information game — it
  is exact over the region it covers, and declines the region it cannot cover.*

- **[B4-7]** The evaluation function MUST NOT read `factories`, `center`, `bag`, `lid` or
  `tilesLeft`. It reads the two boards, the two scores, the marker, and whose round it is.

  *A boundary node has already been dealt — `endRound` tiles, scores, and refills in one ply
  ([0001 E1-21]), so there is no moment between them for a caller to look at. Banning the four
  fields outright is what makes it impossible for a dealt tile to reach a value, and unlike
  "don't look at the deal" it is a `grep` ([B4-51]). The cost is that the eval cannot see what is
  on offer; the search already accounts for that down to its horizon, and the prototype this spec
  was measured from ignores those fields and still wins 93% of games against a one-ply player.*

- **[B4-8]** The bot MUST obtain every rule outcome from the engine: which actions are legal
  (`legalActions`), what a ply does (`apply`), what a floor line costs (`floorPenalty`), what a
  wall has completed (`wallCompletedRows`, `wallCompletedCols`, `wallCompletedColors` for the
  speculative wall of [B4-14]; `completedRows`, `completedCols`, `completedColors` for a state),
  what a finished game came to (`outcome`), and what a placed tile scores ([B4-9]). It MUST NOT
  compute any of these itself.

  *The line is [0003 U3-3]'s, and it falls in the same place: reading the engine's answer is
  allowed, computing your own is not. Deciding that a five-point placement is worth more than a
  one-point placement **is** the bot's own work — that is strategy, and strategy is the only thing
  this package is for.*

### What the engine must add

Both are new requirements for *0001 — Engine core*, appended there under the next free
identifiers. They are listed here because this spec is the reason they exist, and because a
reader asking "what would it take" should see them.

- **[B4-9]** The engine MUST export the per-tile placement value of [0001 E1-24] as a pure,
  allocation-free function of a wall and a cell:

  ```ts
  function placementValue(wall: readonly number[], row: number, col: number): number;
  ```

  `wall` is the flat `[25]` row-major wall of [0001 E1-2] **in which `(row, col)` is not yet set**;
  the return is what a tile placed there scores — the horizontal run plus the vertical run when
  either exceeds one, and `1` when the tile lands alone. `tileWall` MUST then compute its gain by
  calling it, so [0001 E1-24] has exactly one implementation, and a test MUST assert that the
  round scoring of the whole vector corpus of *0002* is unchanged by the refactor.

  *Proposed as `[E1-68]` in spec 0001. The signature takes a wall rather than a state deliberately:
  the eval works on a wall it has speculatively advanced through a round's worth of pattern lines,
  which is not any state the engine holds, and a state-shaped signature would force a clone per
  call in the hottest loop the project has.*

- **[B4-10]** The engine MUST export a constructor from the lossy view:

  ```ts
  function fromJSON(json: AzulJSON, seed: number, shuffle?: Shuffle): AzulState;
  ```

  It MUST fill the bag with `json.bag[c]` tiles of each colour `c` in a fixed canonical order, MUST
  otherwise behave as `fromCanonical` ([0001 E1-62]) including its `tilesLeft` check, and the
  result MUST satisfy `legalActions(fromJSON(j, …))` deep-equals `j.legalActions`.

  *Proposed as `[E1-69]` in spec 0001. This is [B4-5] turned from a promise into an API: a caller
  holding only an `AzulJSON` has no way to express a bag order, so the barrier cannot be crossed by
  a future change that merely forgets about it. Verified as feasible against the engine as it
  stands — a hand-assembled `CanonicalState` built this way round-trips a mid-game position with
  `legalActions` matching exactly.*

  *The canonical order is arbitrary and is never dealt from, by [B4-6]. It exists so that
  `fromJSON` is a function rather than a family of them, which is half of [B4-30].*

### Evaluating a position

- **[B4-11]** `evaluate(s, p)` MUST return a value in **points**, from seat `p`'s perspective,
  comparable across positions.
- **[B4-12]** It MUST be exactly zero-sum: `evaluate(s, p) === -evaluate(s, 1 - p)` for every
  reachable `s` and both seats.

  *Cheap to satisfy — value each board and subtract — and it is what lets the search be a plain
  negamax with one sign flip instead of two evaluations per node.*

- **[B4-13]** A terminal position MUST be valued by its result and not by its heuristic: `+WIN`
  plus the score margin when `p` won, `-WIN` plus it when `p` lost, and the margin alone on a draw,
  with the winner taken from `outcome` ([0001 E1-39]) so the tie-break on completed rows is the
  engine's and not a second copy of it.

  *The margin rides along so that a won position is preferred the more it is won by, which keeps
  the bot from wandering once a win is forced — and `WIN` is far outside any reachable heuristic
  range so no combination of bonuses can counterfeit a win.*

- **[B4-14]** The evaluation MUST account for, and MUST be the only place that weighs: the engine's
  running scores; each pattern line, valued as what it will earn when it tiles, using [B4-9] on the
  wall as that round will leave it; each partial pattern line, as credit for the tiles committed
  against the debt of the tiles still needed; the floor line, from `floorPenalty`; and proximity to
  the three end-of-game bonuses of [0001 E1-38].
- **[B4-15]** Pattern lines MUST be valued in row order `0..4` against a wall advanced as earlier
  rows fill it, matching [0001 E1-22] and [0001 E1-25] — a tile an earlier row places is visible to
  a later one.

  *Not a rule being re-implemented: [B4-9] does the scoring and the engine does the tiling. What
  this pins is that the eval must ask in the order the round will actually resolve, because asking
  in any other order values a cascade wrongly, and a cascade is where the points are.*

### Searching

- **[B4-16]** `chooseMove` MUST return an action drawn from `position.legalActions`, and MUST
  throw rather than return anything when that list is empty — a terminal position ([0001 E1-11])
  is not a position anyone should be asking about.
- **[B4-17]** The search MUST be a negamax with alpha-beta pruning over the engine's own
  transitions: every child is `apply` on a `clone` ([0001 E1-48]), and no position is reached any
  other way.
- **[B4-18]** The sign MUST follow `currentPlayer`, not the parity of the ply. When a child's
  `currentPlayer` equals its parent's, the value MUST be carried up **unnegated** and the window
  passed down **unflipped**.

  *The trap this spec most expects an implementation to fall into. `endRound` hands the next round
  to the marker holder ([0001 E1-30]), who may be the player who just moved, so a boundary ply can
  leave the same seat to move and a parity-based negamax silently negates a whole subtree. It is
  invisible in a shallow search, wrong by a few points in a deep one, and there is no position in
  which it throws.*

- **[B4-19]** A boundary node MUST be a leaf, whatever depth remains, and MUST be valued by
  `evaluate`. A terminal node MUST be a leaf and MUST be valued by [B4-13].
- **[B4-20]** A search in which every leaf was a boundary or terminal node MUST report
  `complete: true`, and iterative deepening MUST stop rather than deepen again.

  *This is a real state, not a corner case, and it is where the bot is at its best: a round is
  10.7 plies on average and its branching factor decays from about 52 at the first ply to 2 at the
  last, so from the middle of a round onward the rest of the round is searched exhaustively and the
  play there is exact to the horizon. Deepening past a complete search burns budget to re-derive
  the same move.*

- **[B4-21]** Moves MUST be ordered before they are searched, and the ordering MUST be a pure
  function of the position and the action.
- **[B4-22]** Iterative deepening MUST search the previous iteration's best move first at the root.
- **[B4-23]** The search MUST be **anytime**: after each completed iteration the best action so far
  MUST be retained, and stopping between iterations MUST yield the last completed iteration's
  answer, never a partial one.
- **[B4-24]** A partially searched iteration MUST NOT contribute its best move. When the budget
  runs out mid-iteration, the answer is the previous iteration's.

  *An unfinished iteration has searched the first few root moves against a full window and the rest
  against nothing. Its "best" is the best of an arbitrary prefix in move-ordering order, which is
  systematically worse than the previous depth's answer rather than better.*

- **[B4-25]** A transposition table MAY be used. If one is, it MUST live for the duration of a
  single `chooseMove` call ([B4-3]), and its presence MUST NOT change the chosen action — only how
  fast it is found. A test MUST assert the same move with the table disabled.

  *Permitted because plies commute freely inside a round — taking blue from display 1 and then red
  from display 3 reaches the same position as the reverse — so transpositions are common here in a
  way they are not in most games. Fenced because a table keyed on too little is the classic way a
  search becomes irreproducible.*

### The budget, and determinism

- **[B4-26]** The budget MUST be counted in **nodes**, and a tier's budget MUST be a fixed number
  ([B4-33]..[B4-35]). Wall-clock time MUST NOT be an input to which move is chosen.
- **[B4-27]** The node count MUST be checked between iterations and inside them, and the search
  MUST stop at the first check past the budget. [B4-24] then decides what is returned.
- **[B4-28]** A wall-clock fail-safe MUST exist, defaulting to 4000 ms, checked no more often than
  once every 1024 nodes. It exists for a device slow enough that the node budget would take longer
  than a player will wait.
- **[B4-29]** A search stopped by the fail-safe MUST report `curtailed: true`. A search that
  finished its node budget MUST report `curtailed: false`.

  *Reported rather than hidden because it is the one circumstance in which [B4-30] does not hold,
  and a bot that is silently non-reproducible on slow hardware is worse than one that says so.
  0005's arena refuses a curtailed result outright.*

- **[B4-30]** Given the same position and the same options, `chooseMove` MUST return the same
  `action` — on any machine, on any run, at any load — unless it reports `curtailed`. Ties MUST be
  broken by the lowest action number, so the answer does not depend on iteration order over any
  container.
- **[B4-31]** `chooseMove` MUST NOT consult a random source. There is no `Math.random`, no `Rng`,
  and no seed input.

  *A bot that randomises among near-equal moves would be more pleasant to play repeatedly and is
  ruled out here, because intent 0003 asked for the opposite in as many words. If it is ever
  wanted, it is a new option with a seed, not a loosening of this.*

### The three tiers

- **[B4-32]** There MUST be exactly three tiers, and they MUST differ in **how far ahead each can
  see** rather than in how long each is allowed to take. Intent 0003 asks that the settings be
  "actually different, not just slower versions of each other"; a horizon is a difference in kind,
  a budget is not.
- **[B4-33]** `easy` MUST search its own move and nothing else: it MUST evaluate the position after
  each of its own legal actions and play the best, and MUST NOT expand any node below those. It
  reports `depth: 1`, and its node budget is `ACTION_SPACE` ([0001 E1-6]) — which it can never
  reach, because that is the size of the whole action space and a root offers at most 120 of them
  in practice. It is a bound, not a throttle: `easy` is defined by its horizon and is never
  curtailed.

  *Which makes it structurally incapable of denial: it never looks at the reply, so it cannot
  prefer a move for what it leaves the opponent. That is intent 0003's second open question
  answered "a genuinely different, simpler player" — and it is a *good* beginner opponent rather
  than a crippled one, because it plays its own board sensibly. It beat uniformly random play in
  200 of 200 recorded games, 63.6 points to 1.1.*

- **[B4-34]** `steady` MUST search to a fixed depth of 3 plies, bounded by 20 000 nodes. It sees
  its move, the reply, and its answer — enough to deny a specific tile, not enough to plan a round.
- **[B4-35]** `sharp` MUST iteratively deepen until its node budget of 400 000 is spent or the
  search is complete ([B4-20]). It is the opponent intent 0003 describes: it denies, and because
  the end of a round is inside its horizon for most of the round, it times the round's end rather
  than stumbling into it.

  *400 000 is derived from the measured node rate in *Performance*, not chosen: it is about 1.2
  seconds on the machine of record, which leaves room for a phone three times slower to stay inside
  the fail-safe of [B4-28]. At that budget the prototype reached about 6 plies of lookahead at the
  first ply of a round, and searched the rest of the round exhaustively from roughly its midpoint
  on.*
- **[B4-36]** The tiers MUST be ordered in measured strength, `sharp` over `steady` over `easy`,
  by *0005 — Opponent strength*. A tier that does not beat the tier below it is a defect in this
  spec, not a tuning matter.

### Denial

Intent 0003 singles this out: "An opponent that only maximises its own points misses half the
game, and it should be obvious from playing it that this one doesn't."

- **[B4-37]** `steady` and `sharp` MUST choose moves that depend on the opponent's board. Formally:
  there MUST exist positions differing **only** in the opponent's wall, pattern lines, floor and
  score — with the seat's own legal actions identical — for which the chosen action differs.
- **[B4-38]** The bot MUST NOT restrict itself to actions that improve its own board. Taking tiles
  onto its own floor line to empty a source is a legal move and MUST be reachable as a chosen one.

  *[B4-37] is the testable form of "plays the denial side", and it is sharp: a pure
  self-maximiser's choice is invariant under every change to the opponent's board, so a single
  witnessing pair falsifies it. [B4-38] is there because the obvious eval-shaped bug — never
  proposing a move that scores negatively for you — deletes the whole denial repertoire without
  failing anything else.*

## Interfaces

```ts
function chooseMove(position: AzulJSON, options: Options): Choice;   // [B4-4], [B4-16]
function evaluate(s: AzulState, p: Player): number;                  // [B4-11], [B4-12]

const BUDGETS: Readonly<Record<Tier, number>>;                       // [B4-33]..[B4-35]
const TIERS: readonly Tier[];                                        // in strength order [B4-36]
```

- **[B4-39]** `chooseMove` MUST throw a `TypeError` on an unknown tier and on a `nodes` or
  `milliseconds` override that is not a positive integer, rather than silently substituting a
  default.
- **[B4-40]** `Choice` MUST be plain, structurally cloneable data — no class instance, no function,
  nothing holding a reference to a state. It crosses a worker boundary in 0006.
- **[B4-41]** `evaluate` MUST NOT mutate the state it is given ([0001 E1-51]'s discipline), and
  `chooseMove` MUST NOT mutate the position object it is given.

## Invariants

All hold of every call, and all are asserted directly by the tests in *Verification*.

- **[B4-42]** `chooseMove(position, o).action ∈ position.legalActions`.
- **[B4-43]** `evaluate(s, 0) === -evaluate(s, 1)`.
- **[B4-44]** The action chosen is invariant under the bag's order: for any two states differing
  only in a permutation of `bag`, the moves chosen from their `toJSON` views are equal.

  *Trivially true while [B4-5] holds, and asserted anyway. It is the regression guard on the
  barrier: the day someone widens the seam to hand the bot a state, this is the test that fails,
  and it fails for the right reason.*

- **[B4-45]** `nodes <= options.nodes ?? BUDGETS[tier]`, unless `curtailed`.
- **[B4-46]** No state reachable from the root during a search has a `roundIndex` greater than the
  root's, and none is reached after a boundary ply. This is [B4-6] and [B4-19] as a property of the
  search tree.

## Performance

Measured on the machine of record, an Apple Silicon laptop, against the engine as it stands, with a
prototype of this design.

The engine sustains **1.0 million plies per second** under [0001 E1-58] — five times its own budget
— and `clone` costs **0.53 µs** under [0001 E1-59]. Those two put a ceiling of roughly 660 000
nodes per second on the engine work alone. The measured rate of a **whole** search node, evaluation
and move ordering included, is **≈ 350 000 nodes per second** single-core. The gap is this
package's own cost and is where [B4-50] applies; the budgets below are set from the measured figure
and not from the ceiling.

| Ply within the round | Depth reached in 2 s | Nodes | Rate |
| --- | --- | --- | --- |
| 0 | 6.2 | 686 k | 343 k/s |
| 1 | 6.8 | 713 k | 356 k/s |
| 2 | 9.3 | 719 k | 359 k/s |
| 3 | 12.6 | 663 k | 355 k/s |
| 4 | 12.9 | 570 k | 314 k/s |

Depth rises and node count falls as the round goes on, because the tree runs out: the branching
factor decays from about 52 at a round's first ply to 2 at its last, and searches that reach
[B4-20]'s complete state stop early. That is the shape [B4-20] describes, observed.

- **[B4-47]** `sharp` SHOULD choose a move within **2 seconds** on a modern laptop. Its 400 000
  node budget is about **1.2 seconds** at the measured rate, and the margin is for a colder engine
  and a busier machine.
- **[B4-48]** `sharp` SHOULD choose a move within **4 seconds** on a mid-range phone — three times
  slower than the machine of record, which is where 400 000 nodes lands — and that is the fail-safe
  of [B4-28] and the reason that number is what it is. A device on which `sharp` is routinely
  curtailed ([B4-29]) is a device that SHOULD be offered `steady`; how that is decided is 0006's.
- **[B4-49]** `easy` and `steady` SHOULD choose a move within 50 ms and 200 ms respectively.
  `steady`'s 20 000 nodes are about 57 ms at the measured rate; the allowance is for a cold worker
  and a slow device.
- **[B4-50]** A search node SHOULD cost no more than **4 µs** — 2.9 µs measured, against the
  engine's own 1.5 µs for the `clone` and `apply` inside it — and `evaluate` SHOULD NOT allocate
  beyond a single working wall per call.

  *The one allocation is deliberate and is [B4-15]'s: the eval advances a copy of the wall as
  pattern lines tile, and it must not advance the real one.*

Like [0001 E1-58], [0001 E1-59] and [0003 U3-67], all five are **budgets, not correctness gates**.
A regression is a bug to file. The measurements live in `packages/bot/bench`.

## Verification

- **[B4-51]** The suite MUST include a source check over `packages/bot/src` that fails on a
  reference to `factories`, `center`, `bag`, `lid` or `tilesLeft` in the evaluation module
  ([B4-7]); on `Math.random`, `Rng` or `Date.now` outside the single fail-safe reading ([B4-31],
  [B4-2]); on a module-level `let`, `var` or mutable collection ([B4-3]); and on `%` with a right
  operand of `5` or `NUM_COLORS`, either penalty ladder, and a module-level numeric table of length
  5, 7 or 25 ([B4-8]).

  *The same instrument as [0003 U3-75] and the same limits: a bounded matcher over an enumerated
  set of shapes, with each clause run against a source it is supposed to reject. It cannot see a
  re-implemented rule that reads only permitted fields — [B4-52] and [B4-53] are for that.*

- **[B4-52]** The suite MUST assert that every position the search visits is legal and every action
  it plays is in `legalActions`, by driving whole games at each tier and checking the engine's own
  invariants ([0001 E1-40], [0001 E1-41]) at every ply.
- **[B4-53]** The suite MUST include a property test that plays complete games at each tier from
  fixed, recorded seeds and asserts [B4-42], [B4-45] and [B4-46] at every ply, that no game fails
  to terminate, and that a failure reports the seed and the ply.
- **[B4-54]** The suite MUST assert [B4-30] by choosing from the same position twice in one
  process, and from a position rebuilt through `toJSON` in a second process, and comparing the
  action, the value and the node count.

  *The node count is included on purpose: two runs that agree on the move but disagree on the work
  done have a non-determinism that this position happened to hide.*

- **[B4-55]** The suite MUST assert [B4-44] by permuting a real state's bag, taking `toJSON` of
  each permutation, and comparing chosen moves.
- **[B4-56]** The suite MUST exhibit at least one witnessing pair for [B4-37] and one position in
  which the chosen move places tiles on the bot's own floor line for [B4-38], both recorded as
  fixtures with the position that produced them.
- **[B4-57]** The suite MUST assert [B4-18] from a position in which a boundary ply leaves the same
  seat to move, by comparing the search's value against one computed by a deliberately naive
  reference search over a small depth.

  *A directed test because random play reaches this often but never notices it: the parity bug
  changes a value, not a legality, so nothing else in the suite can see it.*

- **[B4-58]** The suite MUST assert the engine additions it depends on: that `placementValue`
  ([B4-9]) agrees with the round scoring of *0002*'s whole vector corpus, and that `fromJSON`
  ([B4-10]) reproduces `legalActions` and `tilesLeft` for every position in it.
- **[B4-59]** Every requirement in this document — every `MUST` and `SHOULD`, and every `MAY` the
  implementation exercises — MUST be either cited by at least one test, by identifier, in a test
  name or an adjacent comment, or listed with a reason in the *Traceability exemptions* table. A
  check MUST fail the suite when a requirement is neither cited nor exempt, when a test cites an
  identifier that does not exist, and when the exemption table names one that no longer exists.
  This mirrors [0002 V2-26], [0002 V2-27] and [0003 U3-76].
- **[B4-60]** The fast suite SHOULD finish in under 30 seconds. Strength measurement is slow by
  nature and is *0005 — Opponent strength*'s own lane, outside this budget.

### Traceability exemptions

Exemptions follow [0002 V2-31]'s categories: process promises, statements about other
implementations, implementation-strategy directives, and non-gating budgets. Difficulty is not a
reason, and a `MUST` about observable behaviour MUST NOT be exempted.

| Requirement | Why it is not testable |
| --- | --- |
| [B4-8], [B4-14] | Implementation-strategy directives about where a value comes from and what it weighs. [B4-51] checks the decidable part; the residue is a judgement, and no behaviour distinguishes a conforming eval from one that reaches the same numbers the wrong way. |
| [B4-32] | A statement about the shape of the tier set, realised by [B4-33] through [B4-36], each of which is asserted. Nothing is left for it to assert on its own. |
| [B4-47], [B4-48], [B4-49], [B4-50] | `SHOULD` budgets, declared non-gating above, and two of them are about hardware the suite does not run on. |
| [B4-60] | A `SHOULD` about the suite's own runtime. |

## Open questions

- **Does the horizon of [B4-6] cost real strength?** Stopping at the boundary means the bot never
  plans across a round — it will not deliberately leave a line partial to complete it next round,
  except as far as the eval's partial-line credit ([B4-14]) stands in for that. The alternative is
  sampled determinization: draw several bag orders consistent with the public counts, search each,
  and average. It multiplies the cost by the sample size, it reintroduces the hidden information
  [B4-5] was arranged to exclude, and it makes [B4-30] depend on a sampling seed. If [B4-47]'s
  budget turns out to have room, the way to answer this is an arena match under *0005* between a
  horizoned `sharp` and a determinized one — not an argument.
- **Is the eval's blindness to the tiles on offer ([B4-7]) worth what it buys?** It buys a
  `grep`-able barrier. It costs the eval any sense of whether a promising pattern line can actually
  be filled from what is on the table beyond the horizon. A weighted "is my colour still
  available" term would need a different barrier — evaluating the position *before* the deal — and
  that means the engine separating `endRound`'s scoring from its refill, which is a larger change
  than [B4-9] and [B4-10] together.
- **Should the eval's weights be fitted rather than chosen?** Intent 0003 rules out training as
  its own intent, and this spec fixes weights by hand. *0005*'s arena is the machinery a fit would
  need, so the question is whether tuning constants against it counts as the training intent 0003
  excludes. This spec reads "no datasets, no self-play jobs" as excluding it and leaves the
  weights hand-set.

## References

- Intent [0003 — Computer opponent](../intent/0003-computer-opponent.md)
- Intent [0004 — Scoring explained](../intent/0004-scoring-explained.md) — shares [B4-9]
- Spec [0001 — Engine core](0001-engine-core.md) — gains [B4-9] and [B4-10]
- Spec [0003 — Web interface](0003-web-interface.md) — [U3-31]'s seam is what 0006 widens
- Spec [0005 — Opponent strength](0005-opponent-strength.md)
- Spec [0006 — Opponent in the interface](0006-opponent-in-the-interface.md)
