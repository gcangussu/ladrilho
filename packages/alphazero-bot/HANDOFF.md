# Hand-off: training the AlphaZero player

You are taking over the **training run** of `packages/alphazero-bot`. The code is finished and
tested (spec 0011, status `implemented`, branch `alphazero-training`, commit `0dcc544`). Nothing
has been trained yet. Your job is to run the loop until the stop rule ends it, and to commit
what it records along the way.

## The goal

Intent 0009: a player trained from scratch that beats `sharp` ("ruthless") in **60 or more of
100 games**, measured by the gate: 200 games over the wide seeds against `sharp`, a null (the
player against itself) below 0.60, and a latency pass within budget ([Z11-35]). The run ends
one of two ways:

- **`done`**: a milestone's gate passed. This is success.
- **`stop`**: two milestones in a row didn't improve. The loop refuses to continue unless a
  person overrides it with a reason ([Z11-36]). **Overriding is the user's decision, not yours.**
  Report the stop with its numbers and ask.

## Read first

1. `intent/0009-an-opponent-we-train-ourselves.md`: what we want, in plain words.
2. `spec/0011-alphazero-training.md`, at least *Self-play and training*, *Milestones and the stop
   rule*, *Latency and throughput* and *Starting values*. Cite requirements as `[Z11-n]`.
3. `CLAUDE.md`, its `alphazero-bot` paragraph and command list.

## The machine

This laptop is the machine of record: Intel i7-1068NG7, 4 cores / 8 threads, 32 GB, no GPU.
Training is CPU-only by design. Two runs **must** have the machine otherwise idle: the latency
lane and a gate's latency pass. The numbers they record are the budget's evidence, and
a busy machine inflates them.

Long commands take hours. Run them in the background and check on them; don't block on them.

## Procedure

Pick a run name, say `first`. Every command runs from the repo root.

### 0. Check the build

```bash
pnpm install
pnpm -F alphazero-bot test
pnpm -F alphazero-bot test:train
```

`test:train` builds the trainer's pinned environment in `train/.venv` on its first run (needs
`uv`). All three must pass before you start.

### 1. Initialise ([Z11-58]), a few seconds

```bash
pnpm -F alphazero-bot train init --run first
```

This writes `runs/first/config.json` (the *Starting values*, a random seed, `playSimulations`
unset) and checkpoint 0 with its parity file. `runs/` is git-ignored scratch.

### 2. Latency ([Z11-57]), **hours, idle machine**

```bash
pnpm -F alphazero-bot latency --run first
```

This finds `playSimulations`: the largest multiple of 100 that meets **half** the budget (p95 ≤
1.5 s, p99.9 ≤ 2.5 s), with the next count up measured and seen to miss it. A probe on checkpoint
0 predicted a start near **8,400** simulations. Each step is a full pass over the 2016-position
corpus, about 35–50 minutes, so expect several hours. The lane writes
`latency/first.json` and fixes `playSimulations` in the config, lowering `milestoneSimulations`
(800) if needed.

**Commit `latency/first.json`.**

### 3. Throughput ([Z11-53]), about 20 seconds

```bash
pnpm -F alphazero-bot throughput --run first
```

This writes `runs/first/throughput.json`. On checkpoint 0 it measured about **2.2 minutes of
self-play per generation**, against a limit of 30.

### 4. Train ([Z11-28]), days

```bash
pnpm -F alphazero-bot train --run first
```

Each generation runs self-play (500 games, 200 simulations a move, 8 threads), then training
(1000 SGD steps of 512 on the last 20 generations' samples, 4 torch threads). Every 10
generations it runs a **milestone**: 100 games against each of `uniformRandom`, `greedy`,
`steady` and `sharp` at 800 simulations. When `sharp` reaches 0.50 and the gate is due, it
also runs the **gate** (3–4 hours, ending with a latency pass that needs the machine idle).

- **Resuming:** stop it at any time (Ctrl-C) and rerun the same command. It continues from the
  first step whose output isn't on disk ([Z11-30]); an interrupted milestone is replayed.
- **Lock:** the loop, a hand-run gate, and the latency and throughput lanes share one lock,
  `packages/alphazero-bot/.lock` ([Z11-61]). A second one refuses and names the holder. A lock
  left by a dead process is taken over automatically.
- **Output:** the loop prints one sentence per milestone, naming the numbers the decision was
  taken on.

### 5. After every milestone: commit

The loop never runs `git` ([Z11-34]). After each milestone, commit:

- `packages/alphazero-bot/milestones/log.json`
- `packages/alphazero-bot/milestones/first/<generation>/checkpoint.bin` and `.parity` (2.5 MB each)
- any new `packages/alphazero-bot/gate/first/<generation>.json`

Then run `pnpm -F alphazero-bot test`. It replays the committed log through the stop rule,
loads every committed checkpoint with its parity check, and holds every gate and latency
result to its own numbers. If any of those fail, stop and report.

**Never commit `runs/`.**

### 6. Reading the run

- **`runs/first/losses.json`**, one record per generation. `before` is checkpoint `g`'s loss on
  its own new samples before training on them, the cheapest overfitting detector there is
  ([Z11-54]). `training` is the mean over the generation's steps. `drawRatio` should be about
  0.68. If `before` climbs while `training` falls, the network is memorising.
- **`milestones/log.json`**, each entry's `results`, `progress` (sum of the four winrates, 0–4),
  `gate` and `reason`. Early milestones gain against the weak rungs; once those saturate,
  progress moves only with `sharp`.
- Each milestone entry records its own wall time. Please report the first real figures for
  milestone and gate duration: the spec's are estimates.

### 7. When it ends

- **`done`:** commit the gate result and the log. Tell the user the gate's numbers (winrate,
  Wilson lower bound, per-seat winrates, null, latency p95 and p99.9). Changing intent 0009's
  status and offering the player in the interface are separate decisions for the user.
- **`stop`:** don't override. Report the reason, the last milestones' progress and `sharp`
  winrates, and what the losses show. Point to the spec's *Open questions* for remedies: a
  score-margin value head, display-permutation augmentation, more games per generation or a
  shorter window. Those are spec changes the user would make. With a reason from the user:
  `pnpm -F alphazero-bot train --run first --override "<reason>"`.

## Things that cost a run if you get them wrong

- **The config is fixed once generation 0 starts** ([Z11-25]). Changing a setting means a new
  run with a new name (`train init --run second`), not an edit.
- **Don't change `bot`, `packages/engine` or `packages/engine-rs` during a run.** The ladder
  hash ([Z11-63]) makes a milestone after such a change start afresh, so the stop rule loses
  its comparison. If one lands anyway, the log records it. Don't hide it.
- **Commit source changes before starting.** Milestone entries and gate results record whether
  any source path had uncommitted changes (`provenance.dirty`). A dirty record is harder to
  reproduce.
- **Never regenerate `train/parity-corpus.bin`** (the ignored `write_the_corpus` test). Every
  parity file names its hash, so rewriting it orphans every committed checkpoint.
- **Don't re-record `latency/corpus.bin`** during a run: latency records are only comparable
  on the same corpus.
- **The stop rule is `eval/decision.ts`.** If the user changes it, rerun
  `pnpm -F alphazero-bot stop-simulation` and update [Z11-33]'s table in the same change
  ([Z11-56]).
- **A milestone or gate run by hand** (`pnpm -F alphazero-bot milestone|gate
  packages/alphazero-bot/milestones/first/<g>/checkpoint.bin`) only works on a **logged**
  milestone, and reads its settings from the log entry. A passing hand-run gate ends the run
  (`manual-gate` entry). A failing one changes nothing but writes its result file, which you
  commit too.

## What was checked before hand-off

- A full-size `train init`, `throughput`, and a latency probe on checkpoint 0.
- A tiny throwaway run went through the whole loop: self-play, training, a real milestone
  against the full ladder (`sharp` at full budget), a decision and a log entry the suite
  replayed. Its artifacts were deleted.
- **Not yet run anywhere:** the latency lane's full search and a real gate. Watch the first of
  each closely.

## Context you might be asked about

- **`network.rs` versus ONNX Runtime.** Benchmarked at W=256, B=4: `network.rs` takes 134 µs a
  position, ONNX Runtime 88 µs one at a time and 14–20 µs batched. The user decided to keep
  `network.rs` for now. Self-play isn't the bottleneck (2.2 of a 30-minute budget).
  Batching evaluations would be the real speedup with either runtime, and it is a spec change.
- **The branch** `alphazero-training` isn't merged into `main`. Ask the user whether to train on
  it or merge first.
