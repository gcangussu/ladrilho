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

**Not worth doing: an engine call that skips the deal at a round's end.** Measured as an upper
bound — the deal skipped while the proof runs, exhaustion still decided — it saves 4.7% of the
proof natively and about 6% in V8, with every verdict the same: of the 20.9M moves the proof tries
on the corpus, 72% stay within the round, 26% end the game (scored, never dealt) and only 1.7%
deal. About 7 ms on the slowest moves, for a second way to end a round in the engine.

**Not worth doing: speculative batches in the search.** Evaluating likely next leaves beside the
pending one, memo-only and so exact, pays only if a batch is cheap and its guesses are used. In V8
neither holds: four inputs through the batched pass cost exactly four single passes (the single
pass is bound by arithmetic there, not memory), and a pair kernel sharing column reads over the
union of two inputs' non-zeros cost 2.19 singles (1.76 natively). Replaying the corpus searches,
3 siblings by prior were used 37% of the time and the top sibling alone 62%, so a pair must cost
under 1.54 singles to break even.

**Not worth doing: move ordering in the proof.** On the 407 positions where it runs, at 300,000
nodes, the transposition table's move first left the node count unchanged (30 out of nodes,
1.053M nodes on the 332 every variant finished); a history heuristic (76 out of nodes) and a
static Azul order, fewest tiles to the floor first (31), did worse. Proving a move is not a forced
win means refuting every reply, which no order shortens. And the cap costs little: given 20M
nodes, all 30 finished (0.31M to 14.7M, most under 1.7M), and only one changed its move.

The optimisation effort stops here (10-05); the headroom it bought is the user's to spend.

## What simulations and the endgame cap buy; the browser's maximum stays 200 000 (10-22)

After the 10-21 memory layout, a search keeps about 0.29 KB a simulation, so memory no longer
bounds the browser's maximum ([0012 T12-16]): at 1 000 000 the module held 290 MB and took
41.3 s on the heaviest corpus position (498), 198 MB on the slowest at the default (501), and
five 1M searches in turn on one module stayed at 290 MB. The games below decided it instead:
the maximum stays 200 000. The four slowest 1M moves of the games below, replayed in
the module alone, held 165 to 189 MB and took 24 to 28 s.

`twelfth`/120 with the shipped proof cap (300 000) against itself at 100 simulations, natively
through `serve`, 30 wide seeds from both seats, 60 games each:

| Subject | Points | 95% interval | Elo vs 100 | Seeds won both / one / neither |
| --- | --- | --- | --- | --- |
| 1 000 | 48/60 (80.0%) | 68–88% | +241 | 19 / 10 / 1 |
| 10 000 | 50/60 (83.3%) | 72–91% | +280 | 21 / 5 / 2 |
| 100 000 | 53/60 (88.3%) | 78–94% | +352 | 24 / 2 / 2 |
| 1 000 000 | 52/60 (86.7%) | 76–93% | +325 | 23 / 3 / 2 |

Above 1 000 the yardstick saturates: against a player this much weaker, the deal decides what
is left, and 60 games cannot tell 10 000, 100 000 and 1 000 000 apart. Those games ran eight at
a time on four physical cores, so their move times are not kept.

So the larger settings played the default instead, same seeds and seats, one game at a time
(load average 2.5 to 3.5 from the rest of the machine):

| Subject vs 10 000 | Points | 95% interval | Elo | As first / second | Seeds 2 / 1 / 0 points | Mean margin |
| --- | --- | --- | --- | --- | --- | --- |
| 100 000 | 37.5/60 (62.5%) | 50–74% | +89 | 78% / 47% | 10 / 16 / 3 | +2.6 ± 1.3 |
| 1 000 000 | 37.5/60 (62.5%) | 50–74% | +89 | 82% / 43% | 8 / 21 / 0 | +1.4 ± 1.3 |

And the two against each other, the same way:

| Subject | Points | 95% interval | Elo | As first / second | Seeds 2 / 1 / 0 points | Mean margin |
| --- | --- | --- | --- | --- | --- | --- |
| 200 000 vs 100 000 | 34/60 (56.7%) | 44–68% | +47 | 68% / 45% | 9 / 16 / 5 | +0.9 ± 1.5 |
| 500 000 vs 100 000 | 30/60 (50.0%) | 38–62% | 0 | 62% / 38% | 6 / 18 / 6 | +0.8 ± 1.4 |
| 1 000 000 vs 100 000 | 28/60 (46.7%) | 35–59% | −23 | 58% / 35% | 6 / 16 / 8 | +0.0 ± 1.3 |

| Native move, ms | mean | p50 | p90 | p99 | max | per game |
| --- | --- | --- | --- | --- | --- | --- |
| 10 000 | 49 | 8 | 179 | 309 | 684 | 1.4 s |
| 100 000 | 175 | 38 | 555 | 1 551 | 2 265 | 4.8 s |
| 200 000 | 279 | 74 | 802 | 2 888 | 4 497 | 7.8 s |
| 500 000 | 518 | 166 | 1 245 | 5 743 | 10 198 | 14.5 s |
| 1 000 000 | 938 | 341 | 1 969 | 10 930 | 16 448 | 26.2 s |

Ten times the default buys about +90 Elo, at the edge of what 60 games resolve; a hundred times
buys nothing more that they can see, for five times the thinking. Against 100 000 directly,
200 000, 500 000 and 1 000 000 score 57%, 50% and 47%: the strength stops at 100 000 to
200 000, which points at the network, not the search, as what limits it there. Most of the gain is from the
first seat: from the second, either is level with the default. The module is about 1.5 times
slower than the native player: four of the 1M series' slowest positions took 15 to 19 s natively
alone and 24 to 28 s in the module, choosing the same moves. So 1 000 000 would be a setting for
the patient, not a stronger one than 100 000 on this evidence.

### The endgame proof's cap, swept (10-22)

At the default, the shipped cap (300 000) against 400 000, 400 000 against 500 000, and so on to
1 000 000, 100 games each on 50 wide seeds from both seats, one game at a time. Every match
scored exactly 50/100, and every one of the 700 games was move for move the lower cap's game
against itself: no cap from 300 000 to 1 000 000 changed a move on those seeds. The knob does
reach the process: with the proof off, 4 of the 50 self-play games differ from the 300 000 ones
(and 3 at 100 000; 100 000 and 200 000 play the same games). The first seat took 34.5 of those
50 games, so a first-seat edge near 69% is what the seat splits above are read against.

Played on all 1 978 non-terminal corpus positions natively, the move changes from cap 0 to
300 000 on 3 positions, from 300 000 to 1 000 000 on 1 more (1073), and from 1 000 000 to
2 000 000 on none. The module's lane, rerun at higher caps, now passes where it failed on 10-05:
at 400 000, 500 000 and 600 000, max 689, 663 and 687 ms at the default and 31 MB after the
corpus (19 MB at 300 000); the cheaper proof of 10-05 and 10-21 has made the room. So a larger
cap is affordable and worth nothing measurable; the shipped 300 000 stands.

## Why the second seat loses and simulations stop paying: diagnostics (10-22)

Two questions after the sweep above: could training help the player from the second seat, and why
does strength stop near 100 000 simulations? Three measurements of `twelfth`/120, none of them a
run. The scripts are not kept: the tree walk below was added to a `git archive` copy of the crate,
never to this one.

**The seat split, from self-play.** The 60 000 games of `twelfth`'s generations 111 to 130
(1 000 simulations, noise, `tempPlies` 10), each game's seats told apart by its aux records
(final walls and margin; one game in 3 000 ends with identical walls, so the margin is needed too):

| First seat | Wins | Draws | Losses | Points | Mean margin |
| --- | --- | --- | --- | --- | --- |
| 60 000 games | 33 960 | 2 094 | 23 946 | 58.4% ± 0.4% | +2.1 (sd 10.7) |

So between equal players the first seat is worth about 58%. The 69% of the cap sweep was 50 games,
±13%, and agrees with this.

**The value head by seat.** `twelfth`/120's value on every move sample of those games (3.3M), against
each sample's result:

| Seat | Samples | Mean value | Mean result | Bias | Squared error |
| --- | --- | --- | --- | --- | --- |
| first | 1 664 747 | +0.150 | +0.165 | −0.016 | 0.701 |
| second | 1 637 800 | −0.183 | −0.168 | −0.015 | 0.696 |

In every tenth of the value's range, from −1 to 1, the mean result is within 0.03 of the mean
value, for both seats alike. The head even predicts the first seat's edge at ply 0 (+0.167 against
a mean result of +0.167). Only 7.7% of the second seat's samples are valued below −0.9 (3.4% of
the first's), so a search that cannot tell its moves apart because all of them look lost is rare.
Its squared error against the result by round is 0.915, 0.842, 0.748, 0.606 and 0.368 (the first
seat's; the second's within 0.004), against about 0.94 for the best constant. That reads as a head
that knows little of the early game, and was first written here as "in round 1 it barely beats the
seat's prior". It is mostly the result's own noise instead: measured against the win probability
itself, on the panel further down, the head is nearly right in round 1 (error 0.022) and worst in
the last rounds (0.21 and 0.30).

So the second seat's deficit is the game's, at this level, and the value is honest about it. A
training change aimed at the second seat would be correcting an error the network does not make.

**The search at 10 000, 100 000 and 1 000 000** on all 1 978 non-terminal positions of
`latency/corpus.bin`, with the shipped proof cap (300 000), cpuct 1.25 and fpu 0.25:

| Move after the proof differs | 10 000 → 100 000 | 100 000 → 1 000 000 |
| --- | --- | --- |
| all positions | 186 (9.4%) | 127 (6.4%) |
| 16–20 tiles left in the round | 112 of 611 (18.3%) | 79 (12.9%) |
| 8–15 | 66 of 760 (8.7%) | 45 (5.9%) |
| 0–7 | 8 of 607 (1.3%) | 3 (0.5%) |

Where 1 000 000 chooses differently it is usually 100 000's second choice (77 of 127), the move
it replaces held a median 60% of 100 000's visits, and the root value moves by a median 0.010
there (0.0015 over all positions): near-ties settled the other way, not errors found.

What the extra simulations do: the share that end at a terminal or boundary leaf **already valued**,
so that nothing new reaches the network, medians by phase of the round:

| Tiles left in the round | 10 000 | 100 000 | 1 000 000 | New nodes at 1 000 000 |
| --- | --- | --- | --- | --- |
| 16–20 | 40% | 81% | 96% | 32 786 |
| 8–15 | 94% | 98.9% | 99.8% | 1 256 |
| 0–7 | 99.9% | 100% | 100% | 5 |

The principal variation ends at a leaf in 97.4%, 98.9% and 99.7% of the searches. The search stops
at the round's boundary ([Z11-15]), and by 100 000 simulations it has reached nearly every line up
to there: from mid-round on, even 10 000 has. Past that point a simulation only averages boundary
values the network has already given. So the plateau of the sweep is a horizon, not a search that
needs more time: strength there is the boundary value's. (Where that value is weakest was first
written here as early in the game; the panel below measured it, and it is the late game.)

**What this rules out and points to:**

- Out: training changes aimed at the second seat, and a larger simulation budget. One million
  simulations is 96% to 100% repeats.
- In: a better boundary value. That means capacity, or value targets carrying less of the deal's
  noise (reanalyse, or blending the search's value into the target, already under *Next*). Or
  looking past the boundary, over deals sampled from the bag's public counts, which is a change to
  [Z11-15]'s rule and the user's call.
- Tried the same day, both below: a score term from the margin head in the search's leaf values
  (dropped), and the search's value blended into the value target (a small gain in the value, none
  in play).

### A score term in the search, tried (10-22)

The one cheap idea left for the second seat was KataGo's score utility: value every leaf as
`(1 − λ)·v + λ·tanh(m)`, where `m` is [Z11-67]'s margin head over 20 points (the real final
margin at a terminal leaf). The idea is that a search behind on the result still prefers losing by
less, which is where comebacks start. The proof stays on win, draw and loss. This needed no
training, but the head is never exported, so it ran in a `git archive` copy of the crate, with
`twelfth`'s `aux/120.pt` head written beside the checkpoint. The copy is not kept.

**The head is worth using.** On generations 111 to 130 it explains 34% of the final margin's
variance, against 8% for the best line through the current score difference: 7% in round 1, 29%
in round 3, 73% in round 5. Where the value is near-certain (|v| > 0.9) it still correlates 0.64
with the real margin, so it does separate positions the value cannot.

**Checked before playing.** The copy's head gives PyTorch's output within 7.6e-7 on the 64 parity
inputs. At λ = 0 the copy chose the shipped search's 10 000-simulation move on all 1 978 corpus
positions; at λ = 0.1 it changed 70 of them.

**The matches.** Each λ against λ = 0, at 10 000 simulations with the proof's cap of 300 000, the
first 100 wide seeds from both seats, natively:

| λ | Points | 95% interval | As first / second | Seeds 2 / 1 / 0 points | Mean margin |
| --- | --- | --- | --- | --- | --- |
| 0.05 | 98.5/200 (49.2%) | 42–56% | 58.5% / 40.0% | 8 / 83 / 9 | +1.24 ± 0.56 |
| 0.1 | 102/200 (51.0%) | 44–58% | 62.5% / 39.5% | 12 / 78 / 10 | +1.99 ± 0.56 |
| 0.2 | 97/200 (48.5%) | 42–55% | 56.5% / 40.5% | 12 / 73 / 15 | +2.23 ± 0.55 |

The term does what it says: the final margin moves by one to two points, two to four standard
errors. The result does not move. Every λ is level with the shipped player, and from the second
seat each scores about 40%, against 41.6% for the second seat in self-play. Games the subject trailed
by 10 or more after three rounds number only 11 to 14 per λ, too few to show a comeback effect.

So the term buys points, not wins, as the diagnostics above predicted: the value is not flat when
behind, and the second seat's deficit is the game's. Dropped. It would also have cost two spec
changes to ship: exporting the head ([Z11-67] says it is never exported, so it would need its own
parity check, like [Z11-13]), and the search's leaf values.

### The search's value in the value target, screened (10-22)

The value target is the game's result `z` ([Z11-29]), and early in a game that is mostly the later
deals' noise. Self-play already computes a quieter estimate and discards it: each move's root value
`q`. The idea was to train on `(1 − α)·z + α·q`. All of it ran in a `git archive` copy of the crate
whose self-play also writes each record's `q` beside the sample file (NaN for a boundary sample).
Its sample and aux files were checked byte for byte against the shipped `selfplay` on 256 games
first. The copy, the data and the scripts are not kept.

**A panel with the win probability measured.** The usual yardstick, the error against `z` on fresh
games, ranks any two networks fairly, since `z`'s noise is the same for both. It does not say how
far either is from the truth, or how noisy `z` is. So: 2 000 positions from held-out self-play
(generation 9001, one searched ply a game, chosen uniformly), each replayed 16 times to the end by
self-play's own player, with the displays as dealt and the bag's hidden order reshuffled. A
position's replays give `p̂`, its estimated win probability, and their spread gives `σ_z²`, the
result's noise. The replays are faithful: the real games' results sit at a mean squared distance
of 0.607 from `p̂`, against 0.588 predicted, and the means agree (−0.018 and −0.006).

**The best α.** If `z`'s noise and `q`'s error are independent, the blended target's error is
`(1 − α)²·σ_z² + α²·ε_q²`, least at `α* = σ_z² / (σ_z² + ε_q²)`. Here `ε_q²` is `q`'s error against
`p̂`, less `p̂`'s own noise. For the value `v` and the two kinds of search:

| Round | `σ_z²` | Error of `v` | of cheap `q` (200) | of full `q` (1 000) | α\* cheap | α\* full |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.899 | 0.022 | 0.006 | 0.006 | 0.99 | 0.99 |
| 2 | 0.815 | 0.038 | 0.024 | 0.022 | 0.97 | 0.97 |
| 3 | 0.648 | 0.087 | 0.044 | 0.040 | 0.94 | 0.94 |
| 4 | 0.390 | 0.212 | 0.145 | 0.140 | 0.73 | 0.74 |
| 5 | 0.054 | 0.302 | 0.129 | 0.075 | 0.29 (0.21–0.38) | 0.42 (0.33–0.50) |

(Bootstrap intervals for α\* are about ±0.02 in rounds 1 to 3 and ±0.05 in round 4.) So α\* is
about the round, and only in the last does the search's size matter. Within a round it barely moves.
And the column that matters most is `v`'s: the head is close to the truth early, where `p` hardly
varies from position to position and `z` is almost all noise. It is worst in the last two rounds,
where `z` is nearly settled. There even a full search, which reaches the game's real end, cuts the
error from 0.30 to 0.075. That is a gap in what the network has learned about the end of the game,
not noise in its target.

**The screen.** Ten generations of 3 000 games from `twelfth`/120 with `q` recorded (9100 to
9109, 1.77M samples). Five fine-tunes of `twelfth`/120 on them, each 10 000 steps of [Z11-28]
step 3 as `twelfth` ran it: its optimiser state, aux heads and augmentation, from one seed so every
variant drew the same batches. The learning rate was 0.0005, ten times `twelfth`'s, so 10 000 steps
could show a difference. Judged on 3 000 held-out games (generation 9200), on the panel, and in
800 games at 200 simulations without the proof, the first 400 wide seeds from both seats, against
the control:

| Variant | α | Error vs `z`, held out | Error vs `p`, panel | Against the control |
| --- | --- | --- | --- | --- |
| `twelfth`/120 | – | −0.0065 (−0.0093 to −0.0038) | −0.0109 (−0.0170 to −0.0053) | the control scored 45.1% (−34 ± 24 Elo) |
| α 0.5 | 0.5 | −0.0031 (−0.0042 to −0.0020) | −0.0046 (−0.0074 to −0.0022) | 51.0% (+7 ± 24) |
| α 0.9 | 0.9 | −0.0029 (−0.0049 to −0.0010) | −0.0062 (−0.0105 to −0.0023) | 50.2% (+2) |
| α\* by round | the table's | −0.0034 (−0.0052 to −0.0018) | −0.0054 (−0.0086 to −0.0021) | 49.1% (−7) |
| α\* by round, at most 0.8 | | −0.0034 (−0.0049 to −0.0019) | −0.0055 (−0.0086 to −0.0026) | 50.7% (+5) |

The errors are differences from the control (α = 0), with 95% bootstrap intervals by game and by
position. The control's own errors are 0.7022 and 0.1478.

- **The fine-tune itself does harm:** the control lost 34 Elo to `twelfth`/120. So the screen can
  rank targets against each other, never against the current player.
- **Every blend's value beats the control's,** every interval clear of zero, in rounds 1 to 3 as
  well as overall. By about half of what the fine-tune cost, though, and the four blends cannot
  be told apart.
- **The blends are underconfident on losing positions:** a value of −0.49 ends at −0.53 to −0.55
  (the control's −0.50 ends at −0.49). It fits `q`'s small positive bias on the panel, about
  +0.02 in rounds 1 and 4: the search takes the mover's best replies, so its root value sits a little above
  the truth.
- **In play none of it shows:** every blend is level with the control, within ±24 Elo.

So the target is quieter, as intended, but the noise it removes was never what limited the value.
The value's real error is the late game's, where the result's noise is smallest. The next lever is
there: which end-of-game features the head gets wrong (the panel can say), weighting late-round
samples, or capacity. Blending stays a possible companion to whichever of those, not a run of its own.

## The boundary into the final round: what it costs, and what fixes it (10-22 to 10-23)

An overnight session, decided without the user, with the plan reviewed by a second agent before
it ran. Every measurement is of `twelfth`/120, in `git archive` copies of the crate and scratch
scripts that are not kept. None of it changes the repo except this entry.

**Where the value is wrong.** A second panel, of 2 000 pre-deal views from held-out self-play
(generation 9002), each replayed 16 times from the round's last move with the bag reshuffled
(faithful: 0.707 against 0.721 predicted). The head's error against `p`, and that of a search past
the boundary (the boundary move played on sampled deals, each searched at 1 000 simulations,
averaged), by the round about to be dealt:

| Boundary into round | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- |
| head | 0.005 | 0.009 | 0.037 | **0.155** |
| 1 deal searched | 0.028 | 0.042 | 0.064 | 0.111 |
| 8 deals searched | 0.003 | 0.003 | 0.024 | **0.048** |

Only the boundary into the last round is badly wrong, and every round-4 decision rests on it. A
linear recalibration of the head gets 0.154 there, so it is not calibration.

**Why the head is wrong there.**
- **No overfitting.** Its error against `z` on the generations it trained on (110 to 119) and on
  held-out generation 9200 agrees in every round (gaps within ±0.02). It underfits the late game.
- **The trunk's features don't carry it.** A 4× larger value head on frozen features fits rounds 4
  and 5 no better (0.31 against 0.30). A fresh 512-wide network on the raw input memorises
  instead (training 0.32, held-out 0.93).
- **It isn't the bonuses.** Bonus gaps, near-complete rows, columns and colours, whether the game
  ends this round, floor penalties and score difference explain 1–4% of the error (R²). What it
  misses is how the rest of the round plays out.

**What fixing it would buy (Step 0).** 621 round-4 positions from 160 held-out games, each
searched at the default (10 000 simulations, the proof at 300 000). Each was searched as
shipped, and again with every boundary leaf into round 5 valued by the 8-deal search. Where the
moves differed, each move was scored by 16 replays with common reshuffle seeds:

| Phase of round 4 | Positions | Over the 300-leaf cap | Moves differ | Gain in `p` per decision |
| --- | --- | --- | --- | --- |
| 0–7 tiles left | 301 | 1 | 53 (18%) | +0.031 (+0.013 to +0.050) |
| 8–15 | 160 | 27 | 47 (35%) | +0.025 (−0.021 to +0.075) |
| 16–20 | 160 | 66 | 22 (23%) | +0.049 (+0.003 to +0.098) |

Summed over the 5.5 round-4 decisions a seat makes in a game, that is **+0.094 in expected score,
about +65 Elo (+17 to +115)**. Positions over the cap count as no gain. So the boundary is worth
fixing; the plan's threshold was 30.

**A cheap search past it: policy rollouts.** One greedy rollout of the policy head per sampled deal
is about 10 network calls. Its ±1 result is noisy, but its final margin is not: `p` at this boundary
is nearly a function of the expected margin. So each estimate below is the head blended with
`2Φ(m̄/σ) − 1` of the rollouts' mean margin, with σ and the weight cross-validated on the panel:

| Valuing the boundary into round 5 | Network calls | Error vs `p` |
| --- | --- | --- |
| the head | 1 | 0.155 |
| head and 4 rollouts | about 40 | 0.105 |
| **head and 16 rollouts** | **about 160** | **0.066** |
| head and 16 rollouts of 20-simulation searches | about 3 300 | 0.047 |
| 8 deals, 1 000-simulation searches | about 8 000 | 0.048 |

With 16 rollouts (σ 3.5 points, weight 0.625) in Step 0, on the same 621 positions, the gain was
**+54 Elo (+13 to +97)**; 4 rollouts gave −17 (−61 to +24).

**In games.** One seat valued the boundary into round 5 that way on its round-4 moves; every other
move, and the other seat, played as shipped, at 10 000 simulations, on the first 500 wide seeds
from both seats:

| Games | Points | 95% interval | Elo | As first / second | Seeds 2 / 1 / 0 points |
| --- | --- | --- | --- | --- | --- |
| 1 000 | 536 (53.6%) | 50.5–56.7% | **+25 (+3 to +47)** | 64.3% / 42.9% | 73 / 383 / 44 |

The first 400 games scored +30 and the next 600 +22. It changed 1.7 of a seat's 5.5 round-4 moves
a game, and valued about 830 boundary leaves a game.

**But it is too slow to ship.** Single-threaded on the 398 round-4 positions of the latency corpus,
on a quiet machine:

| | p50 | p95 | max |
| --- | --- | --- | --- |
| shipped | 30 ms | 450 ms | 524 ms |
| with 16 rollouts | 945 ms | 7 061 ms | 14 480 ms |

That is about 16 times the thinking on those moves, for +25 Elo. Ten times the simulations bought
+89 for about 3.5 times the time. So as a play-time change it loses to simply searching more,
unless it lifts the ceiling that more search hits. At 100 000 simulations for both seats it scored
208.5 of 400 (52.1%, **+15, −19 to +49**; 63.0% / 41.2% by seat), valuing about 3 000 boundary
leaves a game. That is no measurable lift at this sample size: consistent with the +25 at 10 000,
and not told apart from nothing.

**Distilling it into the network, screened: inconclusive.** Seven fine-tunes of `twelfth`/120,
20 000 steps on `twelfth`'s generations 100 to 119 and the recorded 9100 to 9109 (5.3M samples,
the same batches for all). The old tensors stayed at `twelfth`'s 5e-5; the new blocks of the
6-block arms, identity-initialised, ran at 5e-4. The arms crossed 4 or 6 blocks with three
targets for the 30 000 boundary samples into round 5: `z`, the recorded root value of round 5's
first move (free; α 0.7), or the 8-deal search (α 0.9). A seventh added a boundary weight of 3
to the free target. Against the 4-block `z` control, nothing moved:
- every arm was within ±0.0006 of it on the boundary into round 5;
- the weighted arm was −0.0018 (−0.0035 to −0.0001);
- the 6-block arms fitted rounds 4 and 5 no better in training (+0.0002), and their new blocks
  carried only 1.2–1.5% of the residual stream.

At this learning rate 20 000 steps barely move the network, and 30 000 targets are 0.6% of the
samples. So this neither shows that capacity or better targets fail nor that they work. A real
test needs far more final-boundary positions or a run.

**Weight averaging, tried: nothing.** The mean of `twelfth`'s checkpoints 60 to 170, and of 100 to
170. Their value improved slightly on the panels (held-out error −0.0019 in rounds 4 and 5, its
interval clear of zero), but in 2 000 games each against `twelfth`/120 at 200 simulations they
scored 51.2% (+9, −7 to +24) and 50.5% (+4, −11 to +19).

## Next

- **The boundary into the final round** is where the value limits play: fixing it is worth up to
  about +65 Elo (10-23). Two routes:
  - teach the network a sampled-deal estimate there, which needs far more final-boundary
    positions than self-play's one a game: harvested from search trees or from restarts at
    round 4, each labelled by rollouts or searches on sampled deals;
  - or a cheaper search past it in play than 16 rollouts at every leaf, for example only at the
    leaves the search keeps revisiting. That is a change to [Z11-15] and the user's call.
- **Tried and dropped (10-22, 10-23):** weight averaging, blending the search's value into
  move samples' targets, a margin score term.
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
