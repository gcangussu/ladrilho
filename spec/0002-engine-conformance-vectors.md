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
from Python's Mersenne Twister and the port uses its own PRNG ([0001 E1-46], [E1-49]). Seed 7
means two different bags.

- **[V2-2]** Vectors MUST therefore carry the tile order itself, not the seed that produced it.
  The recorded seed is provenance only, never an input to the replay.
- **[V2-3]** The harness MUST feed that order in through the shuffle seam ([0001 E1-61]) and MUST
  NOT reach into engine internals to place tiles. Anything the harness can only test by editing
  private state is a gap in the engine's own surface.

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
    "generatedAt": "2026-09-03"
  },
  "note": "…",                     // required for handcrafted positions: what it exercises
  "shuffles": [[0, 3, 4, 1, …], …],// bag order after each shuffle, in order of use
  "initial": { /* canonical state, see below */ },
  "plies": [
    { "action": 47, "legal": [3, 9, 47, …], "state": { /* canonical state after */ } }
  ],
  "final": { "scores": [52, 48], "outcome": 1, "exhausted": false }
}
```

- **[V2-4]** `initial` and every `plies[i].state` MUST be a *complete* canonical state, not a
  digest or a diff. Fixtures are read by humans when a test fails; a mismatching hash tells you
  nothing.
- **[V2-5]** The canonical state is `toJSON` ([0001 E1-52]) extended with the fields the UI does
  not need but conformance does — `bag` as an ordered colour array, `lid`, `tilesLeft`,
  `roundIndex`, `firstPlayer`, `markerInCenter`, `floorMarker`, `isTerminal`, `exhausted` — with
  object keys emitted in a fixed order and no derived caches. Two states compare equal iff their
  canonical forms are deep-equal.
- **[V2-6]** `shuffles[k]` is the bag contents *after* the k-th shuffle, in draw order, drawn
  from the end ([0001 E1-32]). The replay harness pops one entry per shuffle call and MUST fail
  if the engine asks for more shuffles than the vector recorded, or finishes with unused entries.
- **[V2-7]** `plies[i].legal` is the sorted list of legal actions in the position *before* the
  ply. The harness compares it against `legalActions()` sorted, so a legality bug surfaces at the
  ply that first exposes it rather than at some later divergence.
- **[V2-8]** Files MUST be committed to the repository. The suite MUST run with no network access
  and no Python installed.

## Generating vectors

- **[V2-9]** A single script `tools/vectors/dump_vectors.py` produces every vector. It runs
  against a local ludometer checkout, takes the output directory as an argument, and is the only
  thing permitted to write to `packages/engine/test/vectors/`. Vectors are never hand-edited —
  a wrong vector is a bug in the script or a real disagreement, and editing it by hand hides
  both.
- **[V2-10]** The script MUST patch the oracle's shuffling to record the resulting bag order, and
  MUST record the state *after* each ply by the oracle's own accessors, so the fixture is the
  oracle's opinion and not the script's.
- **[V2-11]** Regenerating MUST be reproducible: same ludometer commit, same seeds, byte-identical
  files. A diff in `git status` after a regeneration means something changed upstream, and that
  is worth reading.
- **[V2-12]** `generator.commit` MUST be recorded. When vectors disagree across ludometer
  revisions, we need to know which revision we agreed with.

## Coverage

### Full games

- **[V2-13]** At least 30 complete games, each from a distinct seed, replayed end to end.
- **[V2-14]** Move choice during generation MUST NOT be uniformly random in every game. At least
  a third SHOULD use policies that steer into awkward territory — prefer the floor line, always
  take the largest pile, always take from the centre, never take the marker — because uniform
  random play almost never fills a wall row or empties the bag.
- **[V2-15]** The set MUST include at least one game that ends by wall row completion
  ([0001 E1-36]) and at least one that ends exhausted ([0001 E1-37]).

### Handcrafted positions

- **[V2-16]** At least 5 positions built by hand in the oracle and replayed for a few plies each,
  covering situations random play reaches rarely or never. At minimum:

  | Position | Exercises |
  | --- | --- |
  | Tile joining a horizontal and a vertical run at once | [0001 E1-24] |
  | Multiple lines resolving top-down, later scoring off earlier | [0001 E1-25] |
  | Floor overfilled past seven slots with the marker held | [0001 E1-20], [E1-26], [E1-27] |
  | Big penalty against a small score | [0001 E1-28] clamping |
  | Bag and lid both empty at refill | [0001 E1-33], [E1-34] |
  | A round where nobody takes from the centre | [0001 E1-31] |
  | Final position with a full column and a full colour | [0001 E1-38] |

- **[V2-17]** Every handcrafted vector MUST carry a `note` saying what it is for. A fixture whose
  purpose nobody remembers is one nobody dares to change.

### Properties, checked on every ply of every vector

- **[V2-18]** Tile conservation ([0001 E1-40]) MUST be asserted after every ply of every replay,
  not only at the end.
- **[V2-19]** The remaining invariants ([0001 E1-41] to [E1-45]) MUST be asserted per ply.
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
- **[V2-25]** The observation vector MUST be checked for length, dtype, range `[0, 1]`
  ([0001 E1-56]) and current-player relativity: encoding a position and encoding it again after
  the turn passes MUST swap the "me"/"them" halves.

## Traceability

- **[V2-26]** Every requirement in *0001* MUST be cited by at least one test, by identifier, in
  the test name or an adjacent comment (`it("scores both runs when a tile joins two [E1-24]")`).
- **[V2-27]** A check MUST fail the suite when a requirement identifier in *0001* has no citing
  test, or a test cites an identifier that no longer exists. This is the mechanism that keeps the
  spec honest as the code moves.

## Running

```bash
pnpm -F engine test              # everything
pnpm -F engine test vectors      # replays only
pnpm -F engine test -t "[E1-24]" # every test citing one requirement
```

- **[V2-28]** The whole suite SHOULD finish in under 10 seconds on a laptop. It is the thing that
  runs on every save; slow enough to skip is the same as absent.

## Open questions

- Should vectors also be replayed *backwards* — reconstructing each prior state from the next —
  once the undo question in *0001* is settled?
- Is 30 games the right number, or should the count be whatever keeps a full run inside [V2-28]?
- Do we vendor a pinned copy of the ludometer engine into `tools/` so vectors can be regenerated
  without a separate checkout, at the cost of carrying someone else's code in the repo?

## References

- Intent [0001 — Rules engine](../intent/0001-rules-engine.md)
- Spec [0001 — Engine core](0001-engine-core.md)
- Oracle: [`ludometer/azul/engine.py`](https://github.com/RemiFabre/ludometer/blob/main/ludometer/azul/engine.py)
  and its suite [`tests/test_engine.py`](https://github.com/RemiFabre/ludometer/blob/main/tests/test_engine.py)
