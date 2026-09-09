---
title: Scoring explained
author: Gabriel Cangussu
date: 2026-09-08
status: draft
intent: 0004 — Scoring explained
prefix: S7
depends-on: 0001 — Engine core, 0003 — Web interface
summary: >
  How the engine reports the way it scored a round: a second entry point beside
  `apply` that returns the round's workings, the record it returns, and the
  invariants that keep the record and the score from disagreeing. Amends 0001 —
  Engine core and 0003 — Web interface, which recorded this gap as a shortfall.
---

# Scoring explained

## Scope

Covers `packages/engine`: a second entry point beside `apply`, the record it returns, where in
round resolution each field is captured, and how the record is proven to agree with the score.

Does not cover the rules themselves (*0001 — Engine core*, unchanged), how the workings are
rendered, or how long they stay on screen. The interface's side is enumerated in *Amendments to
0003* below and declared in `spec/0003-web-interface.md`.

**Every requirement in this document is an engine requirement.** That is a constraint, not a
preference: the traceability check binds one spec and one prefix to one package's test tree
(`packages/engine/test/traceability.test.ts`), so a spec whose prefix spanned two packages would
fail both scanners — each demanding coverage of the other's requirements. The interface's new
requirements therefore take the next free numbers in 0003 ([0003 U3-82] onward), following the
precedent 0006 set by amending 0003 wholesale from its own file. 0006 promised [0003 U3-82] and
declared none — every one of its rows is a widening — so the number is still free, and [S7-38]
is what stops this document making the same promise twice.

### What 0003 said it could not do

0003 recorded two shortfalls against intent 0002 and handed both here:

> **Scoring legibility.** […] Producing a per-tile figure means re-deriving [0001 E1-24] in the
> interface, because `apply` resolves a round atomically and reports no breakdown […]
>
> **End-of-game bonuses.** […] on the terminal ply `endRound` clamps the round score at zero
> ([0001 E1-28]) and `finishGame` then adds unclamped bonuses, so a single observed delta is
> `max(0, score + tiling + penalty) − score + bonus` and the clamp destroys the split
> irrecoverably.

Both are closed by this spec, and neither is closed in the interface: the points exist only inside
round resolution, so the engine reports how it scored, not only how much.

### The organising rule

0003's rule is *the interface contains no rule*; 0006's is *the interface contains no strategy*.
This spec's is narrower and aimed at the engine: **the score is what the record says it is.** The
record is not derived from the scoring, checked against the scoring, or reconciled with the
scoring. It is written by the scoring loop as it charges, from the same accumulator, so there is
no second arithmetic that could drift. [S7-23] states this as an invariant and [S7-28] tests it.

## Definitions

Terms from *0001* — wall, pattern line, floor line, marker, ply, round, resolution order — carry
their meaning there unchanged. Added here:

| Term | Meaning |
| --- | --- |
| **Round resolution** | Everything `endRound` does on the ply that empties the board ([0001 E1-22] through [0001 E1-37]). |
| **The record** | One `RoundScoring`: what a single round resolution charged, per player. |
| **The explained path** | A call that reaches round resolution through `applyExplained`. |
| **Charged** | Added to the round's accumulator, before the clamp of [0001 E1-28]. |
| **Forgiven** | The part of a charge the clamp did not take, because the score reached zero. |
| **Rung** | One slot's entry in `FLOOR_PENALTIES`; the ladder is charged by slot, never by tile. |

## Data model

Plain, structurally cloneable, and deeply read-only to its caller. No field is a class instance,
a function, or a reference into engine state.

```ts
/** What one tile earned when it was placed. */
interface Placement {
  /** Pattern-line row, `0..4`; also the wall row [0001 E1-22]. */
  row: number;
  /** Wall column, `0..4` [0001 E1-1]. */
  col: number;
  /** Horizontal run through the new tile, itself included [0001 E1-24]. */
  h: number;
  /** Vertical run through the new tile, itself included. */
  v: number;
  /** What was charged: `placementValue(wall, row, col)` [0001 E1-68]. */
  points: number;
}

/** What the floor line cost, by slot [0001 E1-26], [0001 E1-27]. */
interface FloorCharge {
  /** `floorOccupied` at the moment of charging. MAY exceed `FLOOR_SLOTS`. */
  occupied: number;
  /** The rungs charged: the first `min(occupied, FLOOR_SLOTS)` of `FLOOR_PENALTIES`. */
  rungs: readonly number[];
  /** Did this player hold the marker. Captured before [0001 E1-30] clears it. */
  markerHeld: boolean;
  /** The (non-positive) number charged: `CUM_PENALTY[min(FLOOR_SLOTS, occupied)]`. */
  penalty: number;
}

/** One player's round. */
interface PlayerRound {
  /** In resolution order, rows `0..4` [0001 E1-22], [0001 E1-25]. */
  placements: readonly Placement[];
  /** The accumulator's value: what wall-tiling charged. */
  tiling: number;
  floor: FloorCharge;
  scoreBefore: number;
  /** The score after the clamp of [0001 E1-28], before any bonus. */
  scoreAfterRound: number;
  /** `>= 0`; what the clamp did not take. */
  forgiven: number;
}

/** One player's end-of-game bonuses [0001 E1-38]. Present only on the terminal ply. */
interface PlayerBonuses {
  rows: number;
  cols: number;
  colors: number;
  rowPoints: number;
  colPoints: number;
  colorPoints: number;
  /** `rowPoints + colPoints + colorPoints`, charged unclamped. */
  total: number;
  /** Equal to this player's `scoreAfterRound` [S7-26]. */
  scoreBefore: number;
  /** The final score. Nothing is added after this. */
  scoreAfter: number;
}

/** One round resolution. */
interface RoundScoring {
  /** The index of the round that just ended, captured on entry [S7-13]. */
  round: number;
  /** By seat, `[player 0, player 1]`. */
  players: readonly [PlayerRound, PlayerRound];
  /** Non-`null` if and only if the game ended on this ply [S7-20]. */
  bonuses: readonly [PlayerBonuses, PlayerBonuses] | null;
}
```

### Fields that are deliberately absent

A field derivable from another field in the same record is a second copy of a rule and is
forbidden by [S7-21]. Three that a reader may expect, and where to get them:

| Absent | Where it comes from |
| --- | --- |
| A placement's colour | `wallColorAt(row, col)` — the wall's colour pattern is fixed by [0001 E1-1] and the function is already exported. |
| "This tile landed alone" | `h === 1 && v === 1`. |
| "The game ended on this ply" | `bonuses !== null`. |

`occupied` beside `rungs` is not an instance of this and is required by [S7-16]: `floorOccupied`
may exceed `FLOOR_SLOTS`, and `occupied > rungs.length` is exactly [0001 E1-27] — slots past the
seventh cost nothing. The pair carries a rule; it does not restate one.

`points`, `tiling` and `penalty` are likewise not derived. Each is the value the scoring
accumulator actually charged, recorded where it was charged. That is the whole mechanism of
[S7-23], and computing any of them from its neighbours instead would be the second arithmetic this
spec exists to prevent.

## Behaviour

### The seam

- **[S7-1]** The engine MUST export a second entry point:

  ```ts
  function applyExplained(s: AzulState, action: number): RoundScoring | null;
  ```

  It MUST advance `s` exactly as `apply` does, and MUST return the record of the round resolution
  the ply performed, or `null` when the ply performed none.

- **[S7-2]** `apply`'s signature MUST NOT change, and `apply` MUST NOT return a record. The
  conformance vectors of *0002*, the bot, and every recorded game drive `apply`; none of them
  moves.

- **[S7-3]** Both entry points MUST delegate to a single internal implementation carrying an
  optional sink. There MUST NOT be two implementations of a ply, of round resolution, or of any
  rule either performs. `tiling` and `points` MUST therefore be the accumulator's own values,
  recorded where they were charged, and MUST NOT be summed or recomputed afterwards.

  *A private out-parameter, on a private function. The public surface does not have one, because
  the record holds variable-length placement arrays and a caller cannot size a buffer before it
  knows whether the ply ends a round at all — returning a fresh record is the only honest public
  shape. Inside, the sink is what makes [S7-3] and [S7-4] hold at once.*

- **[S7-4]** On a ply that does not end a round, `applyExplained` MUST NOT allocate, and `apply`
  MUST cost no more than it does today. The sink reaches round resolution only, which `apply`
  enters only when `tilesLeft` reaches zero, so an ordinary ply carries one unused argument and
  branches on nothing. `placementRuns` allocates and MUST NOT be reached from the unexplained path
  at all.

- **[S7-5]** An out-of-range or illegal action MUST throw and leave `s` untouched, exactly as
  [0001 E1-14], and MUST NOT return a partial record.

- **[S7-6]** Nothing MUST be added to `CanonicalState`, to `AzulState`, or to `AzulJSON`. A record
  is an event, not a position: it is not part of a snapshot ([0001 E1-62]), it is not restored by
  `fromCanonical`, and it does not cross the worker boundary.

- **[S7-7]** The engine MUST NOT retain a record. Nothing in `packages/engine` may hold, cache, or
  re-serve the last one; the caller owns what it is handed.

  *Which is what keeps two canonically equal states behaving identically. A record held on the
  state would need a flag to gate its cost, and a flag on the state is a mode: two positions equal
  under [0001 E1-62] would then take different paths, and the difference would be invisible to
  every test that compares states.*

- **[S7-8]** A returned record MUST be safe to retain indefinitely. It MUST share no mutable
  container with `s`, so a caller holding one across later plies sees what that round charged and
  not what the board later became.

### What the record says

- **[S7-9]** `placements` MUST list every tile the resolution moved from a full pattern line to the
  wall, in resolution order, rows `0..4` ([0001 E1-22], [0001 E1-25]). A row that did not complete
  contributes nothing.

- **[S7-10]** `points` MUST be the value `placementValue` returned for that placement — the same
  call whose result was charged. It MUST NOT be recomputed from `h` and `v`.

- **[S7-11]** `h` and `v` MUST be the real runs through the placed tile, and MUST come from a
  private `placementRuns` helper standing on the same two run scans `placementValue` stands on.
  Behavioural, and witnessed by the record: [S7-30]'s corpus is where it is checked.

- **[S7-12]** The fusion rule of [0001 E1-24] MUST have exactly one implementation, and it MUST
  remain `placementValue`'s. A source property, enforced by [0001 E1-71]'s widened check and seen
  to fail per [S7-35].

  *Split from [S7-11] because the enforcement differs, and because one requirement naming a private
  helper invites a later reader to exempt the whole thing as unobservable — half of it is
  observable, since the record carries the runs. This half is where the design nearly went wrong. A
  "recording sibling" of `placementValue` that combined the runs itself would write the fusion rule
  twice, and the check that names the rule — the delegation assertion in
  `packages/engine/test/purity.test.ts`, which asserts that `round.ts` calls `placementValue` and,
  by its own comment, nothing else — would keep passing from the unexplained branch while the
  explained branch drifted. [0001 E1-71] closes it.*

- **[S7-13]** `round` MUST be the index of the round whose board just emptied, captured on entry to
  round resolution, before anything mutates.

  *Captured at the end it would be wrong on two of three exits and inconsistent between them: the
  increment sits after the row-completion path's early return but before the exhaustion path's
  finish, so a record read afterwards would disagree with itself about which round it describes.
  On entry, `roundIndex` is that index on all three exits, and [0001 E1-35] — it counts
  transitions, not deals — keeps the reading stable.*

- **[S7-14]** `markerHeld` and `occupied` MUST be captured inside round resolution at the moment
  the penalty is charged: after the floor is read, before the floor is cleared and before the
  marker handoff of [0001 E1-30]. A record filled after resolution would report an empty floor and
  no marker for every player.

- **[S7-15]** `penalty` MUST be the number charged, `CUM_PENALTY[min(FLOOR_SLOTS, occupied)]`, and
  MUST be non-positive.

- **[S7-16]** `rungs` MUST be the first `min(occupied, FLOOR_SLOTS)` entries of `FLOOR_PENALTIES`,
  in ladder order. It MUST NOT attribute a rung to a tile or to the marker: the floor is a
  per-colour count and a marker flag ([0001 E1-3]), with no order to attribute by.

- **[S7-17]** `forgiven` MUST be a property of the round, not of the floor: the clamp of
  [0001 E1-28] applies to tiling and penalty together. It MUST be `>= 0`, and `0` whenever the
  clamp did not bite.

- **[S7-18]** `scoreBefore` MUST be the player's score as round resolution found it, and
  `scoreAfterRound` the score after the clamp and before any bonus.

- **[S7-19]** `bonuses` MUST carry each count, the points that count earned, and their total. The
  count-to-points arithmetic is [0001 E1-38] and MUST NOT be left to the caller.

- **[S7-20]** `bonuses` MUST be non-`null` if and only if the game ended on this ply, by either
  route — a completed row ([0001 E1-36]) or exhaustion ([0001 E1-37]). Both routes finish inside
  round resolution, so a terminal ply MUST produce exactly one record carrying both halves.

- **[S7-21]** The record MUST NOT carry a field derivable from another field in the same record.
  The three a reader may expect are listed in *Fields that are deliberately absent* above.

- **[S7-22]** `bonuses[p].scoreBefore` and `bonuses[p].scoreAfter` MUST both be present, so the
  final score is read and never added. The clamped round score and the unclamped bonus are the
  split [0003's *Two places this knowingly falls short*] called irrecoverable; handing back only
  one of them would put the addition in the interface, on the one ply this work exists for.

## Interfaces

Added to the `## Interfaces` listing of *0001 — Engine core*, which carries no identifier of
its own, beside `apply`:

```ts
// actions
function applyExplained(                              // mutates; throws on illegal
  s: AzulState,
  action: number,
): RoundScoring | null;                               // null unless the ply ended a round
```

Exported types: `RoundScoring`, `PlayerRound`, `PlayerBonuses`, `Placement`, `FloorCharge`.

`placementRuns` is **not** exported. [S7-11] needs it inside round resolution and nothing asks
what a hypothetical placement's runs would be; an export for a caller that does not exist is a
guess about the future on a surface [0001 E1-51] pins. The record's `h` and `v` are its only
witness, which makes [S7-11] a behavioural check rather than a source one.

## Invariants

True of every record, and each one directly assertable:

- **[S7-23]** `players[p].tiling === sum(players[p].placements[].points)`.
- **[S7-24]** `players[p].floor.penalty === sum(players[p].floor.rungs)`.
- **[S7-25]** `players[p].scoreAfterRound === players[p].scoreBefore + tiling + penalty +
  forgiven`, and `scoreAfterRound === max(0, scoreBefore + tiling + penalty)`.
- **[S7-26]** When `bonuses !== null`, `bonuses[p].scoreBefore === players[p].scoreAfterRound`, and
  `bonuses[p].scoreAfter === bonuses[p].scoreBefore + bonuses[p].total`.
- **[S7-27]** After `applyExplained` returns, each player's score in `s` equals
  `bonuses[p].scoreAfter` when the game ended, and `players[p].scoreAfterRound` otherwise. The
  record accounts for the whole score change, with nothing left over.

## Verification

- **[S7-28]** The suite MUST assert that `apply` and `applyExplained` are indistinguishable as
  state transitions: for a position and a legal action, both MUST leave states equal under
  `toCanonical` ([0001 E1-62]). As a property, over seeded random play, with seeds recorded and
  reported on failure.

  *This is the [0001 E1-68]-shaped hazard one level up. `applyExplained` adds a caller to round
  resolution and to `tileWall`, and every existing test of either drives `apply` — the exact
  configuration CLAUDE.md names. Without this the explained path could diverge from the rules under
  a green build.*

- **[S7-29]** The conformance vectors of *0002* MUST be replayed a second time through
  `applyExplained`, asserting the same states the `apply` replay asserts. The oracle is not
  re-derived; the same fixtures are driven twice.

- **[S7-30]** The suite MUST assert [S7-23], [S7-24], [S7-25], [S7-26] and [S7-27] over every round
  of a corpus of complete games, including at least one game reaching the clamp of [0001 E1-28]
  with `forgiven > 0`, at least one ending on a completed row, at least one ending exhausted
  ([0001 E1-37]), and at least one placement scoring alone (`h === 1 && v === 1`).

  *The lone tile is not padding in that list. It is the only position where [S7-10]'s two readings
  differ: `placementValue` returns 1 where `h + v` returns 2 ([0001 E1-24]). Without it [S7-10] is
  stated and never exercised, and [S7-31] has no mutation to point at for [S7-23].*

- **[S7-31]** Each of [S7-23], [S7-24], [S7-25], [S7-26] and [S7-27] MUST have been seen to fail. A
  mutation that breaks the arithmetic it names — a sign flipped, a clamp removed, a bonus added
  twice — MUST fail that assertion and no other, and the mutation MUST be recorded beside the
  test.

  *The rule CLAUDE.md was written to record. A reconciliation test that echoes the accumulator back
  at itself passes every one of these while explaining nothing; only a mutation shows the
  difference.*

- **[S7-32]** The suite MUST assert [S7-13] on all three exits from round resolution — an ordinary
  round, a row completion, and exhaustion — checking the recorded index against the round that
  ended and not the one that follows.

- **[S7-33]** The suite MUST assert [S7-14] by scoring a round in which a player holds the marker
  and has a non-empty floor, and checking `markerHeld` and `occupied` against the position as round
  resolution found it.

- **[S7-34]** The suite MUST assert [S7-8] by retaining a record across later plies and checking it
  is unchanged, and [S7-6] by checking that `toCanonical`, `toJSON` and `fromCanonical` round-trip
  a position that has just produced one, unchanged.

- **[S7-35]** The delegation check of [0001 E1-68] MUST be widened per [0001 E1-71] so that a second
  implementation of the fusion rule fails it. The widened check MUST have been seen to fail against
  a sibling that combines the runs itself.

- **[S7-36]** The suite MUST assert [S7-21] by comparing each record type's key set —
  `Object.keys(...).sort()` — against the declared list in *Data model*. Restoring a deleted
  derivable field MUST fail it, and MUST fail nothing else.

  *Which is why [S7-21] is not exempt. Asserting a key set, rather than the absence of a list of
  names, catches the field added later under a name this document never anticipated — the exact
  case an absence test would miss.*

- **[S7-37]** The suite MUST assert the first clause of [S7-2] by checking that `apply` returns
  `undefined` on a ply that ends a round. It is the clause the whole no-cost argument rests on.

- **[S7-38]** The suite MUST assert [S7-42] and [S7-43] by reading `spec/0001-engine-core.md` and
  `spec/0003-web-interface.md` and checking that each amendment this document requires has landed:
  that 0001 declares [0001 E1-71] and lists `applyExplained` in its `## Interfaces`, and that 0003
  declares [0003 U3-82], [0003 U3-83], [0003 U3-84] and [0003 U3-85].

  *A process promise is usually exempt, and these two are not, because the promise is about a file
  in this repository and a test can read it. 0006 promised [0003 U3-82] and never declared it; a
  check of this shape would have caught that the day it shipped.*

- **[S7-39]** Every requirement in this document MUST be either cited by at least one test, by
  identifier, or listed with a reason in the *Traceability exemptions* table, enforced exactly as
  [0002 V2-26], [0002 V2-27] and [0002 V2-31] enforce it for *0001*, by a scanner over
  `packages/engine/test`.

### Traceability exemptions

| Requirement | Why it is not testable |
| --- | --- |
| [S7-2], second clause only | That no *future* spec gives `apply` a return value is a process promise a test cannot observe. The first clause has teeth and is not exempt: [S7-37] asserts `apply` returns `undefined`, which is what the whole no-cost argument rests on. |
| [S7-3] | "Exactly one implementation", and the accumulator clause folded into it, are source properties: no observation distinguishes an accumulator from a sum over the same numbers, which is what [S7-23] asserts are equal. [S7-28] and [S7-29] catch a divergence in what the two paths *do*; [0001 E1-71] covers the one rule where a second copy is plausible. |
| [S7-4] | A budget, plus a claim about a private function nothing can spy on. Measured by [S7-40], which does not gate the build. |
| [S7-40], [S7-41] | Budgets and the protocol for reading them, explicitly non-gating above — the same ground [0001 E1-58] and [0001 E1-59] stand on. The benchmark suite measures them; it does not fail the build, and "investigate before it lands" is a promise about people, not an assertion. |

## Performance

- **[S7-40]** `pnpm -F engine bench` and `pnpm -F bot bench` MUST be run before and after. Each
  MUST be run repeatedly; the first three runs of a session MUST be discarded, and the comparison
  MUST be between medians of the settled runs, never between single runs. Non-gating, for the
  reason [0001 E1-58] is non-gating.

- **[S7-41]** A regression on the unexplained path larger than the measured noise floor MUST be
  investigated before the work lands. Below that floor the benchmark decides nothing, and [S7-4]
  rests on its structural argument instead: the sink is a parameter of round resolution, which
  `apply` enters only when `tilesLeft` reaches zero.

  *This is weaker than the requirement it replaces, and deliberately. The baseline was measured on
  this machine before any implementation existed, and the instrument turned out to be coarser than
  the effect it was aimed at.*

  *The engine's own `apply` benchmark warms up: the first three runs of a session climb about 11%
  and only then settle, after which run-to-run spread is 2.5% over nine runs. Compare a cold run
  against a warm one — which "run it before, run it after" invites — and roughly 11% of apparent
  change is the measurement protocol. The bot's four benchmarks are coarser still, 9% to 14% spread
  across runs, and drift downward under sustained repetition in a way consistent with thermal
  throttling.*

  *So the honest statement of what these benchmarks can do: they rule out a gross regression. They
  cannot confirm the cost predicted by [S7-4], because a spare unused argument on a path the sink
  never reaches is far below a 2.5% floor, and nothing available here can see it. A benchmark that
  says "no change" is reporting the resolution of the instrument, not the absence of a cost.*

## Amendments to 0001

Each row is an edit to `spec/0001-engine-core.md`. Identifiers there are append-only, so a widened
requirement is edited in place and a genuinely new one takes the next free number ([0001 E1-71]).

| 0001 requirement | Amendment |
| --- | --- |
| `## Interfaces` | Add `applyExplained` to the listing and the five record types to the exported types. `placementRuns` is private and is not listed. |
| [0001 E1-21] | Widen: a ply may also be played by `applyExplained`, which performs the identical transition and additionally reports it. The requirement's subject — what a ply *is* — is unchanged. |
| [0001 E1-14] | Unchanged, and extended by [S7-5]: `applyExplained` throws on the same inputs and returns nothing on the throwing path. |
| [0001 E1-62] | Unchanged and now load-bearing: it is what [S7-6] and [S7-28] both stand on. |
| [0001 E1-68] | Widen: `placementValue` remains the one implementation of [0001 E1-24] and remains allocation-free. A private `placementRuns` is added beside it, exposing the two runs without restating the fusion rule, and reached only from the explained path. |
| *(new)* [0001 E1-71] | The delegation check of [0001 E1-68] MUST additionally fail on a second implementation of [0001 E1-24]'s fusion rule anywhere in `packages/engine/src`. The existing check asserts only that `round.ts` calls `placementValue`, which a divergent sibling would not disturb. Declared in 0001, where the E1 scanner reads it. |

- **[S7-42]** These amendments MUST land in `spec/0001-engine-core.md` in the same change as the
  code that needs them.

## Amendments to 0003

Each row is an edit to `spec/0003-web-interface.md`. New requirements take the next free numbers,
[0003 U3-82] onward.

| 0003 requirement | Amendment |
| --- | --- |
| [0003 U3-6] | Extend the view model with the sticky slot of [0003 U3-82]. |
| [0003 U3-18] | Widen: `applyExplained` is also the state module's alone, and is the path `submit` takes. `submit` stays synchronous and stays the single path. |
| [0003 U3-42] | Unchanged. The sticky slot is a *different* lifetime in the same struct — `transition` is null on every non-transition ply, the workings persist — and the two must not be conflated. |
| [0003 U3-46] | Extend: the end-of-game screen itemises what each count earned, from the record's bonus half. The interface still performs no bonus arithmetic. |
| [0003 U3-75] | Amend the source check: `/\bapply\s*\(/` does not match `applyExplained(`, so both the [0003 U3-18] clause and the clone-then-apply clause silently stop covering the new entry point. Widen both to `/\bapply(?:Explained)?\s*\(/`. |
| *Two places this knowingly falls short of intent 0002* | Rewrite. Both shortfalls are closed; the section becomes a record of what was narrowed and when it was reopened, not a statement of what cannot be done. |

New in 0003:

| New requirement | What it says |
| --- | --- |
| [0003 U3-82] | The view model carries the most recent `RoundScoring`, or `null`. Unlike `transition` it persists across plies, sourced from module state the way `seed` and `lastChoice` are, and is replaced only by a later record. |
| [0003 U3-83] | Dealing a game clears it, beside the existing resets of `previous`, `thinking` and `lastChoice`. Without this a new game shows the previous game's workings until its first round scores — which the sticky lifetime makes minutes, not a frame, and which no single-game test can see. |
| [0003 U3-84] | The workings are rendered from the record and from nothing else: no arithmetic on the record's fields, no diff of two positions, no second source. |
| [0003 U3-85] | The floor penalty is shown as the ladder of charged rungs with the marker called out, per [S7-16]. Never per tile. |

- **[S7-43]** These amendments MUST land in `spec/0003-web-interface.md` in the same change as the
  code that needs them. A spec that says a thing is impossible, after it has been done, is worse
  than no spec.

## Open questions

- **Should a record be reachable for a round already past?** [S7-7] says the engine keeps nothing
  and [0003 U3-82] keeps exactly one, so the answer today is no. Intent 0004 asks the question and
  a scoresheet is the natural answer; it needs a place to accumulate and a surface to browse, and
  both are larger than this. The record is already a value safe to keep ([S7-8]), so nothing here
  forecloses it.

- **Should the record say what a floor tile's colour was?** It does not: the floor is a per-colour
  count, so the colours are knowable but the arrangement is not, and [S7-16] refuses to invent one.
  Showing which colours were discarded is possible and is not asked for.

## References

- Intent [0004 — Scoring explained](../intent/0004-scoring-explained.md)
- Spec [0001 — Engine core](0001-engine-core.md)
- Spec [0002 — Engine conformance vectors](0002-engine-conformance-vectors.md)
- Spec [0003 — Web interface](0003-web-interface.md)
