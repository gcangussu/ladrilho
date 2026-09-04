# Conformance vector generator

`dump_vectors.py` records the [ludometer](https://github.com/RemiFabre/ludometer) Python engine
playing Azul and writes the fixtures the TypeScript engine is replayed against. It implements
spec [0002 — Engine conformance vectors](../../spec/0002-engine-conformance-vectors.md); every
rule it follows is a `[V2-n]` there.

**The committed suite does not need any of this.** Vector JSON is checked in, and
`pnpm -F engine test` runs with no network and no Python ([V2-8]). You only come here to
regenerate.

## Recreating the oracle checkout

The vectors are pinned to one ludometer revision ([V2-12]); it is recorded in every file under
`generator.commit`.

```bash
git clone https://github.com/RemiFabre/ludometer.git /tmp/ludometer
git -C /tmp/ludometer checkout 917ccef386ea66ec5bfd6fff18398aff7ee369de
```

`ludometer/azul/engine.py` imports numpy at module load, and nothing else, so a virtualenv with
numpy is the whole dependency:

```bash
python3 -m venv /tmp/vectors-venv
/tmp/vectors-venv/bin/pip install numpy
```

## Regenerating

Both paths are arguments — nothing about the checkout's location is baked in:

```bash
/tmp/vectors-venv/bin/python tools/vectors/dump_vectors.py \
    --ludometer /tmp/ludometer \
    --out packages/engine/test/vectors
```

The script clears `--out` of `*.json` first, so a fixture the generator no longer produces does
not linger. `--games N` changes the number of full-game vectors (default 30, the floor in
[V2-13]); `--commit` and `--date` override the provenance fields for a checkout without git
metadata.

## What "reproducible" means here

[V2-11] requires the same checkout and the same seeds to produce **byte-identical** files, so a
clean `git status` after regenerating is the expected outcome and a diff is a signal worth
reading — usually that the oracle changed.

Two things follow, and both are load-bearing:

- Nothing may depend on *when* the files were generated. `generator.generatedAt` records the
  ludometer commit's own date (`git show -s --date=short`), never the clock.
- Nothing may depend on where the checkout lives, or on the platform's Python. The only
  randomness is Python's `random.Random`, always explicitly seeded.

`generator.policy` is one field beyond the list [V2-37] sketches, which requires those fields
without forbidding others. It records the move policy a game was generated with, so [V2-14] can be
checked by the suite rather than taken on trust: without it a test can only assert a proxy for
steering. Positions do not carry it.

`generator.pythonSeed` is provenance only ([V2-2]). The port has its own PRNG and does not
reproduce ludometer's tile order for any seed ([0001 E1-49]); what a replay feeds back in is the
recorded `shuffles` array, never the seed.

## How the recording works

- **The shuffle patch.** `random.Random.shuffle` is wrapped so every call appends the resulting
  bag order to a log ([V2-10]). That log becomes the vector's `shuffles`, and its length becomes
  `shufflesUsed` — the one canonical field the oracle cannot supply, because it has no shuffle
  counter ([V2-32]). Counting interceptions is the sanctioned exception; every other recorded
  value is read off the oracle, never recomputed in Python.
- **Games** (`game-NN.json`) start from `AzulState.new_game(seed)`, so the creation shuffle is
  index 0 and `initial` is what a correct `newGame` must reproduce ([V2-36], [0001 E1-65]).
  Seeds 0–29 cycle four move policies — uniform, largest pile, centre-first, and marker-avoiding
  — so three quarters of the games are steered somewhere uniform play rarely goes ([V2-14]).
  Every one must end by wall-row completion; the script raises if a game ends exhausted, since
  that is unreachable from a full census ([V2-15], [0001 E1-37]).
- **Positions** (`position-NN-slug.json`) are posed by writing the oracle's documented state
  attributes and calling its own `recount()`, then played for a few plies. `new_game` shuffles
  once before the pose overwrites it, so `shufflesUsed` is rebased to zero at `initial` *and* at
  every recorded ply ([V2-33]) — an unrebased later ply fails a correct engine just as surely as
  an unrebased first one.
- **The short-census position.** `position-05-empty-bag-and-lid` is the only fixture holding
  fewer than 100 tiles, and it declares `"census": "short"` ([V2-35]). It has to: a refill can
  only find bag and lid both empty when the census is below 100. Its composition is a pinned pair
  of seeds (`SHORT_COMPOSE_SEED`, `SHORT_PLAY_SEED`) found once by a search over a few hundred
  candidate compositions and hard-coded, so regeneration stays deterministic. It runs three round transitions — a lid
  recycle, a deal that stops part-way, then a refill that deals nothing — because [0001 E1-34]
  and [0001 E1-37] cannot both happen at the same refill.

## Do not hand-edit a vector

[V2-9] makes this script the only writer of `packages/engine/test/vectors/`. A wrong vector is
either a bug in here or a real disagreement between the two engines, and editing the JSON hides
both. Fix the script, or fix the engine.
