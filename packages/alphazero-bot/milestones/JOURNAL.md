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
| `fifth` | 10-01 | `fourth`/140 | the pool as yardstick ([Z11-73]) | pool | gen 270, stop rule | **+464** at gen 250; `sharp` 0.91 at 200 simulations |
| `sixth` | 10-02 | `fifth`/250 | auxiliary targets ([Z11-67]) | pool | gen 80, stop rule | **+496** at gen 40, 32 above `fifth` |
| `seventh` | 10-02 | `sixth`/40 | learning rate 0.02 → 0.002 | pool | gen 170, stop rule | **+643** at gen 150, 147 above `sixth` |
| `eighth` | 10-02 | `seventh`/150 | self-play simulations 200 → 400 | pool | gen 180, stop rule | **+689** at gen 160, 46 above `seventh` |
| `ninth` | 10-03 | `eighth`/160 | learning rate 0.002 → 0.0002 | pool | gen 110, stop rule | **+750** at gen 90, 61 above `eighth` |
| `tenth` | 10-03 | `ninth`/90 | playout-cap randomisation ([Z11-75]) | pool | gen 120, stop rule | **+776** at gen 100, 26 above `ninth` |
| `eleventh` | 10-03 | `tenth`/100 | learning rate 0.0002 → 0.0001 | pool | gen 150, stop rule | **+812** at gen 130, 36 above `tenth` |
| `twelfth` | 10-04 | `eleventh`/130 | learning rate 0.0001 → 0.00005 | pool | gen 170, stop rule | **+856** at gen 120, 44 above `eleventh` |

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

## `fifth`: on the pool (10-01 → 10-02)

**Decision (the user):** measure the baseline on the pool before trying anything new. `fifth`
continues `fourth`/140 with only the yardstick changed (run detached, `--workers 8`).

- Generation 10: **+301 ±8**. It scored 86% / 71% / 65% against the three champions and replaced
  `third`/90 outright (`3853abb`). 454 s.
- Generation 20: **+312 ±7.5**, improved. It scored 52.9% against its own predecessor and replaced
  `fourth`/50 (`a767c24`). 448 s.

The climb went on for 230 more generations, slowing as it went: +342 at 50, +362 at 100, +410 at
150, +428–436 around 200, and **+464 ±6 at generation 250** (`5b104a5`). Generations 260 (+463) and
270 (+455) did not beat it, and the stop rule ended the run at 270 (10-02 08:09, `ef0b65b`). The
extra third of games was needed at seven milestones, all near the top, where the champions sit
within a few Elo of each other.

- **Dips between checkpoints.** Generations 30 (+231), 60 (+251), 110 (+326) and 170 (+346) each
  rated 50–90 Elo below their neighbours, and the next milestone recovered. The losses did not
  show them. The learning rate stays at 0.02 throughout, so a checkpoint is one noisy point on a
  path; averaging the weights or decaying the rate are the likely remedies (see *Next*).
- **Is the scale inflated?** Each new rating is measured only against recent champions, which could
  drift if strength were not transitive. `fifth`/130 was played against the two old anchors
  (`third`/90 and `fourth`/70) instead: **+395 ±17**, against the pool's +383. No material drift.
- **Against `sharp` (10-02).** `fifth`/250 at 200 simulations, 200 games on the wide seeds:
  **0.9125** (182 wins, 17 losses, 1 draw), Wilson lower bound 0.874, 0.92 / 0.905 by seat, mean
  score 48 to 38. `third`/90 passed the gate with 0.7875 at 11,300 simulations, 56 times the
  search. Most of the strength is now in the network.

## `sixth`: auxiliary targets (10-02)

**Decision (the user, authorised in advance):** when `fifth` plateaued, start the most promising
idea. `sixth` starts from `fifth`/250, the highest rated milestone, with one change: two
training-only heads predicting the final score margin (÷20) and the 50 final wall cells, weighted
0.5 each ([Z11-67], branch `alphazero-aux` merged in `ee5f133`). Neither head is exported, so the
search, the checkpoint format and the latency are unchanged. The motivation: the value head stopped
improving at about 0.73 on fresh games, and these targets carry far more signal per game than one
win or loss. The window's inherited samples have no aux targets; the aux loss uses only the samples
that do, so it phases in over the first generations. Throughput: 1.2 minutes a generation.

- **The heads are healthy.** On each generation's fresh games, before training, the margin loss
  sits at about 0.25 and the walls loss fell from 0.71 to 0.32 by generation 19, matching the
  training losses: they generalise, they do not memorise. The share of samples with targets rose
  by 5% a generation, reaching 100% at generation 19.
- Generation 10: **+476 ±7**, a new best by 12 Elo, about 1.7 standard errors. It replaced
  `fifth`/230.
- Generation 20: +459 ±6 after the extra games, keeping the pool. One milestone is not a trend:
  `fifth` showed dips of this size.

Then 30: +484, 40: **+496 ±7** (the best), 50: +454, 60: +486, 70: +483, and 80: **+424**. The
stop rule ended the run at 80 (10-02 13:33, `ea6d460`): 70 did not beat 60, and 80 did not beat 70.

- **Aux targets helped.** In 40 generations `sixth` passed `fifth`'s best by 32 Elo, against
  `fifth`'s last 60 generations within 458–464. Its plateau sits around +485, about 20 above
  `fifth`'s. They stay on.
- **The dips grew.** Generation 50 fell 42 below its predecessor and 80 fell 59, the largest drop
  between neighbouring milestones in either run. A checkpoint at a constant learning rate of 0.02
  is a noisy sample of where training is; the stop rule fired on a noisy sample. This is the
  strongest case yet for averaging the weights or decaying the rate.

## `seventh`: a tenth of the learning rate (10-02)

**Decision (the user):** start from `sixth`/40, the best checkpoint, with the learning rate cut
from 0.02 to 0.002 and nothing else changed (aux targets on). A step decay once progress stalls
is what AlphaZero did. The aim is the dips: at a lower rate, consecutive checkpoints should
differ less, so the milestones measure the trend rather than the noise.

- **A bug found before it ran.** PyTorch's `load_state_dict` restores the saved learning rate,
  momentum and weight decay along with the momentum buffers. So a child run's `--set` of any of
  the three was recorded in `from` and silently not used: `seventh` would have trained at 0.02.
  No earlier run changed them. A restored optimiser now takes them from the run's config
  (`25a1f36`, [Z11-66]), and generation 0's saved optimisers, body and aux, show 0.002.

Generation 10: **+555**, 59 above its parent in ten generations. Then a slow, steady climb with
small dips: 550, 574, 595, 592, 606, 593, 608, 606, 610, 623, 606, 626, 618, **+643 at 150**, 622,
616. The stop rule ended it at 170 (10-02 22:20, `9a807ca`).

- **The lower rate was the biggest single gain on the pool.** +147 over `sixth`'s best, and the
  dips shrank: the largest drop between neighbouring milestones was 21, against `sixth`'s 59.
- **The browser ships the best milestone.** Spec 0012 (merged from `main` at milestone 70) added
  the "master" opponent and `web/shipped.json`, which must name the highest-rated logged
  milestone; it moved with each new best and now names `seventh`/150.
- **A procedure slip.** Milestone 80 was committed before its suite was green: the shipped-milestone
  test reads `git ls-files`, so the files must be staged before the suite runs, and a `grep` in the
  command chain hid the failure. The suite passed on the committed state; since then a script
  stages, tests with `pipefail`, commits and fast-forwards `main`, stopping on any failure.

## `eighth`: twice the self-play simulations (10-02 → 10-03)

**Decision (the user):** if `seventh` plateaued, start from its best milestone with 400 self-play
simulations instead of 200, nothing else changed. A move's visit counts are its policy target and
the games' results its value target; at 200 simulations both come from shallow searches. Pool
milestones still play at 200, so ratings stay comparable. Throughput: 1.8 minutes a generation
(was 1.2).

Generation 10: +623, below its parent while the window still held `seventh`'s 200-simulation
games. Then 641, 643, **656** (first above `seventh`), 628, 650, 665, 668, 622, 656, 672, 663,
672, 653, 676, **+689 at 160**, 667, 657. The stop rule ended it at 180 (10-03 09:00, `f3a7e21`).

- **Twice the simulations helped, modestly:** +46 over `seventh`'s best in 160 generations, at
  1.5× the time a generation. The dips came back somewhat larger than `seventh`'s (up to 46).
- **Side checks of `eighth`/160 at 100 simulations** (100 games each, not committed): against
  `sharp` 0.925 (92 wins, 7 losses, 1 draw; 0.98 first, 0.87 second); against `ai-bot`'s expert
  at its default 100 simulations 0.98 (98 wins, 2 losses), mean score 55.5 to 37.5.

## `ninth`: a hundredth of the original learning rate (10-03)

**Decision (the user):** if `eighth` plateaued, cut the learning rate again, 0.002 → 0.0002, from
its best milestone, nothing else changed (400 self-play simulations, aux targets). The second
step of the classic schedule; the first gave `seventh` +147. Throughput: 1.9 minutes a generation.

Generation 10: **+713**, 24 above its parent at once, as `seventh`'s first cut had done. Then
702, 716, 702, 736, 733, 733, 739, **+750 at 90**, 745, 739. The stop rule ended it at 110 (10-03
15:20, `eed43f7`).

- **The second cut gave +61**, against the first's +147: still the cheapest gain available, but
  shrinking. The swings between milestones were the smallest yet, at most 14.
- **Float32 sets a floor.** Measured between consecutive checkpoints, the median weight moves
  about 32 ulps a training step at 0.0002, and the slowest 1% about a third of one on net. A
  further 10× cut would start rounding updates away; about 2 × 10⁻⁵ is the lowest rate worth
  trying without float64 master weights in the trainer.

## `tenth`: playout-cap randomisation (10-03)

**Decision (the user):** prepare playout-cap randomisation and start it when `ninth` stops.
`eighth` showed that better policy targets help (+46 for 400 simulations instead of 200) but paid
for them on every move. Under the cap ([Z11-75], `d22350a`, merged in `fc52024`) a quarter of
the moves get a full search of 1000 simulations with the noise and become move samples; the rest
get 200, no noise, and become value-only **cheap** samples. That averages 400 simulations a move,
as before. KataGo drops the cheap positions; here they stay as value samples, since the value
head memorised when positions per result were few. From `ninth`/90, the best; everything else
unchanged. Measured beforehand on `ninth`/100: 10–15% slower per game than 400 throughout, exactly
a quarter of moves searched fully, and the same number of samples. Throughput: 1.8 minutes a
generation.

Generation 10: +741, below its parent while the window still held `ninth`'s uncapped games. Then
**764**, 750, 758, 759, 761, 758, 762, 770, **+776 at 100**, 763, 763. The stop rule ended it at 120
(10-03 22:36, `f9744b6`).

- **The cap helped, modestly:** +26 over `ninth`'s best, at about the same cost a generation. It
  sat at 758–764 for 60 generations, then climbed to 776, so the gain came late.
- **A side check of `tenth`/20 at 100 simulations** (100 games, not committed): 0.985 against
  `ai-bot`'s expert at its default 100 (98 wins, 1 loss, 1 draw), the same as `eighth`/160's
  0.98. The expert can no longer tell our checkpoints apart; the pool can.

## `eleventh`: half the learning rate (10-03 → 10-04)

**Decision (the user):** halve the learning rate for the next run, 0.0002 → 0.0001, and halve it
again for the one after (`twelfth`, 0.00005). Both stay above the float32 floor of about 2 × 10⁻⁵.
From `tenth`/100, the best; the playout cap and everything else unchanged. Throughput: 2.1 minutes
a generation.

Generation 10: +762, below its parent, unlike the bigger cuts' immediate jumps. Then 781, 772,
781, 769, 774, 776, 779, **797**, 797, 802, 800, **+812 at 130**, 808, 804. The stop rule ended it at
150 (10-04 07:52, `2281238`), the same milestone at which the user had asked for a pause.

- **Half the rate gave +36, late.** For 60 generations it sat at 769–781, level with `tenth`; the
  gain came from generation 90 on. A lower rate learns slowly, so a run at one needs patience
  the stop rule, comparing each milestone with the one before, only sometimes gives it.

## `twelfth`: half again (10-04 → 10-05)

**Decision (the user):** the second halving, 0.0001 → 0.00005, started when the user resumed
training. From `eleventh`/130, the best; nothing else changed. 0.00005 is about 2.5× the float32
floor, so the slowest weights' updates may start rounding away. Throughput: 1.9 minutes a
generation.

Generation 10: +808, level with its parent. Then 806, 810, 808, **828**, 845, 843, 844, 845, 852,
847, **+856 at 120**, 846, 851, 854, 850, 849. The stop rule ended it at 170 (10-05 05:53,
`06ebf35`).

- **The second halving gave +44**, more than the first's +36, and sooner: the climb began at
  generation 50 rather than 90. From generation 60 on it held 843–856 for 110 generations,
  alternating up and down, which kept resetting the stop rule.
- **The learning-rate steps, all told:** 0.02 → 0.002 (+147), → 0.0002 (+61), → 0.0001 (+36),
  → 0.00005 (+44). The rate is now 2.5× the float32 floor; a further halving is still possible
  but near the limit, and gains a run have been shrinking to the size of the noise over many
  generations.
- **Mid-run, `main` moved** (`d886879`, the danluu.com tile match); `twelfth`'s milestone commits
  were rebased onto it, without conflicts, and `main` fast-forwarded again.

## The endgame proof, validated (10-05)

On `main` (`ab38db0`, `d804a47`, [Z11-76], [Z11-77]): once a wall row holds four tiles, so the
game can end this round, `play` follows the search with a node-capped alpha-beta over the rest of
the round. Lines that run into the next round count as the worst case for the claim, so no proof
reads the deal. The search's move gives way only to a proven win, or, when it is a proven loss,
to a move proven to draw at least. Milestones, the pool and self-play keep the search alone.
Pulled into the training branch as a fast-forward and checked independently:

- **Training is untouched.** For 40 games of `twelfth`/120 under `twelfth`'s config, the binary
  from before the pull and the new one wrote byte-identical samples and aux records, with
  `playEndgameNodes` set or not.
- **The pool is untouched.** `twelfth`/120's logged milestone (3,201 games) replayed with the
  new binary: rating 855.577447437 again, to nine decimals, with identical wins, losses and draws
  against all three champions.
- **The tests are real.** The suites pass (104 + the crate's + 19); on a scratch copy four
  mutations each turned a named test red, three from the commit's record and one more (a draw
  "saved" on optimistic evidence).
- **What the proof is worth in the pool's games.** `twelfth`/120 replayed the same 3,201 games
  with a 2M-node proof at 200 simulations, the champions without it: **+905 ±6, against 856**.
  264 games changed: 190 losses became wins, 27 became draws, 45 draws became wins, and 2 wins
  became draws, where the search's move was a proven loss against best play that the opponent
  would have let it win. Not checked: the latency figures, which need an idle machine.

This is a gain for the player that ships, not for the network: the pool still rates the search
alone, as [Z11-77] intends.

**Shipped (10-05).** `main` (`b38495b`, [0012 T12-33]) puts the proof in the browser master at
300,000 nodes, the largest cap inside the browser's latency and memory budgets. Pulled, both
suites green (105 and `ui`'s 201). The same 3,201 pool games at the shipped cap: **+897 ±6**,
against 856 without and 905 at 2M. 223 games changed, 222 for the better; only 47 differ from
the 2M replay. So the shipped cap keeps about 85% of the proof's gain.

## The shipped player, profiled (10-05)

The master's moves, profiled in V8 and natively on the latency corpus at the default with the
shipped proof: about 90% of a move is the forward pass, 1–4% the proof on average — but the proof
is most of the slowest moves' excess, the 30 positions where it spends its whole 300,000-node cap
for nothing. Two changes, neither changing a move, a value, a verdict or an evaluator call on any of
the 1978 positions, and self-play's samples byte-identical:

- **The forward pass skips zero inputs** ([Z11-10], amended): the stem and blocks read the weights
  by columns, 32 outputs at a time, each lane still summing in the order the spec fixes. Three
  quarters of the observation and about half of each hidden input are zero after the ReLU. Moves
  1.36× faster in V8; natively the search 1.49×.
- **The proof's nodes got cheaper:** no `Vec` or sort per node, the key hashed eight bytes at a
  time instead of one, walls and scores (constant within a round) left out of it, and no SipHash
  over a key that is already a digest. 2× natively, 1.5× in V8; what remains is half the engine's
  `apply`.

The lane at the default now reads p50 30, p95 368, p99 468 ms against 50, 614, 819 before
([0012 T12-25]), so a higher default or a larger proof cap now fits; either is a new latency
record and the user's call.

## Next

- **Trainer code:** weight averaging (now mostly polish, the dips being small); blending the
  game's result with the search's value as the value target, against early-game noise.
- **Self-play code:** Gumbel search, for better policy targets at low simulation counts;
  restarts from saved round starts; reanalyse.
- **Capacity:** a bigger network once the cheaper ideas run out; it needs a new latency record.
- **Shipping:** the latency record has room (p95 551 ms against 1.5 s), so a shipped move could
  use about twice the simulations. That is a new latency lane, and the user's call.

## Ways of working that this run settled

- **One change per run.** Each run starts from the last one's checkpoint ([Z11-66]) and records what
  differs in `from.changes`.
- **The loop writes, a person commits.** Every milestone is committed with its checkpoint, after
  the suite replays the log.
- **Measure before trusting.** Every speedup was merged only after its samples were shown
  byte-identical on a quiet machine. Every new test was seen to fail on a mutated copy.
- **Watch the yardstick, not only the player.** The ladder's saturation, and the losses' silence,
  each hid real progress for hours.
