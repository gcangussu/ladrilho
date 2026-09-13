---
title: Web interface
author: Gabriel Cangussu
date: 2026-09-05
status: implemented
intent:
  - 0002 — Web interface
  - 0005 — A board that holds still, and lines beside its wall
prefix: U3
depends-on: 0001 — Engine core, 0002 — Engine conformance vectors
summary: >
  The hot-seat web client: how a turn is taken, what the board shows, how state
  is held and published, and what makes "the interface contains no rule" a thing
  a test can observe. Rules, scoring and legality belong to 0001 — Engine core;
  choosing a move belongs to intent 0003 — Computer opponent.
---

# Web interface

## Scope

Covers `packages/ui`: a two-player hot-seat Azul client, built on Solid v2, running entirely in
the browser on top of `packages/engine`.

Does not cover the rules of Azul (*0001 — Engine core*), how the engine is proven correct
(*0002 — Engine conformance vectors*), or evaluating a position (*intent 0003 — Computer
opponent*). The interface displays, selects, and submits; it decides nothing.

It also does not settle how a move arrives from something that has to think about it first.
[U3-18] applies and publishes synchronously and [U3-20] propagates a synchronous throw; across the
worker boundary intent 0003 wants, both become asynchronous, and a "thinking…" state needs
somewhere to live that is neither the old view model nor the new one. [U3-31] keeps the seam
narrow enough to widen — `submit` takes an action and learns nothing about who chose it — and the
spec that serves *intent 0003* changes its signature, and this document with it.

### The three open questions, answered

Intent 0002 leaves three questions open. This spec answers all three, at the minimal end:

| Intent 0002's question | Answer | Where |
| --- | --- | --- |
| First — does an undo button exist? | **No.** Moves are final. | [U3-17] |
| Second — does it point out a costly move? | **No.** Availability is the only thing expressed. | [U3-29], [U3-30] |
| Third — how much survives a refresh? | **Nothing.** A reload deals a fresh game; a seed in the URL reproduces the deal, not the position. | [U3-15], [U3-16] |

These answers mean **the engine does not change**: an undo would have needed a move stack or a
replay log, and persistence a versioned snapshot format. Neither exists, and neither is required.
The engine's own open question about history — *0001 — Engine core*, *Open questions* — resolves
to *nowhere*.

### Two places this knowingly fell short of intent 0002, and when they were reopened

Beyond its three questions intent 0002 states things it simply wants — one criterion under *What
good looks like*, one sentence in *The idea*. Both were met only in part when this document was
written, and both shortfalls traced to the same constraint under *Constraints*: "It never contains
a rule. Everything it knows about legality and scoring it asks the engine for."

**Scoring legibility.** "Scoring is legible: when points are awarded you can tell which tiles
earned them." [U3-43] shows which tiles arrived on the wall and each player's net change — but not
what each tile earned, and when three pattern lines resolve together the arithmetic was not
recoverable from what is shown. Producing a per-tile figure meant re-deriving [0001 E1-24] in the
interface, because `apply` resolves a round atomically and reported no breakdown
([0001 E1-22] through [0001 E1-29]).

**End-of-game bonuses.** "At the end of the game the bonuses are shown and a winner is declared."
[U3-44] declares the winner and [U3-46] shows each player's completed row, column and colour
**counts** — but not the points those counts earned, because turning a count into points is
[0001 E1-38]. The score delta of [U3-43] cannot stand in: on the terminal ply `endRound` clamps
the round score at zero ([0001 E1-28]) and `finishGame` then adds unclamped bonuses, so a single
observed delta is `max(0, score + tiling + penalty) − score + bonus` and the clamp destroys the
split irrecoverably.

**Both are now closed, and neither was closed here.** They were recorded rather than quietly
narrowed, because a frozen intent cannot argue back; they became *intent 0004 — Scoring explained*,
which asks for the workings rather than the total; and the fix was where the diagnosis said it had
to be. The points exist only inside round resolution, so the engine reports how it scored and not
only how much — `applyExplained` and its `RoundScoring` ([0007 S7-1]) — and the interface shows
what it is handed. [U3-82] through [U3-85] are that side of it, and [U3-46] is extended to itemise
the bonus half. The interface still performs no arithmetic on either.

What remains narrowed is smaller and is not a shortfall against the intent: only the most recent
round's workings are kept ([U3-82]), because the engine retains no record ([0007 S7-7]) and a
scoresheet of every round needs a place to accumulate and a surface to browse. *Intent 0004* asks
that question; a record is already a value safe to keep ([0007 S7-8]), so nothing here forecloses
it.

## Definitions

Terms from *0001* — colour, source, destination, ply, round, marker — carry their meaning there
unchanged. Added here:

| Term | Meaning |
| --- | --- |
| **View model** | The plain, structurally-cloneable snapshot the components render. Never the engine state itself. |
| **Selection** | A `(source, colour)` pair a player has picked but not yet placed: the first half of a turn. |
| **Available** / **unavailable** | A control the current player can act on, or one that is present and focusable but does nothing. The single vocabulary for legality; see [U3-29]. |
| **At rest** | Between plies, with no selection active. |
| **Stateless engine function** | Exactly these engine exports, none of which takes an `AzulState`: `encodeAction`, `decodeAction`, `wallCol`, `wallColorAt`, and the exported constants. |
| **Round transition** | The moment a `submit` empties the board and the engine resolves the round inside the same `apply` ([0001 E1-21]). |
| **Publish** | Replace the view model with a freshly derived one, causing a render. |

## Data model

The engine's state is mutable and `apply` mutates it in place ([0001 E1-51]). That makes it a
poor fit for a reactive graph: nothing about the object changes identity when the game moves on,
so nothing downstream can notice. The interface therefore keeps two things, and keeps them apart.

```ts
// Held, not observed. One per game, outside the reactive graph.
let state: AzulState;

// Observed, not held. Replaced wholesale after every ply.
interface ViewModel {
  game: AzulJSON;                 // toJSON(state) — see [0001 E1-52]
  floorOccupied: number[];        // [2], from floorOccupied(state, p)
  seed: number;                   // the seed this game was dealt from
  transition: Transition | null;  // set for exactly one ply; see [U3-42]
  scoring: RoundScoring | null;   // the most recent round's workings; sticky,
                                  // see [U3-82] and [0007 S7-1]
}

interface Transition {
  newlyPlaced: number[][];        // [2][25], flat row-major as [0001 E1-2],
                                  // flattened from AzulJSONPlayer.wall's 5×5
  scoreDelta: number[];           // [2]
  ended: boolean;
}

type Selection = { source: number; color: Color } | null;
```

- **[U3-1]** The authoritative `AzulState` MUST live outside the reactive graph, MUST NOT be
  wrapped in a signal or a store, and MUST NOT be read by a component.
- **[U3-2]** The view model MUST be plain data — no class instances, no functions, nothing holding
  a reference to the state. `AzulJSON` is already this by [0001 E1-52]; the fields beside it
  MUST be too.
- **[U3-3]** The interface MUST NOT re-derive a **rule outcome** the engine already computes:
  which moves are legal, what a placement scores, what a floor line costs, where a colour sits on
  the wall, what a completed row is worth.

  Four things are explicitly *not* rule outcomes and are the interface's own work: **choosing
  among** the actions in `game.legalActions` ([U3-23], [U3-24]); **detecting** a round transition
  from `game.round` and `game.isTerminal` ([U3-39]); **diffing** two view models to see what
  changed ([U3-42]); and **presentational ordering** ([U3-38]).

  *The line is between reading the engine's answer and computing your own. Filtering a list the
  engine produced is reading; deciding what belongs in it is computing.*

- **[U3-4]** Anything the engine can compute **from a state** that `toJSON` does not carry MUST be
  obtained from an engine function beside the state, at publish time, and published as plain data
  — the way `floorOccupied` is here. It MUST NOT be reconstructed on the view side. Stateless
  engine functions are outside this rule and MAY be called anywhere, including from a component.

  *Occupied floor slots are the small case that proves the rule: summing five counts and adding
  one for the marker looks like arithmetic, but it is [0001 E1-26], and the engine exports
  `floorOccupied` so the interface never has to write it down. `wallColorAt` is the contrast — it
  takes no state, answers the same way forever, and belongs wherever it reads best.*

- **[U3-5]** Exactly one `AzulState` MUST exist per game: `newGame` is called once per game and
  nowhere else.
- **[U3-6]** Every value a component reads **that derives from the game state** MUST be a declared
  field of the view model. It gains `seating`, `thinking` and `lastChoice` with the computer
  opponent ([0006 W6-2], [0006 W6-19], [0006 W6-25]), and `scoring` with the workings
  ([U3-82]). *(Extended by [0006 W6-28].)* The exceptions are the current selection and the stateless engine
  functions of [U3-4]. A component that needs anything else gets a new view-model field, computed
  at publish time.

  *This is the seam intent 0003 will need. Everything state-derived that the components see has
  already crossed a structured-clone boundary, so a worker-hosted engine changes where `publish`
  runs and what `submit` returns ([U3-18]) — not what the board renders.*

## Behaviour

### Package and build

- **[U3-7]** `packages/ui` MUST depend on `engine`, `bot` and `ai-bot` as workspace dependencies,
  and `engine` MUST be the only dependency that carries any knowledge of **the rules of** Azul.
  `bot` and `ai-bot` know how to play but ask the engine what is legal; this requirement is about
  rules, not about strategy. *(Widened by [0006 W6-28]; the parenthetical it replaces anticipated
  exactly this. Widened again by [0008 A8-33], for `ai-bot`.)*
- **[U3-8]** The client MUST make **no network request at runtime**: no `fetch`,
  `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, dynamic `import()`, or asset addressed by
  an absolute URL. There is no server and there are no accounts.

  The one exception is a same-origin **module worker** constructed from
  `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`, which is the only
  thing the client loads at run time ([0006 W6-11]). It is a script the bundler resolves at build
  time and emits beside the client, not a request for data and not a dynamic `import()`; every
  other item above stays forbidden. *(Widened by [0006 W6-28].)*
- **[U3-9]** The build output MUST be static files, servable from any file host.
- **[U3-10]** The package MUST build against Solid **v2** — see <https://v2.solidjs.com>, and the
  notes under *Solid v2* below. v1 patterns are not merely dated here; several are gone.
- **[U3-11]** The package MUST use **Vitest 5**, matching `packages/engine`. Solid's testing guide
  pins Vitest 4 (<https://v2.solidjs.com/guides/testing>); that pin is a known-good, not a
  constraint, and one runner version across the monorepo is worth more than following it. Dropping
  this package to 4 is permitted **only** on a demonstrated incompatibility, recorded here when it
  happens.

### State and the engine seam

- **[U3-78]** `packages/ui/src` MUST place the held state, `submit` and `publish` in a **single
  module**, and every component under `src/components/`. Nothing else may import that module's
  state binding.

  Two further modules are named and are neither: `opponent.ts`, the worker seam, which is the only
  file that may import `bot` ([0006 W6-31]); and `worker.ts`, which runs inside the worker and MUST
  NOT be reachable from the state module or from a component ([0006 W6-12]).
  *(Extended by [0006 W6-28].)*

  *A structural requirement because three checks depend on being able to name the two sides:
  [U3-75] cannot look for "`apply` outside the submit path" or "a component reading the state"
  until "the submit path" and "a component" are paths on disk.*

- **[U3-12]** A game MUST be created with `newGame(seed)` and by no other means. The interface
  MUST NOT assemble or edit a state, though [0001 E1-5] would permit it.
- **[U3-13]** The seed MUST be an integer in `[0, 2**32)`. A generated seed MUST come from
  `crypto.getRandomValues` into a `Uint32Array`; a `seed` URL parameter that does not parse to an
  integer in range MUST be discarded and a fresh seed generated in its place.

  *`Rng`'s constructor reduces its argument with `seed | 0`. [0001 E1-46] pins the algorithm but
  not that reduction, so this range is a constraint the interface adopts rather than one the
  engine spec imposes — and it matters: `Math.random()` reduces to 0, as does `?seed=banana`
  (`NaN | 0`), so without it every game is the same game. On `[0, 2**32)` the reduction is
  injective, and it is exactly what `crypto.getRandomValues` yields.*

- **[U3-14]** The seed in play MUST be displayed. With [U3-15] and [U3-17] in force it is the only
  way to see a given deal twice.
- **[U3-15]** The interface MUST NOT write to `localStorage`, `sessionStorage`, IndexedDB, or
  `document.cookie`.
- **[U3-16]** Game state MUST NOT survive a reload. A seed carried in the URL reproduces the
  **deal**, not the position: the moves played are gone, and the game MUST restart from the
  opening.
- **[U3-17]** There MUST be no undo: no control returns the game to an earlier position, and no
  earlier position is retained for that purpose. *(The one-ply retention of [U3-41] is for display
  and is not reachable as a move. [U3-65] is the positive form a test can assert.)*
- **[U3-18]** Every advance of the game MUST go through a single `submit(action)` path, which
  applies the action to the held state and then publishes. No component calls `apply`.

  `applyExplained` ([0007 S7-1]) is the state module's alone on the same terms, and is the path
  `submit` takes: it performs the identical transition and additionally returns the record
  [U3-82] keeps. There is still exactly one way into the held state — the entry point changed,
  the number of them did not.

  `submit` stays **synchronous**. What became asynchronous when the computer opponent arrived is
  the *arrival* of a move — the turn loop of [0006 W6-6] — not this call. A move from the worker
  reaches the game through the same `submit` a person's does ([U3-31], [0006 W6-8]).
  *(Clarified by [0006 W6-28].)*
- **[U3-19]** `submit` MUST NOT be reachable for an action outside `game.legalActions`.
- **[U3-20]** `submit` MUST NOT guard against an illegal action either: if it is ever called with
  one, the engine's throw ([0001 E1-14]) MUST propagate. A caught-and-ignored illegal action hides
  exactly the defect this document exists to prevent — a view that has drifted from the rules.
- **[U3-21]** `publish` MUST replace the view model wholesale and MUST NOT mutate the previous
  one. It MUST derive the new view model from the state it just advanced, and MUST NOT read a
  signal back after writing it — in Solid v2 that read returns the previous value (*Solid v2*,
  below). [U3-63] is what catches the violation: a view model built from a stale read no longer
  matches the state it claims to describe.

### Taking a turn

- **[U3-22]** A turn MUST be two steps: choose a `(source, colour)`, then choose a destination.
- **[U3-23]** Exactly those `(source, colour)` pairs that appear in at least one action in
  `game.legalActions` MUST be available. Every other rendered tile group is unavailable.
- **[U3-24]** With a selection active, exactly those destinations `d` for which
  `encodeAction(source, colour, d)` is in `game.legalActions` MUST be available, and no others.
  Such a set is never empty: the floor is always available while tiles are ([0001 E1-12]).
- **[U3-79]** The rendered **move** control set MUST be: one control per `(source, colour)` group whose
  pool actually holds a tile of that colour, and all six destinations of [0001 E1-6]. Controls that are
  not moves — a new game ([U3-47]), the seed ([U3-14]) — are outside it. This is the
  universe [U3-61] and [U3-62] are quantified over — without it "no more, no fewer" has no domain,
  and [U3-23] could be read as demanding a control for red on a display holding no red.
- **[U3-25]** Choosing an available destination MUST submit the action immediately, with no
  intervening step, and MUST clear the selection.
- **[U3-26]** Choosing the selected pair again or pressing <kbd>Escape</kbd> MUST clear the
  selection; choosing a different available pair MUST replace it.
- **[U3-27]** Clearing or replacing a selection MUST NOT change the game.
- **[U3-28]** A selection MUST NOT survive a ply. *(A round transition and the end of the game both
  happen inside a ply, [0001 E1-21], so they need no separate clause.)*
- **[U3-29]** Availability MUST be the only expression of legality, and MUST never be an error
  raised after the fact. An unavailable control MUST remain present and focusable, MUST carry
  `aria-disabled`, and MUST do nothing when activated.

  *Present-and-inert rather than absent-or-`disabled`, deliberately. Intent 0002 wants someone who
  has never played to work the game out because "only legal choices are ever clickable" — which
  only teaches if the illegal ones are still there to be found. A `disabled` element is removed
  from the tab order and from most assistive-technology navigation, so a keyboard player would
  never reach the cell they are wondering about.*

- **[U3-30]** The interface MUST NOT indicate the cost or quality of a move before it is made: no
  warning, no confirmation step, no ranking, no preview of the resulting position. *(A floor
  line's current penalty is still shown as part of the board, [U3-38]; what is forbidden is
  attaching a judgement to a move not yet made. [U3-25] pins the half a test can see.)*
- **[U3-31]** `submit` MUST take an action and nothing else, and MUST NOT read anything
  identifying **how** the move was chosen. A move from a person and a move from a program are the
  same call.

### What the board shows

- **[U3-32]** The interface MUST show, at all times: the five factory displays with their tiles by
  colour, the centre pool, where the first-player marker is, both players' walls, pattern lines
  and floor lines, both scores, the round index, and the tiles remaining on the board this round.
- **[U3-81]** Each factory display MUST be rendered as a group of its own, holding that display's
  controls and no others, and showing its number where it can be seen and not only in the
  accessible name of the controls inside it. A display MUST NOT move on screen because of a ply:
  once emptied it MUST keep the position and the footprint it had while it held tiles, for the
  rest of the round.

  *[U3-32] and [U3-54] are both satisfied by a single flat row of source controls, and such a row
  is unreadable: nothing on screen says where one display ends and the next begins, so which
  display a player is taking from is a fact only a screen reader is told. The second sentence is
  the one with teeth, and it is about position rather than order: a display sized to what it holds
  collapses when it is taken from, and every display beside it slides — out from under a pointer
  that was already aiming at one of them, and away from where a player learnt it was. Only the
  [U3-73] lane can see this; jsdom reports every box as zero.*

- **[U3-33]** Whose turn it is MUST be unmistakable, and MUST NOT be conveyed by colour alone.
- **[U3-34]** The interface MAY show bag and lid contents as per-colour counts. *(There is nothing
  to forbid: `toJSON` reports the bag as counts and never its order, which is hidden information
  no player may see — [0001 E1-52], [0001 E1-55]. The order is not available to display.)*
- **[U3-35]** Each player's completed rows, columns and colours MUST be shown, from
  `players[p].completedRows`, `completedCols` and `completedColors`. This is the intent's "how far
  each player is from finishing a row, a column, or a colour", and every number in it comes from
  the engine.
- **[U3-36]** Every tile MUST carry a second, non-colour cue for its colour — a glyph, a pattern,
  or a label — and every colour name MUST come from `game.colorNames`.
- **[U3-37]** An empty wall cell MUST show which colour belongs there, using `wallColorAt` — a
  stateless engine function, so a component may call it directly ([U3-4]).
- **[U3-38]** A floor line MUST show its occupied slots (`floorOccupied`) and the penalty it
  currently carries (`players[p].floorPenalty`), both engine-supplied. Tiles MUST be laid out
  marker first, then by colour in order `0..4`. That order is **presentational and carries no
  rules meaning**: the engine stores the floor as per-colour counts precisely because order never
  affects scoring ([0001 E1-3]), and the penalty depends on the count of occupied slots, not on
  which tile sits in which one ([0001 E1-27]).

  *Stated because the interface has to choose something, and a slot position sitting above a
  penalty ladder reads as though the rules put it there. They do not.*

### Round transitions and the end of the game

- **[U3-39]** A round transition MUST be **detected**, not predicted: it has happened when the
  freshly published `game.round` exceeds the retained one, **or** when `game.isTerminal` has
  become true.

  Both clauses are needed, and neither alone suffices. The row-completion ending ([0001 E1-36])
  finishes the game *before* the round index is incremented, raising `isTerminal` without raising
  `round`; the exhausted ending ([0001 E1-37]) increments first and then finishes, raising both;
  an ordinary round raises `round` alone ([0001 E1-35]). The disjunction covers all three.

- **[U3-40]** The interface MUST NOT anticipate a transition by watching `tilesLeft`.
- **[U3-41]** The view model published immediately before a transition MUST be retained for
  exactly one ply, and used only to compute [U3-42].
- **[U3-42]** The transition diff MUST be computed inside `publish`, from the retained and the new
  view model, and published as the `transition` field: the wall cells set in the new one and unset
  in the retained one, each player's score change, and whether the game ended. It MUST be `null`
  on every other ply.
- **[U3-43]** After a transition the interface MUST show **exactly** two things about it: the
  newly-placed wall cells, marked, and each player's score change as a delta. The marking MUST
  clear on the next ply. Points MUST NOT be attributed to individual tiles.

  *"Exactly" is the requirement, and the shortfall it creates against intent 0002 is recorded in
  Scope rather than hidden here.*

- **[U3-44]** At the end of a game the interface MUST show both final scores and the winner from
  `game.outcome`, where `+1` is player 0, `-1` is player 1, and `0` is a draw ([0001 E1-39]). A
  draw MUST be reported as one, not as a win.
- **[U3-45]** A game that ended exhausted (`game.exhausted`, [0001 E1-37]) MUST be distinguishable
  from an ordinary finish.
- **[U3-46]** The end of a game MUST show each player's completed row, column and colour counts,
  and MUST NOT compute the bonus arithmetic of [0001 E1-38] from them. It MUST also itemise what
  each count earned, read from the bonus half of the record ([0007 S7-19], [0007 S7-22]) and from
  nothing else — the interface still performs no bonus arithmetic. Where there is a record, the
  counts MUST be read from it too, rather than from `AzulJSON`: one fact, one source, or the two
  answers on one line are free to disagree. Where there is no record, the counts stand alone as
  they did before.
- **[U3-47]** A terminal position has no legal actions ([0001 E1-11]), so every move control MUST
  be unavailable, and the only offer MUST be a new game. That new game MUST take a freshly
  generated seed per [U3-13], never the one in the URL.

### How a round scored

Closes the *scoring legibility* shortfall recorded in *Scope*. All four requirements read the
engine's `RoundScoring` ([0007 S7-1]); none of them computes anything.

- **[U3-82]** The view model MUST carry the most recent `RoundScoring`, or `null` before any round
  has scored. Unlike `transition` it **persists across plies**: it is sourced from module state
  the way `seed` and `lastChoice` are, and is replaced only by a later record.

  *A different lifetime from `transition`, in the same struct, and the two MUST NOT be conflated —
  [U3-42] is unchanged and stays null on every non-transition ply. The marking of [U3-43] clears
  on the next ply because it marks tiles on a board that is moving on; the workings stay, because
  reading a round's arithmetic takes longer than a ply does.*

- **[U3-83]** Dealing a game MUST clear it, beside the existing resets of `previous`, `thinking`
  and `lastChoice`. Without this a new game shows the previous game's workings until its first
  round scores — which the sticky lifetime makes minutes rather than a frame, and which no
  single-game test can see.

- **[U3-84]** The workings MUST be rendered from the record and from nothing else: no arithmetic
  on the record's fields, no diff of two positions, no second source. A record whose numbers
  disagree with each other MUST be displayed as it stands, because the interface has no second
  opinion to prefer.

- **[U3-85]** The floor penalty MUST be shown as the ladder of charged rungs, with the marker
  called out, per [0007 S7-16]. Never per tile: the floor is a per-colour count and a marker flag
  ([0001 E1-3]), so there is no order to attribute a rung to a tile by.

### No rule lives here

- **[U3-48]** Legality MUST come from `game.legalActions` and from nothing else. The interface
  MUST NOT test a move against the board, the wall, a pattern line's capacity or colour, or the
  floor's remaining slots.
- **[U3-49]** Every board constant and every piece of wall or action arithmetic MUST come from
  `engine`: `NUM_COLORS`, `NUM_FACTORIES`, `NUM_ROWS`, `FACTORY_SIZE`, `FLOOR_SLOTS`,
  `FLOOR_PENALTIES`, `CUM_PENALTY`, `CENTER`, `FLOOR`, `wallCol`, `wallColorAt`, `encodeAction`,
  `decodeAction`. `packages/ui/src` MUST NOT declare a module-level numeric table of length 5, 7
  or 25, nor restate the penalty ladder in either its incremental (`-1,-1,-2,-2,-2,-3,-3`) or its
  cumulative (`0,-1,-2,-4,-6,-8,-11,-14`) form.

  *Phrased as "import these and declare no table" rather than as a list of forbidden expressions,
  because the forbidden-expression form is both leaky and false-positive-prone: a hard-coded 5×5
  wall lookup restates [0001 E1-1] completely while containing no `%` at all, and `r + 1` is
  simultaneously a pattern line's capacity and the string [U3-54] requires in "pattern line 3".
  A positive import rule plus a table ban is decidable, and the workaround for a banned table —
  derive it from the engine constant — is the behaviour wanted anyway.*

- **[U3-50]** The interface MUST NOT predict the outcome of a move: no `clone`, `structuredClone`
  or `fromCanonical` followed by `apply`, no shadow evaluation, no preview of a resulting
  position. With [U3-30] in force there is nothing to show for it, and it is the shortest path
  back to a second copy of the rules.
- **[U3-51]** Action encoding and decoding MUST use the engine's `encodeAction` and `decodeAction`
  ([0001 E1-6], [0001 E1-7]).

  *[U3-75] is a bounded matcher, and cannot decide whether code "contains a rule". A view-side
  re-implementation of [0001 E1-10] that reads only view-model fields uses no forbidden literal
  and would pass it. [U3-70] is the instrument that catches that, at the first position where the
  copy is wrong.*

### Input and accessibility

- **[U3-52]** Every action MUST be reachable from the keyboard alone: selecting a source and
  colour, choosing a destination, cancelling a selection, and starting a new game. No pointer is
  required at any point.
- **[U3-53]** Each group of controls — the displays, the centre, a board's pattern lines — MUST be
  a single tab stop with a roving tabindex, arrow keys moving within the group. Tabbing through
  180 actions is not keyboard support.
- **[U3-54]** Every control MUST have an accessible name stated in game terms ("three red tiles,
  factory 2"; "pattern line 3, holds two blue"), not a position or an index.
- **[U3-55]** An unavailable control MUST be exposed to assistive technology as `aria-disabled`,
  and MUST remain focusable ([U3-29]).
- **[U3-56]** A live region MUST announce each of: a turn passing to the other player, a round
  transition — which is the only moment a score changes, since scoring happens inside
  `endRound` ([0001 E1-28]) — and the end of the game.
- **[U3-57]** Focus MUST NOT be lost across a ply. When the control that had focus is gone, focus
  moves to the nearest surviving control in the same group.

### Layout

- **[U3-58]** The board MUST be usable at 1280 × 800 and at 844 × 390 — a laptop, and a phone held
  sideways — with **no horizontal page scroll** at either.
- **[U3-59]** Interactive targets MUST be at least 44 × 44 CSS pixels.
- **[U3-60]** Both players' boards, the factories and the centre SHOULD be visible at once,
  without scrolling, at 1280 × 800.

### A board that holds still, and lines beside its wall

Serves *intent 0005 — A board that holds still, and lines beside its wall*. Two properties of a
player's board: whose turn it is does not change its size, and where there is room its lines sit
level with the wall rows they feed.

- **[U3-86]** Whether a player is to move MUST NOT change the size of that player's **play
  area** — its five pattern lines, its floor line and its wall. The offered configuration of
  [U3-79] and the shown configuration MUST occupy the same box for the same board.

  *The two were separate renderings whose heights agreed only by accident — they did not, so a
  board grew when the turn arrived and shrank when it left, and a ply moved the page under a
  player who was still reading it. The shown configuration is every board that is not the board of
  the player to move, which is the waiting board and the terminal board alike — so there are two
  configurations here and never three.*

  The sizes MUST agree at any root font-size, not only at the browser's default. *A control's
  minimum is stated in pixels ([U3-59]) and a tile's size in `rem`; if the two are written
  separately, one configuration is floored where the other is not and they part company at a root
  nothing in the page sets. That is this requirement's own defect reached by another road, and the
  [U3-73] lane can pose it — it owns the document it measures.*

  *Scoped to the play area, and to configuration rather than to time, because both wider claims
  are false. A board section cannot fail a size comparison at all: the two are grid items on one
  row and `align-items: stretch` gives them a common height whatever they hold. And the header
  carries the score delta of [U3-43], which appears on a transition ply and is as long as its
  number. What the play area still admits is recorded under* Two things this does not reach *below.*

- **[U3-87]** The sentence a board states about its floor line ([U3-38]) MUST be produced by one
  function and rendered from it in both configurations. *(It was written twice, agreeing on the
  numbers and disagreeing on the words. Two spellings of one sentence are two lengths, and at some
  board width two heights.)*

- **[U3-93]** Each of the six rows MUST have the same accessible name in both configurations. *(A
  separate obligation from [U3-87] and a separate identifier, so a citation says which of the two
  it covers. The technique differs between the configurations and is not prescribed here: what
  [U3-54] requires is a name, and a row that is only shown has one to state as much as a row that
  is offered.)*

- **[U3-88]** At 1280 × 800 with both boards on screen, a board's lines MUST be to the left of its
  wall, and pattern line *r* MUST be **level** with wall row *r* — equal top edge and equal height
  — for every `r ∈ 0..NUM_ROWS-1`, in both configurations of [U3-86]. The floor line feeds no wall
  row and is exempt.

  A named viewport rather than "wherever there is room", which would be a requirement conditioned
  on its own output: the implementation decides where there is room, so an implementation that
  never put them side by side would satisfy that reading completely.

- **[U3-89]** Where the two columns do not both fit the width the board is given, they MUST wrap
  rather than overflow it. The choice MUST be decided by that width and not by the viewport's.

  Observably, for the second half: at one fixed viewport there MUST be two root font-sizes that
  give different arrangements. A rule written in viewport widths cannot tell them apart, because
  nothing about the viewport differs — what differs is how much room the columns ask for, `--tile`
  and `--tile-gap` being in `rem`. Today 1280 × 800 is side by side at a 16px root and stacked at
  36px.

  *The first sentence is the rule and holds at every width, including the ones [U3-58] does not
  name; the second is how a test tells the rule from a breakpoint that imitates it. Stated in terms
  of what the columns need rather than of the arrangement, because "where the width admits both"
  is decided by the layout under test and asserts nothing.*

  *This observable replaces one that no longer exists. The arrangement used to go side by side,
  stacked, side by side as the viewport narrowed — which no viewport rule can produce, and which
  was a fine witness while it lasted. It lasted because of the defect [U3-94] fixes: `.boards`
  seated two boards on a row at widths where neither could hold its play area, and the board got
  its width back only once the row gave up on two. With that fixed the arrangement is monotonic in
  viewport width, and a breakpoint could imitate it at one root font-size — hence a witness that
  holds the viewport still instead.*

- **[U3-90]** The pattern lines and the floor MUST precede the wall in document order, in both
  arrangements. *(Side by side that is also the visual order, so reading order follows the eye;
  stacked the two coincide anyway. The [U3-79] controls are in the lines, so a document that led
  with the wall would put the tab order a column behind.)*

- **[U3-91]** A board in the shown configuration MUST render no control: no button, nothing
  focusable, and nothing carrying the roving marker of [U3-53].

  *The six rows are one component taking a nullable control, which is what makes [U3-86] hold by
  construction — and one careless edit away from emitting controls on both boards. That would
  double the universe [U3-79] defines and make [U3-61]'s "no more, no fewer" false; and the group
  is found by first match in document order, so [U3-57] would restore focus to the other player's
  board. It is the shape of [U3-42] and [U3-7]: an old requirement that held only because nothing
  had ever rendered a second one.*

- **[U3-92]** In every arrangement the five pattern lines MUST share a right-hand edge, so a line
  fills toward one edge and its most recently added tile is always in the same place.

  *A requirement of its own rather than a clause of [U3-88], because [U3-88] is pinned to
  1280 × 800 and nothing would otherwise constrain fill direction at 844 — which is exactly where
  the staircase is the only cue left. It says nothing about which edge is nearer the wall: stacked,
  the wall is below rather than beside, and "nearer the wall" has no referent there. That the
  shared edge meets the wall's is [U3-88], at the viewport where there is a wall beside it to
  meet.*

- **[U3-94]** The two boards MUST NOT share a row while either board's play area is stacked. Where
  the width will not seat two boards each wide enough for its lines beside its wall, the boards
  MUST stack instead.

  A prohibition, because the positive form overclaims at the bottom of the range: below the width
  *one* whole board needs, no arrangement keeps a play area together, the boards are stacked
  anyway, and this requirement has nothing left to give. [U3-89] is what applies there.

  *This is a new policy and not a keyword contest, though it is tempting to write it as one. It is
  true that both boards at once is [U3-60] and a `SHOULD` while a level pattern line is [U3-88] and
  a `MUST` — but [U3-88] is pinned to 1280 × 800, so it did not apply anywhere in the band where
  the two compete. At 1231 the requirement that applied was [U3-89], and the old layout satisfied
  it exactly: the columns did not fit, so they wrapped. Nothing was violated. That is why thirteen
  mutation records missed this and a person looking at the page did not — no test was asleep, there
  was no requirement to break.*

  *What was wrong is a judgement the spec had not made: in that band the layout had two
  arrangements available and took the one that is worse on every axis the intent names, to keep a
  `SHOULD`. [U3-94] is where that judgement is written down, and the minimum a board is seated at
  is now the width its play area needs rather than a round number.*

  *[U3-88] and [U3-94] together are the whole of levelness: [U3-94] is the general rule — a board
  is never seated at a width that breaks its play area — and [U3-88] is the anchored instance that
  makes it decidable at a named viewport. Neither is the story on its own, and [U3-88]'s
  1280 × 800 is not the extent of the guarantee.*

  This is visible at 844 × 390, one of [U3-58]'s two named viewports. The two boards shared a row
  there and both play areas were broken; they stack now and both are whole, so a player scrolls
  past one board to reach the other instead of seeing both at a glance. [U3-58] still holds — it
  asks for no horizontal scroll, and there is none — and [U3-60] names only 1280 × 800, where the
  two boards still share a row. The trade is deliberate and is the one this requirement makes.

  It also puts [U3-60] within reach of the root font-size at that viewport, which it was not
  before. `--board-width` grows with `--tile`, so two boards stop fitting 1280 once the root passes
  about 16.6px: measured, they share a row at 16.5px and stack at 17px. Before this the minimum was
  20rem and two boards needed 692px of 1254 at a 17px root, which never came close. [U3-60] is a
  `SHOULD` and exempt from traceability, so nothing will report this — but a player whose browser
  defaults to 17px will see the boards stop sitting side by side on a laptop, and the reason should
  be findable when they say so.

#### Three things this does not reach

Recorded rather than narrowed, in the manner of *Scope* above.

*Intent 0005* asks that the two boards be the same height as each other at every point in the
game. [U3-86] does not give that. A play area contains the floor line's sentence, whose numbers
are the two players' own — "0 of 7 slots, penalty 0" against "10 of 7 slots, penalty -14 (plus 3
beyond the last slot, costing nothing)" — and at a narrow board width the longer one wraps and the
shorter does not. [U3-87] keeps that from ever being a difference in *wording*; it cannot keep it
from being a difference in numbers. It is reachable — reserve the sentence a fixed height, or move
it out of the play area — but both change what the board shows in order to fix what it measures,
and neither is asked for here.

It also asks that taking a turn move nothing on the page except the tiles that moved. The score
delta of [U3-43] is outside the play area, appears on a transition ply, and is as wide as its
number, so a board's header is a size the game moves. Both residues are small, both are visible
only where a board is narrow, and neither is the defect the intent was written about.

The third is [U3-94]'s own price, and it is vertical. Below 1232 the boards stack, so on a short
landscape viewport — 844 × 390 among them — the second board is a scroll away rather than beside
the first. [U3-58] is about horizontal scroll and holds; [U3-60] names only 1280 × 800; the intent
says nothing about vertical scrolling either way. It is recorded because it is the visible cost of
[U3-94] rather than an oversight, and because the alternative was two boards neither of which could
be read.

## Invariants

[U3-61] holds at rest; [U3-62] holds whenever a selection is active; [U3-63] holds after every
publish; the rest hold after every ply. All are asserted directly by the tests in *Verification*.

- **[U3-61]** At rest, the set of available selection controls equals
  `{ (source, colour) : ∃ d ∈ 0..5 . encodeAction(source, colour, d) ∈ game.legalActions }`, over
  the rendered universe of [U3-79] with `source ∈ 0..5` and `colour ∈ 0..4` ([0001 E1-6]) — no
  more, no fewer. In a terminal position `legalActions` is empty ([0001 E1-11]) and so is this
  set, which is [U3-47].
- **[U3-62]** With a selection `(s, c)` active, the available destination controls encode exactly
  `{ a ∈ game.legalActions : decodeAction(a) = [s, c, d] for some d ∈ 0..5 }`.

  *Two invariants rather than one, and each with its own moment, because a two-step turn never has
  all 180 destinations on screen at once: at rest the controls are pairs, which are not actions,
  and under a selection they are a strict subset of the legal set. A single "enabled controls
  equal `legalActions`" would be false in every position — and filing [U3-62] as a per-ply
  invariant would make it vacuous, since [U3-64] says no selection is active then.*

- **[U3-63]** After every publish, the opening one included, the published `game` deep-equals
  `toJSON` of the held state.
- **[U3-64]** No selection is active immediately after a ply.
- **[U3-65]** The held state has only ever been advanced by `apply`, from a position `newGame`
  produced, and `newGame` has been called exactly once for this game ([U3-5], [U3-12]). This is
  the assertable form of "there is no undo" ([U3-17]): the position only ever moves forward.
- **[U3-66]** Nothing has been written to browser storage, and no network request has been made.

## Performance

The intent's bar is "clicking a tile responds immediately". The work behind a ply is one `apply`
plus one `toJSON`, which calls `legalActions` — microseconds against [0001 E1-58], so the budget
is really about the render.

- **[U3-67]** A click or keypress that submits a ply SHOULD reach the next paint within 50 ms on a
  modern laptop. Like [0001 E1-58] and [0001 E1-59] this is a budget, not a correctness gate: a
  regression is a bug to file, not a failing build.

## Verification

The stack is the one Solid v2 prescribes at <https://v2.solidjs.com/guides/testing>: Vitest with
jsdom, `@solidjs/testing-library`, and `@testing-library/jest-dom` — subject to [U3-11] on the
runner version. jsdom has neither a layout engine nor a reload, so [U3-73] adds a second, slower
lane that has both. That lane is expected to run beside the fast suite, not inside [U3-77]'s
budget.

- **[U3-68]** Tests MUST locate **DOM elements** by accessible role and visible text, not by
  internal structure. This is the testing guide's own rule, and it is what turns [U3-52],
  [U3-53], [U3-54], [U3-55], [U3-56] and [U3-57] from aspirations into assertions: a test that can
  only find a control the way a screen reader would fails when the labelling does. *(It constrains
  how the DOM is queried, not what a test may otherwise inspect — [U3-63], [U3-72] and [U3-74] all
  reach outside it.)*
- **[U3-69]** Writes in Solid v2 are **staged** — a signal read straight after a set returns the
  previous value. A test MUST `flush()` before asserting on the DOM.
- **[U3-70]** The suite MUST include a property test that plays complete games through the
  *rendered* interface, choosing uniformly at random among the available controls, and asserts
  [U3-61] before each selection and [U3-62] after it, against `legalActions` taken from an engine
  state driven in parallel. Both the game seeds and the choice stream MUST come from fixed,
  recorded seeds, and a failure MUST report them: a property failure nobody can reproduce is a
  property failure nobody can fix.

  This is the test that makes [U3-48] and [U3-51] observable: an interface carrying its own copy
  of the rules disagrees here, at the first position where the copy is wrong.

- **[U3-71]** The suite MUST play at least one complete game driven **by keyboard alone**,
  asserting that the game reached a terminal state, that every control it used was reached by
  roving-tabindex navigation ([U3-53]), and that the live region announced each event of [U3-56].
- **[U3-72]** The suite MUST assert [U3-66] by running a game with `localStorage`,
  `sessionStorage`, `indexedDB`, `document.cookie`, `fetch`, `XMLHttpRequest`, `WebSocket` and
  `navigator.sendBeacon` replaced by throwing stubs — the way [0002 V2-31] treats [0001 E1-50].
  "No persistence" and "no network" are behaviour, and behaviour is testable.
- **[U3-73]** The suite MUST check [U3-58], [U3-59], [U3-16], the positional half of [U3-81],
  and [U3-86], [U3-88], [U3-89], [U3-92] and [U3-94], under Vitest browser mode with the Playwright
  provider, which the testing guide names for real-browser needs. Layout requirements need a
  layout engine and a reload requirement needs a reload; excusing them because jsdom has neither
  would excuse nine requirements that came straight from an intent.
- **[U3-74]** The suite MUST assert that `packages/ui`'s `dependencies` are exactly `engine`, `bot`,
  `ai-bot` and the Solid v2 runtime [U3-10], that each workspace package is declared with a
  `workspace:` range, and that the declared `vitest` range satisfies [U3-11]. An allowlist, not a
  judgement about which packages "carry the rules" — adding one is a spec change to [U3-7].
  *(Widened by [0006 W6-28], and again by [0008 A8-33].)*
- **[U3-75]** The suite MUST include a source check over the **TypeScript** in `packages/ui/src`
  — `.ts` and `.tsx` — using the module layout of [U3-78], that fails on: a module-level numeric
  table of length 5, 7 or 25; either penalty ladder; any `%` expression whose right operand is `5`
  or `NUM_COLORS`; and the action multipliers `30` and `6` in arithmetic ([U3-49]); `clone`,
  `structuredClone` or `fromCanonical` followed by `apply` ([U3-50]); `apply` called outside the
  state module ([U3-18]); the state binding imported under `src/components/` ([U3-1]); a read of
  `tilesLeft` in the state module ([U3-40]); and `import(` or an absolute `http(s)` URL in a
  string literal or JSX attribute — comments excepted,
  since [U3-10] sends implementers to the Solid docs by URL ([U3-8]).

  The **stylesheet** MUST additionally be read for the absolute-`http(s)`-URL clause, and for that
  clause alone.

  "The TypeScript in `src`" and not "`src`", because the difference became load-bearing. `.css` was
  always outside the walk and it never mattered until [U3-94] put `7 * var(--tile) + 6 *
  var(--tile-gap)` in the stylesheet — the first engine-derived count in `packages/ui/src`, in the
  one file the check could not see. Widening the walk *whole* is wrong, and measurably so: the
  action-multiplier clause matches the `6 *` there, where the `6` is six gaps between seven tiles,
  so the check would fail on a true statement, and no clause fixes that without teaching it CSS.
  That half is [0001 E1-71]'s lesson — a check whose description outruns its behaviour is the
  defect, and the fix is the sentence.

  The URL clause is the exception because it needs no CSS understanding: an absolute URL means
  there what it means in a string literal, and a stylesheet is the likeliest place in the package
  to write one — `url(https://…)`, `@import`, `@font-face`. None of the three goes through `fetch`,
  so [U3-72]'s throwing stubs never see them; the browser's own loader does the fetching. "No
  network request at runtime" ([U3-8]) is too load-bearing to leave that corner unwatched, and the
  clause MUST be shown to reject all three shapes.

  What covers the counts is not this check but [U3-94]: a stylesheet whose idea of the columns is
  smaller than the components' seats a board at a width it cannot use, and the sweep reports it.
  That holds in the direction that matters and not in the other, which is stated where the records
  are.

  Both `apply` clauses MUST match `applyExplained` too: `/\bapply\s*\(/` does not, so as
  written they silently stopped covering the entry point `submit` takes ([U3-18]). The matcher is
  `/\bapply(?:Explained)?\s*\(/`, and each clause MUST be shown to reject **both** names — a
  clause proven against one alternative is not proven against the other.

  Two of those need their escape hatch named, because the ban is absolute and the workaround is
  not obvious. A flat `[25]` wall is walked with nested `r`/`col` loops over `NUM_ROWS` and
  `NUM_COLORS`, indexing `r * NUM_COLORS + col` ([0001 E1-2]) — never with `%`. And a component
  that needs `game.tilesLeft` for [U3-32] simply displays it; only the state module is barred from
  *reading* it, which is where a transition would be predicted.

  Every clause is a decidable match on source text. Deliberately absent is any check that a bare
  numeric literal "should have been an import": `5` is at once `NUM_COLORS`, `NUM_FACTORIES`,
  `NUM_ROWS`, `CENTER` and `FLOOR`, so such a check would fail a gating build on a `padding: 5`
  and two implementers would resolve it differently. This is a bounded matcher over an enumerated
  set — not a judgement about whether code "contains a rule", which is what [U3-70] is for.

- **[U3-76]** Every requirement in this document — every `MUST` and `SHOULD`, and every `MAY` the
  implementation actually exercises — MUST be either cited by at least one test — by identifier, in the test name or an adjacent comment — or listed with a reason in the
  *Traceability exemptions* table below. A check MUST fail the suite when a requirement is neither
  cited nor exempt, when a test cites an identifier that does not exist, or when the exemption
  table names one that no longer exists. This mirrors [0002 V2-26] and [0002 V2-27], and the third
  case is the one that rots silently.
- **[U3-80]** The suite MAY spy on `newGame` and `apply` to assert [U3-5], [U3-18] and [U3-65].
  This is sanctioned explicitly because those are properties of a *history*, not of a state, and
  no snapshot can show them — the same reason [0002 V2-3] has to name the one thing it permits.
- **[U3-77]** The fast suite SHOULD finish in under 30 seconds on a laptop. Slower than that and
  it stops running on save; the allowance over [0002 V2-28]'s ten is for rendering. The browser
  lane of [U3-73] is excluded.

  *This is a wall-clock budget, so it is only meaningful on an idle machine — and a per-test
  timeout inside it reports contention as failure, which reads as a flaky test rather than as a
  busy box. Both were mistaken for defects here, once in this suite and once in
  [0005 M5-8]'s lane. A whole-game test wants generous headroom for that reason, and a timing
  measurement wants `uptime` read before it is called a finding.*

### Traceability exemptions

Exemptions are for requirements a test cannot observe — [0002 V2-31]'s categories: process
promises, statements about other implementations, implementation-strategy directives, and
non-gating budgets, plus one this document adds and owns: **properties of an artifact the suite
never produces**, which is [U3-9] and nothing else. Difficulty is not a reason, and a `MUST` about
observable behaviour MUST NOT be exempted; build-shaped requirements are covered by [U3-74] and
[U3-75] rather than excused.

| Requirement | Why it is not testable |
| --- | --- |
| [U3-3], [U3-4], [U3-6] | Implementation-strategy directives about where a value comes from. [U3-75] checks the decidable part; the residue is a judgement, and no runtime behaviour distinguishes a conforming implementation from one that computes the same numbers the wrong way. |
| [U3-9] | A property of the build output, not of the running client. The suite runs against source, never against a deployment. |
| [U3-17] | The absence of a feature, unbounded as stated. [U3-65] is the positive surrogate and is asserted. |
| [U3-30] | The absence of any indication anywhere, unbounded as stated. [U3-25] pins the decidable half — a destination submits with no intervening step. |
| [U3-60] | A `SHOULD` about a viewport, decided by looking. |
| [U3-67] | A `SHOULD` budget, declared non-gating above. |
| [U3-68], [U3-69] | Constraints on how the tests themselves are written. The suite cannot test itself; these are enforced in review. |
| [U3-77] | A `SHOULD` about the suite's own runtime. |

Two requirements need a directed test rather than the property test, and are cited there. [U3-44]'s
draw branch is reachable but vanishingly rare under [U3-70]'s random play. [U3-45]'s exhausted
ending is not reachable *at all* through the interface — [0001 E1-37] proves the path cannot occur
in a lawfully dealt game, and [U3-12] denies the interface any way to pose one. Both MUST therefore
be driven from a stubbed view model handed to the components directly. That is a test posing a
*view*, not a state, so it stays clear of [0001 E1-5] and of the prohibition [0002 V2-3] places on
the conformance harness.

## Solid v2

Solid 2.0 is in **release candidate** as of September 2026 — "APIs may change before the stable
release", per <https://v2.solidjs.com>. Much of the widely-indexed Solid material describes v1 and
is the wrong shape here. The differences that reach this spec, from
<https://v2.solidjs.com/migration/from-solid-1>:

- Writes are staged: `setCount(1); count()` returns the previous value. `flush()` commits;
  `latest()` reads in flight. This is the fact [U3-21] and [U3-69] both rest on.
- `Index` is replaced by `<For keyed={false}>`, whose children receive accessors — which is what a
  board of fixed-position cells wants.
- `onMount` is replaced by `onSettled`; `batch` is gone in favour of default batching plus
  `flush()`.
- `createEffect` is two-phase, `createEffect(() => dep(), (value) => {…})`, and the apply phase
  returns its cleanup rather than calling `onCleanup`.
- Imports move both ways: the web runtime is `@solidjs/web` and `jsxImportSource` must point
  there, while stores are exported from `solid-js` itself. `createMutable` is gone; `createStore`
  with draft setters replaces it.

This section is a pointer, not a tutorial. When it and the v2 documentation disagree, the
documentation is right and this section is stale.

## References

- Intent [0002 — Web interface](../intent/0002-web-interface.md)
- Intent [0003 — Computer opponent](../intent/0003-computer-opponent.md)
- Intent [0004 — Scoring explained](../intent/0004-scoring-explained.md) — the two shortfalls
  above, handed on
- Intent [0005 — A board that holds still, and lines beside its wall](../intent/0005-a-board-that-holds-still.md)
  — the layout requirements [U3-86] through [U3-92], and the two residues recorded beside them
- Spec [0001 — Engine core](0001-engine-core.md)
- Spec [0002 — Engine conformance vectors](0002-engine-conformance-vectors.md) — the traceability
  doctrine [U3-76] mirrors, and [0002 V2-31]'s exemption categories
- Solid v2 documentation: <https://v2.solidjs.com>
- Solid v2 testing guide: <https://v2.solidjs.com/guides/testing>
- Solid v2 migration from v1: <https://v2.solidjs.com/migration/from-solid-1>
