---
title: Engine conformance vectors
author: Gabriel Cangussu
date: 2026-09-03
status: draft
intent: 0001 — Rules engine
prefix: V2
depends-on: 0001 — Engine core
summary: >
  How the engine is proven correct: recorded games from the Python reference
  implementation, replayed ply by ply and compared state for state, plus
  handcrafted edge positions and per-ply invariant checks. Defines the vector
  file format, how vectors are generated, and what "passing" means.
---

# Engine conformance vectors

## Scope

Covers the test strategy and fixture format for `packages/engine`: what we compare against, how
the fixtures are produced and stored, and the coverage the suite must reach before the engine is
considered done.

Does not cover the rules themselves — every rule under test is a numbered requirement in *0001 —
Engine core*, and this document only says how each is checked.

## Why replay, not reimplementation-by-eye

The rules of Azul are easy to state and easy to get subtly wrong: adjacency scoring when a tile
joins two runs at once, the marker occupying a floor slot, the score floor at zero, what happens
when the bag runs out mid-deal. Reading the printed rules twice does not catch these; a second
implementation that already plays thousands of games does.

We therefore treat [ludometer](https://github.com/RemiFabre/ludometer)'s Python engine as the
oracle, and check agreement mechanically: same starting position, same moves, same state after
every single ply — not just the same final score, which can agree by accident after two
cancelling errors.

- **[V2-1]** Agreement MUST be checked per ply, not per game. A vector whose final scores match
  but whose intermediate states differ is a failure.

## The seed problem

Both engines are deterministic, but they are not deterministic *the same way*: ludometer draws
from Python's Mersenne Twister and the port uses its own PRNG ([0001 E1-46], [0001 E1-49]). Seed 7
means two different bags.

- **[V2-2]** Vectors MUST therefore carry the tile order itself, not the seed that produced it.
  The recorded seed is provenance only, never an input to the replay.
- **[V2-3]** The harness MUST feed that order in through the shuffle seam ([0001 E1-61]), and
  MUST NOT edit state fields directly, even though [0001 E1-5] permits that elsewhere: a fixture
  assembled by poking fields tests the poking, and anything the harness can only reach that way
  is a gap in the engine's own surface.
- **[V2-36]** How a replay *starts* depends on the vector kind, and the two are not
  interchangeable — the shuffle indices differ:
  - `kind: "game"` MUST start with `newGame(seed, shuffle)`. The creation shuffle is index 0, so
    `shuffles[0]` is the opening bag order and `initial` is **compared** against the state
    `newGame` returns, not loaded into it. That comparison is itself the test of [0001 E1-65].
  - `kind: "position"` MUST start with `fromCanonical(initial, seed, shuffle)`, which does not
    shuffle ([0001 E1-61]), so `shuffles[0]` is the first lid recycle after the load and
    `initial` is loaded rather than compared.

  Both pass the seam in the constructing call. Getting this backwards is not a subtle failure: a
  game vector loaded with `fromCanonical` never consumes index 0, so its first recycle asks for
  an index one past where the file put it.

## Vector format

One JSON file per vector, under `packages/engine/test/vectors/`, named `game-NN.json` or
`position-NN-slug.json`.

```jsonc
{
  "schema": 1,
  "kind": "game",                  // "game" | "position"
  "generator": {
    "repo": "RemiFabre/ludometer",
    "commit": "<40-hex>",          // the oracle's exact revision
    "script": "tools/vectors/dump_vectors.py",
    "pythonSeed": 7,               // provenance only, see [V2-2]
    "policy": "uniform",           // how moves were steered; games only, see [V2-14]
    "generatedAt": "2026-09-03"    // the commit's date, never the clock: [V2-11]
  },
  "note": "…",                     // required for handcrafted positions: what it exercises
  "census": "short",               // only when the fixture holds under 100 tiles, see [V2-35]
  "shuffles": [[0, 3, 4, 1, …], …],// bag contents after each shuffle; last element drawn first
  "initial": { /* canonical state, see below */ },
  "plies": [
    { "action": 47, "legal": [3, 9, 47, …], "state": { /* canonical state after */ } }
  ],
  "final": { "scores": [52, 48], "outcome": 1, "exhausted": false }
}
```

- **[V2-37]** Every field shown above is required except `note` (mandatory for handcrafted
  positions only, [V2-17]), `census` (only when short, [V2-35]), `generator.policy` (games only,
  [V2-14]) and `generator.generatedAt` (optional, [V2-11]). `kind` in particular is
  load-bearing rather than descriptive — [V2-36], [V2-33] and [V2-6] all branch on it — so a
  vector without it is not merely undocumented, it is unreplayable. `schema` is the version of
  this format; a harness MUST refuse a `schema` it does not know rather than guess.
- **[V2-4]** `initial` and every `plies[i].state` MUST be a *complete* canonical state, not a
  digest or a diff. Fixtures are read by humans when a test fails; a mismatching hash tells you
  nothing.
- **[V2-5]** The canonical state is exactly what `toCanonical` produces ([0001 E1-62]): every
  field of the data model — `tilesLeft` and `shufflesUsed` included — with `bag` as an ordered
  colour array, fixed key order, and no derived caches.
  It is deliberately *not* `toJSON`, which hides the bag's order ([0001 E1-52]) and so cannot
  distinguish two positions that will deal differently. Two states compare equal iff their
  canonical forms are deep-equal.
- **[V2-6]** `shuffles[k]` is the bag contents *after* the k-th shuffle, as an array in storage
  order — tiles are drawn from the **end**, so the last element is dealt first ([0001 E1-32]).
  The seam is a `void` callback that reorders the array it is handed ([0001 E1-61]), so the
  harness *writes* a recorded order into the bag in place — it does not return it. It writes
  `shuffles[index]`, using the `index` the engine passes, and MUST NOT keep a cursor of its own:
  the engine owns the position, which is what keeps `clone` independent ([0001 E1-48]) and lets
  the same vector be replayed from a cloned mid-game state. A `kind: "position"` vector has no
  creation shuffle at all — `fromCanonical` does not shuffle — so its `shuffles[0]` is the first
  lid recycle after the position loads. Otherwise shuffles happen at game creation and at each
  lid recycle only ([0001 E1-61]), never on an ordinary refill, so the count is small and exact:
  the harness MUST fail on an `index` past the end of `shuffles`, and MUST fail at the end of a
  replay if the final `shufflesUsed` is less than `shuffles.length`. A vector whose shuffle count
  drifts is reporting a real divergence in when the engine consumes randomness.

  Those two checks bound the count; they do not catch a *skipped* index — calling 0, incrementing
  twice, then calling 2 lands on the same total. What catches that is `shufflesUsed` being a
  canonical field ([V2-5]), compared at every ply, so the double increment fails at the ply it
  happens rather than never. The end checks and the per-ply comparison are one guard in two
  parts; neither is sufficient alone.
- **[V2-7]** `plies[i].legal` is the legal action list in the position *before* the ply, in
  ascending order. Both engines produce ascending order natively ([0001 E1-13]), so the harness
  compares without sorting and a legality bug surfaces at the ply that first exposes it rather
  than at some later divergence.
- **[V2-8]** Files MUST be committed to the repository. The suite MUST run with no network access
  and no Python installed.

## Generating vectors

These recordings do not exist upstream and cannot be copied from it. ludometer validates its
engine with 50 hand-written test functions (57 cases once two are expanded over their seed
parameters) plus self-play fuzz runs; it ships no move-by-move fixtures. Every vector in this repository is therefore *produced* by us,
by driving the oracle and writing down what it does — which is also why the generator script and
its provenance fields matter as much as the vectors themselves.

- **[V2-9]** A single script `tools/vectors/dump_vectors.py` produces every vector. It runs
  against a local ludometer checkout, takes the output directory as an argument, and is the only
  thing permitted to write to `packages/engine/test/vectors/`. Vectors are never hand-edited —
  a wrong vector is a bug in the script or a real disagreement, and editing it by hand hides
  both.
- **[V2-10]** The script MUST patch the oracle's shuffling to record the resulting bag order, and
  MUST read every other recorded value from the oracle — its accessors where they exist, its
  documented state attributes otherwise. The oracle has no canonical-state accessor of its own
  (`to_json` reports the bag as counts, which is exactly the information a vector needs in
  order), so reading attributes directly is expected. What the script MUST NOT do is *compute*
  anything a vector records — no re-deriving scores, legality, or tile totals in Python. A
  fixture must be the oracle's opinion, or it proves nothing.
- **[V2-32]** `shufflesUsed` is the one canonical field the oracle cannot supply — it has no
  shuffle counter, so there is nothing to read. It MUST come from the same patch that records the
  bag orders, counting the calls it intercepts. Counting the script's own interceptions is not
  the kind of computing [V2-10] forbids; inventing the number some other way is.
- **[V2-33]** A `kind: "position"` fixture MUST record `shufflesUsed` as **0** in `initial` and
  rebased by the same offset in every `plies[i].state`, rather than carrying over the shuffles
  the oracle spent reaching the position — however it was reached, whether posed by hand or
  played into from a real game. Rebasing `initial` alone is not enough: `shufflesUsed` is
  compared at every ply ([V2-5]), so an unrebased later ply fails a correct engine just as surely
  as an unrebased first one. A position is normally posed on top of a `new_game` that has already
  shuffled once, so the un-rebased value is at least 1 — and a vector recording 1 makes a
  *correct* engine fail: `fromCanonical` loads 1, the first lid recycle asks for `shuffles[1]`,
  and a one-entry `shuffles` array has no such index ([V2-6]). For `kind: "game"` no rebasing
  applies: `newGame` consumes index 0 ([V2-36]), so the arithmetic already closes.
- **[V2-34]** A vector's `shuffles` array MUST hold exactly the shuffles consumed across the
  plies it records — no more, no fewer. Precisely: `shuffles.length` equals the final
  `shufflesUsed` of the last recorded ply, which for a game vector counts the creation shuffle
  ([V2-36]) and for a rebased position vector starts from zero ([V2-33]). This is what makes
  [V2-6]'s closing check meaningful for a vector that stops early, which every position fixture
  does by design: a recorded order nothing reaches is either a truncation the generator failed to
  trim, or a divergence.
- **[V2-11]** Regenerating MUST be reproducible: same ludometer commit, same seeds, byte-identical
  files. A diff in `git status` after a regeneration means something changed upstream, and that
  is worth reading. Nothing in a vector may therefore depend on *when* it was generated —
  `generator.generatedAt` is the one field that would, so it MUST record the date of the
  ludometer commit rather than the clock, or be omitted. A wall-clock timestamp destroys the very
  signal this requirement exists to produce.
- **[V2-12]** `generator.commit` MUST be recorded. When vectors disagree across ludometer
  revisions, we need to know which revision we agreed with.

## Coverage

### Full games

- **[V2-13]** At least 30 complete games, each from a distinct seed, replayed end to end. The
  number is set by the runtime budget in [V2-28], not inherited from anything upstream: a
  two-player game runs about 70 plies (measured mean 69.9 over 150 random games, min 48, max
  127), so 30 games is roughly 2 100 compared states — comfortably inside a ten-second suite.
  Raise it if the budget allows; the figure is a floor, not a ritual.
- **[V2-14]** Move choice during generation MUST NOT be uniformly random in every game. At least
  a third SHOULD use policies that steer somewhere uniform play rarely goes: always take the
  largest pile, always take from the centre when it is non-empty, never take the marker until
  forced. Each needs a uniform-random fallback for the plies where it has no opinion — the centre
  is empty at the start of every round, so a policy without one has nothing to pick.

  Each game vector MUST record which policy drove it, in `generator.policy` ([V2-37]). Nothing
  else in a vector says how it was steered, so without that field this requirement is one no
  test can observe — and it is a rule about the fixtures, not a process promise, so it does not
  belong among the exemptions.

  Two cautions, both measured. A strict *floor-preferring* policy never fills a pattern line, so
  no tile ever reaches a wall, no row ever completes, and — exhaustion being unreachable
  ([0001 E1-37]) — the game **never ends**: 10 of 10 such games were still running after 2 000
  plies. Use it only with a cap, and only for a position fixture. And uniform play is not the
  weak case it looks: 150 of 150 uniform games ended by row completion in about 70 plies, so
  [V2-15] needs no steering at all. What the steered games buy is unusual *shapes* — heavy
  floors, contested colours, lopsided walls — not termination.
- **[V2-15]** Every game vector ends by wall row completion ([0001 E1-36]) — there is no other
  lawful ending, since exhaustion is unreachable from a full census ([0001 E1-37]). Do not hunt
  for a seed that exhausts the bag; there isn't one. [0001 E1-34] and [0001 E1-37] are covered by the
  short-census position fixture in [V2-16] instead.

### Handcrafted positions

- **[V2-16]** The seven positions below MUST exist, built by hand in the oracle and replayed for
  a few plies each; they cover situations random play reaches rarely or never. More are welcome,
  these are the floor:

  | Position | Exercises |
  | --- | --- |
  | Tile joining a horizontal and a vertical run at once | [0001 E1-24] |
  | Multiple lines resolving top-down, later scoring off earlier | [0001 E1-25] |
  | Floor overfilled past seven slots with the marker held | [0001 E1-20], [0001 E1-26], [0001 E1-27] |
  | Big penalty against a small score | [0001 E1-28] clamping |
  | Bag and lid both empty at refill — **short census**, see [V2-35] | [0001 E1-33], [0001 E1-34], [0001 E1-37] |
  | A round where nobody takes from the centre | [0001 E1-31] |
  | Final position with a full column and a full colour | [0001 E1-38] |

  The floor row needs care: overflow alone never pushes occupancy past seven, because [0001 E1-20]
  sends the surplus straight to the lid. The only route to an eighth slot is taking the *marker*
  onto a floor that already holds seven tiles, so a fixture built by spilling tiles alone
  exercises the cap without ever crossing it.

- **[V2-17]** Every handcrafted vector MUST carry a `note` saying what it is for. A fixture whose
  purpose nobody remembers is one nobody dares to change.
- **[V2-35]** A fixture holding fewer than 100 tiles MUST declare `"census": "short"` and say in
  its `note` why. Only the bag-and-lid-empty position needs it today, and it needs it
  unavoidably: reaching a refill with both empty *requires* a census below 100 ([0001 E1-37]), so
  without the flag the fixture [V2-16] mandates would fail the assertion [V2-18] mandates, and no
  correct engine could pass the suite. The flag narrows the check to invariance; it never
  disables it. A vector without the flag holding fewer than 100 tiles is a generator bug, and the
  harness MUST fail it as one rather than trusting the file.

  Budget more than "a few plies" for this one. [0001 E1-34] (a partial deal) and [0001 E1-37] (no
  deal at all, ending the game) cannot both happen at the same refill, so covering [0001 E1-33],
  [0001 E1-34] and [0001 E1-37] in one fixture takes three round transitions: a recycle, then a
  short deal, then an empty one. It is constructible — a short board stays playable — but it is
  the longest of the seven positions by some margin.

### Properties, checked on every ply of every vector

- **[V2-18]** Tile conservation ([0001 E1-40]) MUST be asserted after every ply of every replay,
  not only at the end — as *invariance*: the census after a ply equals the census before it. For
  every vector but a short-census one ([V2-35]) that census MUST also be `[20,20,20,20,20]`, and
  the harness MUST assert both.
- **[V2-19]** The remaining invariants — [0001 E1-41], [0001 E1-42], [0001 E1-43], [0001 E1-44],
  [0001 E1-45] and [0001 E1-64] — MUST be asserted per ply.
- **[V2-20]** `legalActions()` MUST be cross-checked against brute force — `isLegal` over all 180
  encodings — on every ply of at least one full game per run.
- **[V2-21]** Derived caches ([0001 E1-5]) MUST be checked fresh: after a ply, `recount()` on a
  clone MUST leave the state unchanged.
- **[V2-22]** `clone()` independence MUST be tested: mutating a clone leaves the parent
  untouched, and a clone replays the rest of the game identically ([0001 E1-48]).

### Unit and property tests beyond the vectors

- **[V2-23]** Action encoding round-trips over the full space ([0001 E1-7]).
- **[V2-24]** Randomised self-play — at least 200 games with the engine's own PRNG — MUST finish
  without throwing, with conservation holding and every ply legal by construction. This is fuzz
  coverage, not oracle coverage: it catches crashes and invariant breaks in positions the
  vectors never reach.
- **[V2-25]** The observation vector MUST be checked for length, dtype, and current-player
  relativity. Relativity is tested with `encodeFor` ([0001 E1-67]) on **one fixed position**, not
  by playing a ply — an `apply` also changes the board, so the two vectors differ in the
  factories, the centre, `tilesLeft` and the mover's own pattern lines, and nothing about that is
  a perspective swap.

  `encodeFor(s, 0)` and `encodeFor(s, 1)` MUST mirror each other across exactly the five paired
  regions — `[0,25)`↔`[25,50)`, `[50,80)`↔`[80,110)`, `[110,117)`↔`[117,124)`, `[124]`↔`[125]`,
  `[176,179)`↔`[179,182)`. The shared regions — factories, centre, bag, lid, tiles-left and
  round, being indices 126-173 and 175 — MUST be identical between the two. Index `[174]` MUST NOT be included in either group: it is a
  disjunction with no opposite-seat counterpart ([0001 E1-63]), it is recomputed rather than
  mirrored, and a whole-vector swap assertion fails a correct engine on that index alone.
- **[V2-29]** Its numeric range MUST be checked as [0001 E1-56] actually states it — every value
  finite and `>= 0`, the two clamped fields within `[0, 1]` — and **not** as a blanket
  `<= 1`. Centre counts and scores legitimately exceed 1, so a blanket upper bound would fail a
  correct engine. A test asserting `<= 1` here is itself the bug.
- **[V2-30]** The `[174, 175)` flag MUST have a dedicated test for its disjunction
  ([0001 E1-63]), read through `encodeFor` ([0001 E1-67]) — the harness may not set
  `currentPlayer` to get the other seat ([V2-3]), and does not need to. One fixture covers it,
  read from both seats at two plies. Before the marker is taken, the
  round's starter sees 1 and the other player sees 0 — the flag is 0 exactly for a player who
  neither started the round nor holds the marker, which is also what a non-starter sees once the
  *starter* takes the marker; both routes produce the same pair, so one of them suffices. Then
  the non-starter takes from the centre, and from that ply *both* players see it set — the only
  shape that discriminates. Encoding both perspectives at both plies catches a port that
  implemented the field's misleading name instead of its formula: such a port reports 0 for the
  starter after the marker is gone.

## Traceability

- **[V2-26]** Every requirement in *0001* MUST be either cited by at least one test — by
  identifier, in the test name or an adjacent comment
  (`it("scores both runs when a tile joins two [E1-24]")`) — or listed with a reason in that
  spec's *Traceability exemptions* table. Nothing may be quietly untested: a requirement is
  covered or it is excused in writing.
- **[V2-27]** A check MUST fail the suite when a requirement in *0001* is neither cited nor
  exempt, when a test cites an identifier that does not exist, or when the exemption table names
  an identifier that no longer exists. The third case is the one that rots silently — a
  requirement gets rewritten into something testable and its stale excuse keeps it out of the
  suite forever.
- **[V2-31]** Exemptions are for requirements a test *cannot* observe — process promises,
  statements about other implementations, implementation-strategy directives, non-gating budgets.
  Difficulty is not a reason, and a `MUST` about engine behaviour MUST NOT be exempted, however
  build-shaped it looks: dependencies and forbidden globals are checkable from a test. Adding a
  row to that table is a spec change and gets read like one.

## Running

```bash
pnpm -F engine test              # everything
pnpm -F engine test vectors      # replays only
pnpm -F engine test -t '\[E1-24\]'  # every test citing one requirement
```

The brackets are escaped because `-t` takes a regular expression, not a substring: unescaped,
`[E1-24]` is a character class and matches nearly every test in the suite.

- **[V2-28]** The whole suite SHOULD finish in under 10 seconds on a laptop. It is the thing that
  runs on every save; slow enough to skip is the same as absent.

## Open questions

- Should vectors also be replayed *backwards* — reconstructing each prior state from the next —
  once the undo question in *0001* is settled?
- Once the suite exists and [V2-28] can be measured rather than guessed at, does the game count
  in [V2-13] go up? The floor is set by the budget, so the honest answer needs a stopwatch.
- Do we vendor a pinned copy of the ludometer engine into `tools/` so vectors can be regenerated
  without a separate checkout, at the cost of carrying someone else's code in the repo?

## References

- Intent [0001 — Rules engine](../intent/0001-rules-engine.md)
- Spec [0001 — Engine core](0001-engine-core.md)
- Oracle: [`ludometer/azul/engine.py`](https://github.com/RemiFabre/ludometer/blob/main/ludometer/azul/engine.py)
  and its suite [`tests/test_engine.py`](https://github.com/RemiFabre/ludometer/blob/main/tests/test_engine.py)
