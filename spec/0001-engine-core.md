---
title: Engine core
author: Gabriel Cangussu
date: 2026-09-03
status: implemented
intent: 0001 — Rules engine
prefix: E1
summary: >
  The two-player Azul rules engine: state layout, the 180-value action encoding,
  legality, tile routing, round resolution and scoring, game end, seeded
  determinism, and the fixed-length observation vector. How it is proven correct
  is specified separately in 0002 — Engine conformance vectors.
---

# Engine core

## Scope

Covers `packages/engine`: the complete rules of two-player Azul as a headless, deterministic
state machine, plus the observation encoding the bot consumes.

Does not cover: how correctness is verified (*0002 — Engine conformance vectors*), rendering
(*intent 0002 — Web interface*), or move evaluation of any kind (*intent 0003 — Computer
opponent*). The engine ranks nothing and prefers nothing.

This is a port of the Python engine in [RemiFabre/ludometer](https://github.com/RemiFabre/ludometer)
(`ludometer/azul/engine.py`). Where this document and that file disagree, this document is a bug
unless it says otherwise explicitly. It deliberately diverges in three places: the random
number generator ([E1-46]), the language-level API shape, and the injectable shuffle seam with
its `shufflesUsed` counter ([E1-61]) — a data-model field the Python engine has no analogue for,
added so conformance replays are possible at all.

## Definitions

| Term | Meaning |
| --- | --- |
| **Colour** | Integer `0..4` = blue, yellow, red, black, teal. |
| **Source** | Where tiles are taken from: `0..4` a factory display, `5` the centre. |
| **Destination** | Where they go: `0..4` a pattern line row, `5` the floor line. |
| **Lid** | The discard pile. Tiles return to the bag from here when it runs dry. |
| **Marker** | The first-player marker. |
| **Ply** | One `apply` call: one player taking one colour from one source. |
| **Round** | The plies from a refill until the board is empty, plus the wall-tiling that follows. |

Constants:

| Name | Value |
| --- | --- |
| `NUM_COLORS` | 5 |
| `TILES_PER_COLOR` | 20 (100 tiles total) |
| `NUM_FACTORIES` | 5 (the two-player count) |
| `FACTORY_SIZE` | 4 |
| `NUM_ROWS` | 5 (pattern line `r` has capacity `r + 1`) |
| `FLOOR_SLOTS` | 7 |
| `FLOOR_PENALTIES` | `[-1, -1, -2, -2, -2, -3, -3]` |
| `ACTION_SPACE` | 180 |
| `ENCODED_SIZE` | 182 |
| `ROW_BONUS` / `COL_BONUS` / `COLOR_BONUS` | 2 / 7 / 10 |

### Wall geometry

- **[E1-1]** The wall is the standard fixed-colour wall. Colour `c` occupies column
  `(c + r) % 5` in row `r`; equivalently the cell at row `r`, column `col` is colour
  `(col - r + 5) % 5`.
- **[E1-2]** The wall MUST be stored row-major, so cell `(r, col)` is index `r * 5 + col`.

## Data model

State is a single mutable object with an explicit `clone`. Mutation is deliberate: the bot clones
a position per search node, and a persistent structure would cost more than it saves. Callers that
want immutability clone first.

```ts
type Color = 0 | 1 | 2 | 3 | 4;
type Player = 0 | 1;

interface AzulState {
  factories: number[][];   // [5][5] tile counts per colour per display
  center: number[];        // [5] tile counts per colour
  markerInCenter: boolean;
  bag: Color[];            // shuffled draw order; tiles are taken from the end
  lid: number[];           // [5] discard counts per colour
  walls: number[][];       // [2][25] 0/1, row-major
  plColor: number[][];     // [2][5] colour of each pattern line, -1 when empty
  plCount: number[][];     // [2][5] tiles held per pattern line
  floor: number[][];       // [2][5] tile counts per colour on the floor line
  floorMarker: boolean[];  // [2] does this player hold the marker
  scores: number[];        // [2]
  currentPlayer: Player;
  firstPlayer: Player;     // marker holder; starts the current round
  roundIndex: number;      // 0-based
  tilesLeft: number;       // tiles on factories + centre; the round ends at 0
  shufflesUsed: number;    // shuffles consumed so far; see [E1-61]
  isTerminal: boolean;
  exhausted: boolean;      // game stopped because no tiles could be dealt
}
```

- **[E1-3]** The floor line MUST be stored as counts per colour, not as an ordered list. Order
  never affects scoring, and the marker is tracked by `floorMarker`, not as a tile.
- **[E1-4]** A pattern line with `plCount[r] === 0` MUST have `plColor[r] === -1`.
- **[E1-5]** Implementations MAY keep **derived caches** — meaning working state that is
  derivable from the declared fields and is not itself one, such as the per-colour placement
  masks of [E1-60]. The PRNG is not a cache by this definition: it is not derivable from
  anything, `recount()` MUST NOT touch it, and a snapshot deliberately omits it ([E1-62]).

  Caches MAY be kept as long as [E1-13] and the invariants hold. `recount()` is a declared
  interface either way, and rebuilds whatever a caller's direct edits invalidated: every cache,
  plus `tilesLeft`, which a hand-edited display falsifies the same way. It MUST leave the PRNG
  and `shufflesUsed` alone — no board implies either. The engine keeps all of it current on every
  `apply`, so `recount()` is for callers, not for the engine.

  `tilesLeft` is deliberately *not* a cache by this definition. It is a declared field, it is
  maintained incrementally, and [E1-41] pins it to a value that must always agree with the board
  — which makes it exactly the kind of thing worth comparing rather than recomputing.

  *Direct editing plus `recount()` is a convenience for exploratory work and for the UI. Anything
  that must be reproducible — conformance fixtures above all — should go through `fromCanonical`
  ([E1-62]) instead; that is guidance for callers, which is why the enforceable versions live in
  [0002 V2-3] and [0002 V2-36] rather than here — and note that for a game vector the
  enforceable rule is the opposite one, `newGame`.*

- **[E1-65]** `newGame(seed)` MUST produce exactly this opening state, before anything else:
  a bag holding 20 tiles of each colour and shuffled once ([E1-61]); an empty lid; empty walls,
  pattern lines and floor lines for both players; `floorMarker` false for both and
  `markerInCenter` true; `scores` `[0, 0]`; `currentPlayer` **0**; `firstPlayer` **0**;
  `roundIndex` 0; `isTerminal` and `exhausted` false; then the first refill ([E1-32]), which
  leaves `tilesLeft` at 20.

  Spelled out because none of it is implied by the rules above: a port that opens with
  `currentPlayer` 1 satisfies every other requirement in this document and diverges from the
  reference on ply 0 of every conformance vector.

## Action encoding

- **[E1-6]** An action is the integer `source * 30 + color * 6 + destination`, with `source`
  `0..5`, `color` `0..4`, `destination` `0..5`. The space is `0..179` and MUST be dense: every
  integer in range decodes, whether or not it is legal in a given position.
- **[E1-7]** `encodeAction` and `decodeAction` MUST be exact inverses over the whole space.
- **[E1-8]** The encoding is part of the public contract — it appears in saved games, test
  vectors, and the bot's policy head. It MUST NOT change without a new spec.

## Legality

For the current player, action `(source, color, dest)` is legal exactly when all of:

- **[E1-9]** The source pool holds at least one tile of `color`.
- **[E1-10]** `dest === FLOOR`, or all three of:
  - the pattern line `dest` is not full (`plCount[dest] <= dest`);
  - it is empty, or already holds `color`;
  - the wall cell for `color` in row `dest` is empty.
- **[E1-11]** The game is not over. A terminal state MUST have no legal actions.
- **[E1-12]** Taking to the floor is legal whenever [E1-9] holds, so a player with tiles
  available always has at least one legal action — the engine never deadlocks and never needs to
  pass. Forced-to-floor is an ordinary move the caller must choose, not something the engine does
  on the player's behalf. *(This settles the open question in intent 0001: the referee does not
  place tiles for anyone. It matches the reference implementation, and it keeps the engine free
  of the one thing it must never have — an opinion about what a player should do.)*
- **[E1-13]** `legalActions()` MUST return exactly the set of actions for which `isLegal()` is
  true, with no duplicates, in **ascending** action order. The reference implementation returns
  ascending order and its brute-force cross-check compares the two lists for equality, so
  matching it lets [0002 V2-7] and [0002 V2-20] compare without sorting first.

## Applying a move

`apply(action)` performs the whole ply, including any round or game transition it triggers.

- **[E1-14]** An action that is out of range or illegal MUST throw, MUST NOT mutate the state,
  and MUST be validated before anything is taken. A half-applied state is a defect, not an
  outcome.
- **[E1-15]** All tiles of `color` are removed from the source pool.
- **[E1-16]** When the source is a factory display, every remaining tile on that display moves to
  the centre.
- **[E1-17]** When the source is the centre and the marker is still there, the marker moves to
  the current player's floor line (`markerInCenter` false, `floorMarker[p]` true). Later takes
  from the centre in the same round move no marker.
- **[E1-18]** With destination a pattern line: the line's colour is set, it fills to at most
  `dest + 1` tiles, and the surplus overflows to the floor line.
- **[E1-19]** With destination the floor, every taken tile overflows.
- **[E1-20]** Overflow fills the floor line up to `FLOOR_SLOTS` occupied slots — counting the
  marker as one occupied slot — and any tile beyond that goes straight to the lid.
- **[E1-21]** `tilesLeft` decreases by the number of tiles taken. If it is still positive, the
  turn passes to the other player; if it reaches zero, round resolution ([E1-22] onwards) runs
  immediately as part of the same `apply`.

  A ply may also be played by `applyExplained` ([0007 S7-1]), which performs the identical
  transition and additionally reports what round resolution charged. What a ply *is* is unchanged
  by that, and the two entry points are indistinguishable as state transitions ([0007 S7-28]).

## Round resolution

Runs for both players, player 0 first, when the board empties.

### Wall-tiling and scoring

- **[E1-22]** Pattern lines are resolved in row order `0..4`. A line MUST be resolved only when
  full (`plCount[r] === r + 1`); a partial line is left untouched for the next round.
- **[E1-23]** Resolving a line places one tile on that row's wall cell for the line's colour, and
  sends the other `r` tiles to the lid. The line is emptied (`plCount = 0`, `plColor = -1`).
- **[E1-24]** Placing a tile scores: let `h` be the length of the horizontal run through the new
  tile and `v` the vertical run, each counting the new tile itself. If `h > 1` or `v > 1`, score
  `(h > 1 ? h : 0) + (v > 1 ? v : 0)`; otherwise score 1.
- **[E1-25]** Tiles placed earlier in the same resolution are visible to later ones, so a lower
  row can score against a tile that row 0 just placed. Row order is therefore load-bearing.
- **[E1-68]** [E1-24] MUST be exported as a pure function of a wall and a cell, and MUST have
  exactly one implementation — round scoring computes its per-tile gain by calling it:

  ```ts
  function placementValue(wall: readonly number[], row: number, col: number): number;
  ```

  `wall` is the flat `[25]` row-major wall of [E1-2]. The function MUST NOT allocate and MUST
  NOT read any state ([E1-51]) — only `wall` and this document's constants.

  It MUST NOT read the cell at `(row, col)` itself, so the answer does not depend on whether
  the caller has placed the tile yet. That is what licenses round scoring to ask *before* it
  places. Callers SHOULD still ask about an unset cell, because that is the only reading under
  which the name means anything — but a precondition with no consequence would only earn a
  defensive write in the hottest loop in the project, so the normative form is the one above.

  A private `placementRuns` stands beside it, exposing the two runs as `{ h, v }` without
  restating the fusion rule ([0007 S7-11]). It is reached only from the explained path of
  [0007 S7-4], it allocates, and it is not exported: the record's `h` and `v` are the only
  witness the two numbers need.

  *Exported for the bot, which cannot value a pattern line without knowing what the tile it will
  place is worth ([0004 B4-9]), and which calls this a few million times a move. It takes a wall
  rather than a state because the wall it asks about is one it has advanced speculatively through
  a round's worth of pattern lines — not a position the engine holds — and a state-shaped
  signature would force a clone per call.*

  *This is also the primitive* intent 0004 — Scoring explained *needs to report a per-tile figure.
  Exporting it here means the eventual report is built on the arithmetic that actually scores the
  game rather than beside it, which is that intent's stated constraint.*

### Floor penalties

- **[E1-26]** Occupied floor slots are the sum of the floor's per-colour counts plus 1 if the
  player holds the marker.
- **[E1-27]** The penalty is the sum of `FLOOR_PENALTIES` over the first `min(occupied, 7)`
  slots. Slots beyond the seventh cost nothing.
- **[E1-28]** The round's score change is the tiling gain plus the (negative) penalty, and a
  player's score MUST be clamped at 0 after applying it. Clamping happens per round, not per
  tile, and never carries a debt forward.
- **[E1-29]** All floor tiles then move to the lid.

### Marker and next round

- **[E1-30]** After scoring, whichever player holds the marker gives it up
  (`floorMarker` false, `markerInCenter` true) and becomes `firstPlayer` and `currentPlayer` for
  the next round.
- **[E1-31]** If neither player took from the centre all round — possible when every display is
  monochrome — the marker never left the centre, and the next round starts with the player who
  did *not* make the last move, preserving alternation.

### Refill

- **[E1-32]** Refill deals `FACTORY_SIZE` tiles to each display in order `0..4`, drawing from the
  end of the bag.
- **[E1-33]** When a draw finds the bag empty, all lid tiles move to the bag, the lid is emptied,
  and the bag is shuffled ([E1-46]). Dealing then continues. Two details are observable and
  therefore contractual:
  - The recycle is triggered by a draw finding the bag empty, **not** by the bag reaching zero.
    A deal that consumes the last tile exactly ends with an empty bag and no shuffle; the recycle
    happens at the next refill's first draw. An eager implementation shuffles once more, at a
    different point, and deals a different game from that moment on.
  - If the lid is also empty, the bag stays empty and **nothing is shuffled** — dealing stops
    ([E1-34]) without the shuffle being reached at all. An implementation that shuffles the empty
    bag anyway consumes a recorded entry from the conformance seam ([E1-61]) and fails a correct
    vector ([0002 V2-6]).
- **[E1-34]** When bag *and* lid are both empty, dealing stops early and the remaining displays
  stay short. This is a legal position, not an error.
- **[E1-35]** `roundIndex` counts *round transitions*, not deals. A new game deals the first
  round with `roundIndex` at 0 and does not increment; every later round increments once, before
  its refill runs. A refill that deals nothing ([E1-34]) still leaves the increment in place. A
  fresh game therefore reports `roundIndex === 0`, and an implementation that reports 1
  mismatches every conformance vector from its first ply.

## Game end

- **[E1-36]** After a round resolves, the game ends if either player has at least one complete
  wall row. The check runs after tiling and before the next refill.
- **[E1-66]** The marker handoff ([E1-30], [E1-31]) runs **before** that check, not after. A
  terminal state therefore has `markerInCenter` true, `floorMarker` false for both players, and
  `firstPlayer` and `currentPlayer` both set as [E1-30] and [E1-31] direct — the last marker
  holder, or, when nobody took from the centre all round, the player who did not move last —
  even though no further round will be played. All four are compared per ply ([0002 V2-5]), so a port that ends
  the game the moment a row completes diverges on the final ply of every game vector.
- **[E1-37]** The game also ends if a refill deals nothing at all (bag and lid both empty). Such
  a state MUST set `exhausted` so callers can tell it apart from an ordinary finish.

  **This path is unreachable in a lawfully dealt game, and that is not a reason to omit it.** At
  any refill the board is empty and floors have just been dumped, so all 100 tiles are in bag,
  lid, walls, or partial pattern lines. With no completed row (or the game would have ended) the
  walls hold at most 40, and partial lines at most 20, leaving **at least 40 in bag + lid** where
  20 are needed. The analytic floor is 40; measured
  minima across a few thousand refills run around 60. The reference
  implements this path anyway, so the port must match it — but it can only be *tested* from an
  artificially posed short-census position ([E1-40]), never from a played game. The same applies
  to [E1-34].
- **[E1-38]** On ending, each player scores `2` per complete row, `7` per complete column, and
  `10` per colour placed all five times, added to the running score. End bonuses are NOT clamped
  by [E1-28] — clamping applies to round scoring only.
- **[E1-70]** What a wall has completed MUST be exported as pure, allocation-free functions of a
  wall, and `completedRows`, `completedCols` and `completedColors` MUST compute their answers by
  calling them, so each count has exactly one implementation:

  ```ts
  function wallCompletedRows(wall: readonly number[]): number;
  function wallCompletedCols(wall: readonly number[]): number;
  function wallCompletedColors(wall: readonly number[]): number;
  ```

  `wall` is the flat `[25]` row-major wall of [E1-2]. None of the three reads any state.

  *Wall-shaped for the same reason [E1-68] is, and added at the same time by the same caller. The
  bot's evaluation values the wall as the current round will leave it — pattern lines tiled, which
  is a wall no state holds — and it needs to know what that speculative wall has completed in order
  to weigh [E1-38]'s bonuses ([0004 B4-14]). Counting the cells itself would be a second
  implementation of this rule sitting in a package whose whole premise is that it contains none.*
- **[E1-71]** The delegation check of [E1-68] MUST additionally fail on a second implementation of
  [E1-24]'s fusion rule **in the forms it is plausible to write one**. The existing check asserts
  only that `round.ts` calls `placementValue`, which a divergent sibling would not disturb — a
  "recording" copy of `placementValue` that combined the runs itself would keep that assertion
  green from the unexplained branch while the explained branch drifted. Four decidable clauses:

  1. The fusion **shape** — a comparison against `1` used as the test of a conditional expression
     — occurs exactly once in `packages/engine/src`, inside `placementValue`.
  2. `horizontalRun` and `verticalRun` have exactly two call sites each, both in `score.ts`. They
     are module-private, so a sibling in another file cannot reach them at all; this clause is
     what covers a sibling placed *inside* `score.ts`.
  3. `placementRuns` has exactly one call site, and the block that call sits in does nothing but
     copy: no arithmetic, no comparison, no third function, no read of `h` or `v` outside the
     record's own fields.
  4. Over the whole file, the text `.h` and `.v` each occur exactly once — the copy into the
     record. A second occurrence is a second use. It counts **text, not reads**: it cannot tell
     whose `.h` it is, and a bracket read (`runs['h']`) is invisible to it.

  **This is a tripwire, not a proof, and the wording above says "plausible" advisedly.** Clause 3
  was walked past three times in review, each time by a form its previous version had not
  anticipated: a binding-tracking version fell to destructuring, a block-scoped version fell to a
  binding declared *before* the block that carried the runs past the window. Clause 4 answers that
  one — and was itself walked past on the next pass, by a bracket read, which is why its text says
  what it counts. A fifth clause would buy that one shape and teach nobody anything, so there is
  deliberately no fifth clause. Every clause MUST instead be accompanied by the sources it
  rejects, kept as fixtures: that is the part that compounds, because it makes what the check
  covers legible rather than asserted.

  **What actually holds the property is behavioural, and it is not weak.** [0007 S7-30]'s corpus
  re-derives every placement's runs and points from the wall on both sides of every resolution of
  every conformance vector, using an implementation written independently in the test. A second
  copy that *disagrees* fails the build the first time it produces a different number, and the
  build is the gate, so no drift ships. The residue that neither the clauses nor the corpus covers
  is precise and small: a second implementation that agrees on every position the corpus reaches
  and differs only on one it does not, and a second implementation whose output never reaches the
  record at all — of which [0007 S7-23] catches the part that matters, since a sibling feeding the
  accumulator instead of the record breaks `tiling === sum(points)`.

  Declared here, where the `E1` scanner reads it, and required by [0007 S7-12] and [0007 S7-35].

- **[E1-39]** `outcome()` returns `+1` if player 0 wins, `-1` if player 1 wins, `0` for a draw,
  and `null` while the game is unfinished. Ties on score are broken by the number of complete
  rows; still tied is a draw.

## Invariants

Assertable after every ply, and checked by the property tests in *0002*.

- **[E1-40]** **Conservation.** Counting the bag, lid, centre, every display, both floor lines,
  both sets of pattern lines, and both walls yields the same census after every ply as before it:
  no tile is created or destroyed. For any state reachable from `newGame` that census is exactly
  20 of each colour — and `tileCensus` is the way to check it.

  Stated as invariance rather than as the constant `[20,20,20,20,20]` on purpose. An artificially
  posed position may hold fewer tiles (see [E1-37]), and the property that matters there is the
  same one: whatever it starts with, it neither gains nor loses.
- **[E1-41]** `tilesLeft` equals the sum of all display and centre counts.
- **[E1-42]** The marker is in exactly one place: the centre, or one player's floor.
- **[E1-43]** No pattern line exceeds its capacity, holds two colours, or holds a colour already
  on that row of the wall.
- **[E1-44]** No wall cell is set twice, and each colour appears at most once per row and per
  column.
- **[E1-45]** Scores are never negative.
- **[E1-64]** `shufflesUsed` never decreases, and rises by exactly one per shuffle call ([E1-61]).
  This is what makes the index meaningful: a state's `shufflesUsed` is the index the next shuffle
  will be given. It equals the number of shuffles actually behind it only when the counter has
  run from the start of a game; a rebased fixture resets it to zero mid-game ([0002 V2-33]), so
  for those the two differ and only the index reading holds.

## Determinism

- **[E1-46]** The only randomness is bag shuffling. The engine MUST take a seed and MUST use its
  own PRNG — not `Math.random` — so a game replays identically on any platform and any JS engine.
  Default: a 32-bit `xoshiro128**` stream seeded through `splitmix32`, shuffled with Fisher-Yates
  descending (`for i = n-1 down to 1: swap(a[i], a[rng.below(i+1)])`). The algorithm and the
  shuffle direction are part of the contract: change either and every recorded game changes.
- **[E1-47]** The generator MUST be consumed only by the shuffles in `newGame` and [E1-33].
  Nothing else may draw from it, or the same seed stops meaning the same game.
- **[E1-48]** `clone()` MUST duplicate every mutable container, the generator's internal state,
  and `shufflesUsed`, so a clone continues the parent's stream exactly and neither can affect the
  other. This holds under an injected shuffle as well as under the seeded default — which is why
  the seam is indexed rather than stateful ([E1-61]). A seam that kept its own cursor would be
  shared between parent and clone, and [0002 V2-22] would be unsatisfiable on exactly the runs
  where it is required.
- **[E1-49]** The port does NOT reproduce ludometer's tile order for a given numeric seed —
  Python's Mersenne Twister is a different generator. Conformance is therefore replay-based, not
  seed-based; see *0002 — Engine conformance vectors*.
- **[E1-61]** Both constructors — `newGame` and `fromCanonical` — MUST accept an optional shuffle
  function in place of the seeded default. `fromCanonical` needs it as much as `newGame` does: a
  handcrafted position is typically one with a nearly-empty bag, so a lid recycle during its next
  few plies is the normal case, not an exotic one. The function is called exactly where [E1-47]
  permits randomness and nowhere else: once in `newGame` on the full bag, and once per lid
  recycle ([E1-33]). An ordinary refill draws from the bag without shuffling, so most rounds call
  it zero times, and a state restored by `fromCanonical` may never call it at all. This is the
  seam the conformance harness uses to replay a recorded bag order ([0002 V2-6]), which is why
  the call count is part of the contract and not an implementation detail; it is the only
  supported way to influence the engine's randomness, and production callers pass a seed. When a
  shuffle function is supplied the seed is unused — both constructors still require one so that a
  state is never left without a randomness source, but the two are alternatives, not layers.

  The seam MUST be **indexed, not stateful**: it is called as `shuffle(bag, index)` where `index`
  is the state's `shufflesUsed` at the moment of the call, and `shufflesUsed` MUST increment
  immediately after. A replaying harness reads `shuffles[index]` rather than advancing a cursor
  of its own, so the seam is a pure function of `(bag, index)` and carries nothing that `clone`
  would have to duplicate but cannot ([E1-48]). `shufflesUsed` counts calls actually made: a
  refill that finds bag and lid both empty makes none ([E1-33]).

  The count is kept the same way on the **seeded** path — the default PRNG shuffle increments it
  too. It is a property of the position, not of how the position was built, so two identical
  positions compare equal under [0002 V2-5] whether they were seeded or replayed. It follows that
  `newGame` returns a state with `shufflesUsed === 1` (the opening shuffle), and `fromCanonical`
  returns whatever the snapshot carried.

  *(Widened by [0008 A8-22].)* One production caller does not pass a seed: `ai-bot` passes a
  shuffle derived from bag counts alone, the original's universe draw. It is still a pure function
  of `(bag, index)`, so sharing it by reference across `clone` is sound.
- **[E1-72]** The engine suite MUST include a case in which a **clone** of a state built with an
  injected shuffle recycles the lid during a later `apply`. It MUST assert that the shuffle is
  called exactly once, with the recycled bag and the clone's `shufflesUsed`, and that the source
  state is unaffected.

  *Added by [0008 A8-22], under CLAUDE.md's new-caller rule. Until then the seam had been driven
  only by the conformance harness replaying recorded orders into states it never clones; the
  expert's search drives it through `clone` on every simulation.*

## Interfaces

```ts
// construction
type Shuffle =                                        // in place, indexed; see [E1-61]
  (bag: Color[], index: number) => void;
function newGame(seed: number, shuffle?: Shuffle): AzulState;
function clone(s: AzulState): AzulState;

// actions
function encodeAction(source: number, color: Color, dest: number): number;
function decodeAction(action: number): [source: number, color: Color, dest: number];
function legalActions(s: AzulState): number[];
function isLegal(s: AzulState, action: number): boolean;
function apply(s: AzulState, action: number): void;   // mutates; throws on illegal
function applyExplained(                              // mutates; throws on illegal
  s: AzulState,
  action: number,
): RoundScoring | null;                               // null unless the ply ended a round;
                                                      // see [0007 S7-1]

// inspection
function outcome(s: AzulState): 1 | 0 | -1 | null;
function floorPenalty(s: AzulState, p: Player): number;
function completedRows(s: AzulState, p: Player): number;
function completedCols(s: AzulState, p: Player): number;
function completedColors(s: AzulState, p: Player): number;
function tileCensus(s: AzulState): number[];          // per-colour census; [20,20,20,20,20]
                                                      // when reachable from newGame, [E1-40]
function recount(s: AzulState): void;
function placementValue(                              // one tile's points; see [E1-68]
  wall: readonly number[],
  row: number,
  col: number,
): number;
function wallCompletedRows(wall: readonly number[]): number;   // see [E1-70]
function wallCompletedCols(wall: readonly number[]): number;   // see [E1-70]
function wallCompletedColors(wall: readonly number[]): number; // see [E1-70]

// serialisation and display
function toJSON(s: AzulState): AzulJSON;              // lossy view for the UI, see [E1-52]
function fromJSON(                                    // from the lossy view; see [E1-69]
  json: AzulJSON,
  seed: number,
  shuffle?: Shuffle,
): AzulState;
function toCanonical(s: AzulState): CanonicalState;   // lossless, see [E1-62]
function fromCanonical(                               // one-sided inverse: see [E1-62]
  c: CanonicalState,
  seed: number,
  shuffle?: Shuffle,
): AzulState;
function renderText(s: AzulState): string;            // debugging aid
function encode(s: AzulState): Float32Array;          // length ENCODED_SIZE
function encodeFor(                                   // same, from p's seat; see [E1-67]
  s: AzulState,
  p: Player,
): Float32Array;
```

Exported types: `AzulState`, `CanonicalState`, `AzulJSON`, `AzulJSONPlayer`, `Color`, `Player`,
`Shuffle`, and the round-scoring record of *0007 — Scoring explained*: `RoundScoring`,
`PlayerRound`, `PlayerBonuses`, `Placement`, `FloorCharge`. `placementRuns` is private and is
deliberately not listed ([0007 S7-11]).

- **[E1-50]** The package MUST have no runtime dependencies and MUST NOT touch the DOM, the
  filesystem, timers, or the network — it has to run unchanged in a browser, in a worker, and
  under Vitest in Node.
- **[E1-51]** `apply` and `recount` mutate the state passed to them, and an injected shuffle
  ([E1-61]) mutates the array it is handed. Every other function above MUST leave its arguments
  untouched and MUST NOT read or write anything outside them — no module-level mutable state, no
  ambient clock, no globals.
- **[E1-52]** `toJSON` MUST return structurally-cloneable plain data (no class instances, no
  functions) so a state can cross a worker boundary. It MUST report the bag as per-colour counts
  and MUST NOT expose its order, which is hidden information no player may see.
- **[E1-69]** `fromJSON(json, seed, shuffle?)` MUST construct a state from a lossy view, filling
  the bag with `json.bag[c]` tiles of each colour `c` in ascending colour order, and MUST
  otherwise behave as `fromCanonical` ([E1-62]) — including its `tilesLeft` check. It MUST set
  `shufflesUsed` to 0, which `AzulJSON` does not carry. For any `j` produced by `toJSON` the
  result MUST satisfy `legalActions(fromJSON(j, …))` deep-equals `j.legalActions` — the
  qualification matters, since a hand-written `j` may carry a `legalActions` that its own board
  does not imply, and nothing here can reconcile that.

  *The bag order it produces is arbitrary and is fixed only so that this is a function rather than
  a family of them. A caller that deals from such a state deals a fiction — and the bot does
  deal one, every time it applies a round-ending ply, because `endRound` refills inside the
  same ply that scores ([E1-21]). What saves it is that it never looks: [0004 B4-6] stops the
  search *past* the boundary and [0004 B4-7] stops the evaluation reading what was dealt.*

  *`shufflesUsed` restarting at 0 is a trap worth naming, because it is the shuffle seam's own
  index ([E1-61]): a caller that passes a recorded `shuffle` to `fromJSON` will be handed
  index 0 at the first lid recycle and replay the wrong entry. Use `fromCanonical` for
  anything that replays.*

  *Its reason for existing is that it makes an information barrier out of a type: a caller holding
  only an `AzulJSON` has no bag order to leak, because `toJSON` never gave it one ([E1-52]). That
  is [0004 B4-10], and it is why the bot is handed a view rather than a state.*

  *It follows that `toJSON` cannot distinguish two positions that will deal differently, so it is
  the wrong tool for comparing or restoring states — use [E1-62]. That is guidance for callers,
  not a rule the engine can enforce, which is why it is not phrased as a requirement.*
- **[E1-62]** `toCanonical` MUST return a lossless, structurally-cloneable snapshot: **every**
  field of the data model and nothing else, with the bag as an ordered colour array, and object
  keys emitted in the order the data-model listing above declares them, which is what makes
  [0002 V2-11]'s byte-identical regeneration possible across two languages. "Every field" includes the two bookkeeping counters
  — `tilesLeft`, which the board could imply, and `shufflesUsed`, which nothing could — because
  comparing them catches a port whose bookkeeping has drifted at the ply it drifts, rather than
  several plies later when the drift finally changes a deal. "Nothing else" excludes derived
  caches as [E1-5] defines them. `fromCanonical` MUST rebuild those caches, and MUST reject a
  snapshot whose `tilesLeft` disagrees with its own board ([E1-41]) rather than loading a
  position the engine could never have reached; `shufflesUsed` admits no such check, which is
  why [0002 V2-33] pins it at the fixture end instead. `fromCanonical` MUST be a
  **one-sided** inverse: `toCanonical(fromCanonical(c, …))` deep-equals `c` for every canonical
  `c`. The other direction does not hold, and MUST NOT be claimed: a snapshot deliberately omits
  the PRNG's internal state, so `fromCanonical` takes a seed of its own, and a restored state
  continues play identically to its source only under the same randomness — which for conformance
  means the recorded shuffles of [E1-61]. `clone` is the operation that preserves the stream
  exactly ([E1-48]); this pair is not. Together they are what makes handcrafted conformance
  positions loadable ([0002 V2-16]) and what state comparison is defined against ([0002 V2-5]).

## Observation encoding

`encode()` produces a fixed-length `Float32Array` from one seat's point of view: "me" is the
seat being encoded — `currentPlayer` for `encode`, the chosen `p` for `encodeFor` ([E1-67]) —
and "them" is the other player. The bot depends on this layout; it is a
contract, not an implementation detail.

| Range | Length | Contents |
| --- | --- | --- |
| `[0, 25)` | 25 | My wall, row-major, 0/1 |
| `[25, 50)` | 25 | Their wall |
| `[50, 80)` | 30 | My pattern lines: 5 rows × (5 colour one-hot, then `count / (r + 1)`) |
| `[80, 110)` | 30 | Their pattern lines, same layout |
| `[110, 117)` | 7 | My floor: 5 colour counts `/7`, occupied slots `/7`, marker flag |
| `[117, 124)` | 7 | Their floor, same layout |
| `[124, 126)` | 2 | Scores `/100` — mine, theirs |
| `[126, 151)` | 25 | Factory displays: 5 × 5 colour counts `/4` |
| `[151, 156)` | 5 | Per-display non-empty flag |
| `[156, 161)` | 5 | Centre colour counts `/10` |
| `[161, 162)` | 1 | Centre total `/20` |
| `[162, 163)` | 1 | Marker still in the centre, 0/1 |
| `[163, 168)` | 5 | Bag colour counts `/20` |
| `[168, 173)` | 5 | Lid colour counts `/20` |
| `[173, 174)` | 1 | Tiles left on the board this round `/20` |
| `[174, 175)` | 1 | `floorMarker[me] || firstPlayer === me` — see [E1-63] |
| `[175, 176)` | 1 | `min(roundIndex, 10) / 10` |
| `[176, 179)` | 3 | My complete rows `/5`, columns `/5`, colours `/5` |
| `[179, 182)` | 3 | Theirs, same three |

- **[E1-53]** `ENCODED_SIZE` is 182, and every field offset in the table above MUST be exported
  as a named constant holding the value shown for it there. *(Using those constants instead of bare literals at call
  sites is a lint concern, not something a test can observe — hence not part of the
  requirement.)*
- **[E1-54]** An empty pattern line contributes all zeros — no colour bit, zero fill.
- **[E1-55]** Bag and lid *counts* are public information in Azul and are encoded; the bag's
  *order* is not encoded and MUST NOT be.
- **[E1-56]** Every value MUST be finite and non-negative. Most fields are normalised into
  `[0, 1]`, and two are explicitly clamped there — floor slots (`min(occupied, 7) / 7`) and the
  round index (`min(roundIndex, 10) / 10`). The divisors elsewhere are **scaling constants, not
  clamps**, and two fields provably exceed 1 in legal positions: centre colour counts are divided
  by 10 though the centre can hold more of one colour, and scores are divided by 100 though a
  finished game can score well past that. Neither MUST be clamped — clamping would silently
  diverge from the reference encoder and corrupt every vector. Tests MUST assert the real bound
  (finite, `>= 0`) plus the two clamped fields, not a blanket `<= 1`.
- **[E1-67]** `encodeFor(s, p)` MUST produce the vector `p` would see, and `encode(s)` MUST equal
  `encodeFor(s, s.currentPlayer)`. Neither mutates the state ([E1-51]), so the opponent's view is
  reachable without setting `currentPlayer` and re-encoding — which callers must not do, and
  which the conformance harness is forbidden from doing at all ([0002 V2-3]). Without this the
  perspective tests in [0002 V2-25] and [0002 V2-30] cannot be written.
- **[E1-63]** The `[174, 175)` flag is exactly `floorMarker[me] || firstPlayer === me`. It is a
  **disjunction**, and both halves matter: it is set for the player currently holding the marker
  *and* for the player who started the current round. It is therefore not "I start the next
  round" — mid-round, both players can see it set at once, and a player who started this round
  but did not take the marker sees it set while someone else starts the next one. The reference
  implementation's own inline comment glosses this field as the "next round" flag; the code is
  the contract, and the code is a disjunction.
- **[E1-57]** Changing this layout requires a new spec: it invalidates every trained model.

## Performance

The bot explores many thousands of positions per move, in a browser, on the same thread as the
UI unless a worker is used. Targets on a modern laptop, single-threaded, measured by the
benchmark suite:

- **[E1-58]** `legalActions` + `apply` SHOULD sustain at least 200 000 plies per second.
- **[E1-59]** `clone` SHOULD cost no more than ~1 µs and SHOULD NOT allocate beyond the state it
  copies.
- **[E1-60]** `legalActions` SHOULD build its result from precomputed tables rather than
  scanning all 180 actions. The reference implementation keeps a 5-bit "open rows" mask per
  colour per player, updated on placement and rebuilt at round end, and indexes a table of
  ready-made action lists.

These are budgets, not correctness gates: a regression here is a bug to file, not a failing
build.

## Verification

Specified in *0002 — Engine conformance vectors*. In summary: replay games recorded from the
Python reference ply by ply and compare full state at every step, with every invariant above
asserted on every ply of every replay ([0002 V2-18], [0002 V2-19]); handcrafted
edge positions for the cases random play never reaches; and randomised self-play as fuzz
coverage, where conservation and non-throwing behaviour are what is checked ([0002 V2-24]).

### Traceability exemptions

[0002 V2-26] requires every requirement here to be cited by a test. These cannot be, and are
exempt by name — the check in [0002 V2-27] reads this list, so an exemption must be justified
here or the suite fails:

| Requirement | Why it is not testable |
| --- | --- |
| [E1-8], [E1-57] | Process constraints on changing the encoding and the observation layout. A test cannot observe a promise about future specs. |
| [E1-49] | Testing it would need the oracle to hand, which [0002 V2-8] forbids the suite from having. |
| [E1-58], [E1-59] | `SHOULD` budgets, explicitly declared above to be non-gating. The benchmark suite measures them; it does not fail the build. |
| [E1-60] | An implementation-strategy `SHOULD`. No behavioural test can see how `legalActions` builds its result — [E1-58] measures whether the strategy worked. |

Every other requirement in this document MUST have a citing test. [E1-50] is deliberately **not**
exempt despite being a build-level concern: a test can assert the manifest declares no runtime
dependencies, and can run a full game with `document`, `fetch`, `Date.now` and the filesystem
replaced by throwing stubs. It is a `MUST` about behaviour, and [0002 V2-31] does not let those
be excused.

## Open questions

- ~~**History.** The engine keeps only the current position. Does undo belong here as a move
  stack, in the UI as replay-from-start, or nowhere?~~ **Answered: nowhere.** *0003 — Web
  interface* has no undo ([0003 U3-17]) and retains no earlier position as a move, so `apply`
  returns no undo record and the engine keeps only the current position. Reopening this is a
  change to that spec first.
- **Storage.** Plain `number[]` arrays follow the reference implementation and clone cheaply at
  this size. Would flat `Uint8Array` state measurably beat them under [E1-58], and is it worth
  the loss of readability?
- **Error style.** `apply` throws on an illegal action ([E1-14]). Should there also be a
  non-throwing `tryApply` for hot paths that would rather branch than catch?

## References

- Intent [0001 — Rules engine](../intent/0001-rules-engine.md)
- Spec [0002 — Engine conformance vectors](0002-engine-conformance-vectors.md)
- Reference implementation: [`ludometer/azul/engine.py`](https://github.com/RemiFabre/ludometer/blob/main/ludometer/azul/engine.py)
