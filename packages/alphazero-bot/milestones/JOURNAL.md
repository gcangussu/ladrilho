# Training journal

The story of training the player of spec 0011: what each run changed, why, what it showed, and
what was decided because of it. The numbers live elsewhere and are only quoted here:

- `log.json`: every milestone, its results, its decision and its one-line reason.
- The commits: each change with its evidence. Hashes are given below.
- Spec 0011: the rule each change became, with its reasoning in the italic notes.

Add an entry when a run starts or ends, or when a decision changes the plan. Times are local
(UTC−3), on the machine of record: an Intel i7-1068NG7 laptop, 4 cores, 8 threads, no GPU.

## At a glance

| Run | Started | From | The one change | Yardstick | Ended | Where it got to |
| --- | --- | --- | --- | --- | --- | --- |
| `first` | 09-29 | random weights | none (the *Starting values*) | ladder | gen 210, stop rule | progress ≈ 1.9, `sharp` 2–9% |
| `second` | 09-30 | `first`/210 | display permutation ([Z11-65]) | ladder | gen 75, paused for the CPU | progress ≈ 1.97, no clear gain |
| `third` | 09-30 | `second`/70 | 3000 games a generation | ladder | gen 90, **gate passed** | 0.79 against `sharp` at full strength |
| `fourth` | 10-01 | `third`/90 | the gate off ([Z11-68]) | ladder | gen 140, ended with its session | `sharp` 0.79–0.89; the ladder saturated |
| `fifth` | 10-01 | `fourth`/140 | the pool as yardstick ([Z11-73]) | pool | running | gen 20: +312 Elo |

Progress on the ladder is the sum of four winrates (0 to 4). Pool ratings are Elo, with `third`/90,
the checkpoint that passed the gate, at 0.

## Before training: the latency budget (09-29)

`playSimulations`, the simulations a shipped move may use, had to meet half the latency budget
(p95 ≤ 1.5 s, p99.9 ≤ 2.5 s). The lane as written guessed a start from a short probe (8500) and
stepped by 100, about 20 minutes a step. After ten steps it stopped at 9300: the pass at 9400 missed
on p99.9 alone (2606 ms against a p99 of 1262 ms) while the machine was in use. That was a single
spike, not the real limit.

**Decision (the user):** use the data. Fit a line ignoring outliers, start where it crosses the
budget, and search outwards from there instead of in fixed steps. The lane now fits Theil–Sen lines
through every measurement a run has taken, starts at their crossing, steps away by 100, 200, 400,
… until the verdict flips, then bisects; a miss on p99.9 alone is measured again (`69283da`,
[Z11-57]). It settled at **11300** in eight passes (`f2c7a4a`). The 11400 pass was again disturbed by
use of the machine, so the true limit is somewhere between 11300 and 11800, and 11300 errs a few
percent on the safe side.

## `first`: from scratch (09-29 → 09-30)

500 games a generation at 200 simulations a move, 1000 training steps, a window of 20 generations.
Milestones every 10 generations against the ladder (`uniformRandom`, `greedy`, `steady`, `sharp`) at
800 simulations.

Progress climbed fast, from 1.07 to 1.67 by generation 40, then flattened at about 1.8–1.9 from
generation 50 on. `sharp` stayed between 2% and 9%. The fresh-game losses flattened at the same
time.

- **The stop rule's floating-point bug.** At generation 160 the loop stopped because
  1.8899999999999997 < 1.8900000000000001: both are exactly 1.89, which the rule counts as
  improving. Progress is now compared at nine decimals everywhere the rule compares it. Entry 160
  was corrected to `continue`, with the original kept under `correction`, and the run resumed
  (`fffd77f`, `7415cd9`, [Z11-33]).
- **The diagnosis that mattered later.** The value head scored about 0.33 on its own training
  samples and about 0.9 on fresh ones. It was memorising games, not learning to judge positions. Each
  game gives about 56 samples sharing one result, and each sample was drawn about 18 times.
- **The end.** A genuine stop at generation 210, with progress at 1.875 after two milestones that did
  not improve (`6fc6778`).

## `second`: display permutation (09-30)

The five factory displays are interchangeable, so each training sample can be shown under a random
relabelling of them without searching again ([Z11-65]). To avoid relearning, the run started from
`first`'s weights, optimiser and window (`aaa030b`, [Z11-66]).

**Decision (the user):** change one thing at a time, so that it stays clear what worked.

Result: about the same as `first`. Over 7 milestones progress averaged 1.97, against `first`'s 1.93,
within noise. The value head still memorised: about 0.33 on training samples, about 0.92 on fresh
ones. A permutation hides which display holds which tiles, but the walls, scores and lines still
identify the game.

**The key measurement (09-30, before `third`).** On generation 59's fresh samples, the value head
scored 0.89. A line fitted through the score difference alone scored 0.81, and predicting 0 scored
0.98. By round, the head was worse than predicting 0 in round 1 (1.19) and behind the formula in
every round but the last: confidently wrong about games that were still open. Since the search
values every leaf with this head, that also explained the stalled policy.

A research report on the literature
([artifact](https://claude.ai/artifact/9SiK5gUhmPBfRwMDtBc42c)) was read against this evidence. It
became the ranked plan below. Its first idea, auxiliary targets, remains the next experiment.

`second` was paused at generation 75 when the CPU was needed elsewhere, and was not resumed.

## `third`: 3000 games a generation (09-30 → 10-01)

The memorising came from too few independent results for the training done on them. Each generation
trains the same 1000 steps however many games it played, so 500 games meant six times the training
per game of 3000, and a window of about 10,000 games instead of 60,000 (reuse about 18 instead of
about 3). **Decision (the user):** 3000 games, the one change (`5f0f9fa`). Each generation now also
records the value head by round beside the formula (`a539368`, [Z11-54]).

It worked at once:

- The value head beat the formula by generation 4.
- The policy started learning again: from 1.85 down to about 1.5 on fresh games by generation 80.
- Progress rose from 2.33 at generation 10 to 3.41 at generation 90, flat for two milestones
  around generation 40, and `sharp` went from 0.11 to 0.585.

**The forward pass, made 2.2× faster mid-run.** A profiling agent found that 99% of self-play time
was the network, compiled to 2-float vectors. A kernel layout fix and an AVX2 build give
byte-identical samples, 2.4× faster on one thread and 2.2× at eight (`4fc0c63`, `8acfbc6`). Because
the samples are identical, it merged into the running run. Generations went from about 12 to about
5 minutes.

**The gate passed at generation 90 (10-01 03:20)** (`d7eafcd`, tag `alphazero-gate-passed`):

- 0.7875 against `sharp` over 200 games (156 wins, 41 losses, 3 draws), Wilson lower bound 0.736,
  0.78 / 0.795 by seat.
- Null 0.505; latency p95 551 ms and p99.9 622 ms.

Intent 0009's bar of 60 in 100 is met. A side match afterwards: **0.88 against `ai-bot`'s expert**
(87 wins, 11 losses, 2 draws). The expert searches 100 simulations a move to our 11,300, though it
keeps its tree between moves.

## `fourth`: past the gate (10-01)

**Decision (the user):** keep training to see how strong the player becomes. A run from `third`
would have reached the gate's trigger at its first milestone and ended `done` at once, so the gate
can now be switched off for a run (`a7c57e8`, [Z11-68]).

Self-play was made about 3× faster again, with identical samples (`4b5156e`, merged at generation
30): a memo of evaluations within each game ([Z11-69]), four games per thread batched into one
forward pass ([Z11-70]), and policy logits computed only for legal moves ([Z11-71]). Milestones now
play through one persistent `serve` process per player per game ([Z11-72], `ed5ad1c`). That changed
the ladder hash, so milestone 40 started afresh.

`sharp` rose from 0.63 to 0.89, while the lower rungs pinned at 0.98–1.00 and the losses barely
moved. The ladder was running out of room: the last ~0.2 of progress was all `sharp`, swinging
±0.07 with 100 games, alternating up and down so the stop rule could not fire.

**Decision (the user): retire the ladder.** Monitoring the losses alone was considered and rejected.
They had stayed flat through big gains (`third`, `fourth`) and through no gains (`first`), so they
cannot tell progress from a plateau. They remain the health panel.

`fourth` ended at generation 140, with decision `continue`, when the session that started its loop
ended (`50e7586`). Since then the loop runs detached from any session.

## The pool of champions (10-01)

The user's design, specified as [Z11-73] and [Z11-74] (`0b25298`):

- Three champions, each a committed milestone checkpoint with an Elo rating, played at **200
  simulations**: self-play's count, so the network carries the play rather than the search.
- Each milestone plays every champion and gets a performance rating.
- Two standard errors above the weakest champion: it replaces it. Two below: no change. In between:
  **a third more games** against each champion, and the higher rating decides.
- An informal budget of ten minutes of the whole machine per milestone.

The scale is anchored at `third`/90 = 0 and stays anchored after it leaves. The stop rule compares
ratings instead of progress.

Measured, then seeded (`37dac7f`):

- A pool game costs 0.23 s at eight workers, so **800 games a champion** gives about 9 minutes per
  milestone (12 with the extra games) and ratings good to about ±7 Elo.
- The round robin: `fourth`/50 **+156**, `fourth`/70 **+181**. While the ladder showed `sharp`
  barely moving, the player had gained 180 Elo over the checkpoint that passed the gate.

## `fifth`: on the pool (10-01 →)

**Decision (the user):** measure the baseline on the pool before trying anything new. `fifth`
continues `fourth`/140 with only the yardstick changed (run detached, `--workers 8`).

- Generation 10: **+301 ±8**. It scored 86% / 71% / 65% against the three champions and replaced
  `third`/90 outright (`3853abb`). 454 s.
- Generation 20: **+312 ±7.5**, improved. It scored 52.9% against its own predecessor and replaced
  `fourth`/50 (`a767c24`). 448 s.

## Next

- **`sixth`: auxiliary targets** ([Z11-67], branch `alphazero-aux`, `df1175a`, ready and checked),
  once the pool shows `fifth` has plateaued. It adds two training-only heads, the final score margin
  and the final walls, neither exported, so search and latency are unchanged. Weights 0.5 / 0.5.
  The motivation: the value head stopped improving at about 0.73 on fresh games once it stopped
  memorising, and early-game results are close to coin flips.
- After it, in the report's order and as the evidence points: better policy targets at low
  simulation counts (playout-cap randomisation, then Gumbel search); blending the result with the
  search's value; restarting self-play from saved round starts.

## Ways of working that this run settled

- **One change per run.** Each run starts from the last one's checkpoint ([Z11-66]) and records what
  differs in `from.changes`.
- **The loop writes, a person commits.** Every milestone is committed with its checkpoint, after
  the suite replays the log.
- **Measure before trusting.** Every speedup was merged only after its samples were shown
  byte-identical on a quiet machine. Every new test was seen to fail on a mutated copy.
- **Watch the yardstick, not only the player.** The ladder's saturation, and the losses' silence,
  each hid real progress for hours.
