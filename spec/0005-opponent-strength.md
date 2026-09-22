---
title: Opponent strength
author: Gabriel Cangussu
date: 2026-09-06
status: implemented
intent: 0003 — Computer opponent
prefix: M5
depends-on: 0001 — Engine core, 0004 — Computer opponent
summary: >
  How we establish that the opponent is any good: the arena that plays fixed
  matches between two players, the reference opponents it measures against, the
  ladder the tiers must satisfy, and the blunder audit. What the bot does
  belongs to 0004 — Computer opponent; this document is only about knowing
  whether it works.
---

# Opponent strength

## Scope

Covers the arena in `packages/bot/arena`: a harness that plays recorded matches between two move
choosers and reports the result, the reference opponents it measures against, the thresholds the
three tiers of [0004 B4-32] must clear, and the audit that looks for blunders rather than losses.

Does not cover how the bot chooses a move (*0004 — Computer opponent*), the rules (*0001 — Engine
core*), or anything the player sees (*0006 — Opponent in the interface*).

This spec stands to *0004* as *0002 — Engine conformance vectors* stands to *0001*: the thing
being built has one document, and how we know it is right has another. The split earns itself
here for the same reason it did there — the harness has a format, a generation procedure, a
committed artifact and a lane of its own, and folding all of that into 0004 would bury the
requirements about *playing* under requirements about *measuring*.

### Correctness and strength are different problems

*0002* can be exact: a recorded game either replays state for state or it does not. Strength
cannot. "Plays well" is a claim about a distribution of games, and the honest form of it is a
winrate over a sample with a stated uncertainty.

One thing makes this far more tractable than it usually is. [0004 B4-30] makes the bot
deterministic, and [M5-4] makes the arena deterministic around it, so **a match is exactly
reproducible**: the same two players over the same seeds play the same games and reach the same
score, every time, on every machine. A threshold is therefore a *regression gate* that either
holds or does not, with no flakiness at all — not a statistical test that fails one run in twenty.

The statistics do not disappear; they move. The confidence interval is no longer about whether the
suite will pass again. It is about whether the conclusion generalises **beyond the recorded
seeds**, which is what [M5-16]'s wide lane is for and what [M5-13]'s narrow one deliberately does
not claim.

### What has already been measured

A prototype of [0004]'s design — the evaluation of [0004 B4-14], negamax with alpha-beta, and the
boundary horizon of [0004 B4-6] — was measured before this spec was written, so the thresholds
below are set from evidence rather than from hope. Seat-alternated, fixed seeds, on the machine of
record:

| Match | Games | Winrate | Mean score |
| --- | --- | --- | --- |
| one-ply eval vs uniformly random | 200 | **100.0%** | 63.6 – 1.1 |
| depth 2 vs one-ply eval | 100 | **76.0%** | 52.6 – 41.6 |
| depth 4 vs one-ply eval | 60 | **93.3%** | 56.3 – 36.7 |
| depth 4 vs depth 2 | 60 | **75.0%** | 41.1 – 33.3 |
| depth 6 vs depth 4 | 40 | **72.5%** | 40.9 – 31.7 |

The ladder is monotone and each rung is worth about the same: every doubling of lookahead buys
roughly 72–76% against the rung below. That is the evidence for [0004 B4-32]'s claim that a horizon
is a real difference in kind.

These are **prototype numbers and are not a baseline**, and they are not what [M5-13]'s thresholds
are set from either — those come from the shipped bot measured against each match's *null*, which
is the table in [M5-13] itself. The prototype figures are kept because they are why this design was
believed worth building before any of it existed. The committed baseline of [M5-15] is produced by
the shipped bot.

## Definitions

| Term | Meaning |
| --- | --- |
| **Chooser** | Anything satisfying `(position: AzulJSON) => Play`, returning a legal action and what it cost. A tier of [0004 B4-32] wrapped with its options is one; so is a reference opponent. |
| **Match** | `n` games between two choosers over a recorded seed list, seats alternated ([M5-3]). |
| **Result** | What a match reports ([M5-6]). |
| **Winrate** | `(wins + draws / 2) / n`, from the first chooser's side. Draws count half because [0001 E1-39] makes them a real outcome rather than an error. |
| **Regret** | For one position, the value of the best move a reference search finds minus the value it assigns the move actually played. Never negative. |
| **Blunder** | A played move whose regret exceeds [M5-19]'s threshold. |

## Data model

```ts
/**
 * What a chooser reports. Richer than an action because [M5-8] and `Result`
 * need it: a bare `=> number` cannot say whether the search was curtailed or
 * how much work it did, and both are things a match must refuse to average
 * over silently.
 */
interface Play {
  action: number;
  /** Nodes expanded. `0` for a reference opponent that does not search. */
  nodes: number;
  /** [0004 B4-29]. A match containing one fails [M5-8]. */
  curtailed: boolean;
  depth: number;
  /** [0004 B4-20]. Without it nothing downstream can tell a search that ran
      out of round from one that ran out of budget. */
  complete: boolean;
}

type Chooser = (position: AzulJSON) => Play;

interface MatchSpec {
  a: Chooser;  b: Chooser;
  /** One per game. Recorded, never generated at run time [M5-4]. */
  seeds: readonly number[];
  /** Fails the match rather than reporting a game that ran away [M5-5]. */
  maxPlies?: number;
}

interface Result {
  games: number;
  /** From `a`'s side. wins + losses + draws === games. */
  wins: number; losses: number; draws: number;
  winrate: number;
  /** One-sided 95% lower bound on the winrate [M5-14]. */
  lowerBound: number;
  meanScore: [number, number];
  /** Games `a` played as seat 0, and as seat 1. Equal within one [M5-3]. */
  seats: [number, number];
  /** Winrate restricted to each seat, so an imbalance is visible [M5-7]. */
  bySeat: [number, number];
  plies: number;
  /** Total nodes each chooser expanded, and wall-clock milliseconds. */
  work: [{ nodes: number; ms: number }, { nodes: number; ms: number }];
  /** Searches stopped by the fail-safe. MUST be zero [M5-8]. */
  curtailed: number;
}
```

## Behaviour

### The arena

- **[M5-1]** The arena MUST drive games through the engine only: `newGame` for the deal,
  `legalActions` and `apply` for every ply, `outcome` for the result. It MUST NOT pose a position
  or edit a state, the same prohibition [0002 V2-3] places on the conformance harness.
- **[M5-2]** A chooser MUST be handed `toJSON` of the position and nothing else, so the arena
  enforces [0004 B4-5] rather than trusting it. A chooser that returns an action outside
  `legalActions` MUST fail the match, naming the seed and the ply.
- **[M5-3]** Seats MUST alternate across the games of a match, and the two counts MUST be equal
  within one. A `Result` MUST report the winrate for each seat separately.

  *Azul is not seat-symmetric — player 0 opens and player 1 holds the reply — so a match played
  from one seat measures the seat as much as the player. Measured, and larger than it sounds: a
  match between two **identical** deterministic players can come out at 62.5% rather than 50%, with
  seat 0 taking about 70% of those games — `easy` and `greedy` both do, while `steady` against
  itself measures 45%, so how large it is depends on the player as well as on the seat. Either way
  a winrate between two copies of one player says nothing about the player.*

- **[M5-4]** The seed list MUST be recorded in the repository, not generated. Any randomness a
  reference opponent needs MUST come from a seeded `Rng` ([0001 E1-46]) whose seed is part of the
  match specification.
- **[M5-5]** A match MUST fail rather than hang if a game exceeds `maxPlies`, defaulting to 400 —
  roughly six times the mean game length.
- **[M5-6]** A match MUST report every field of `Result`, and MUST report the seed of every game
  its first chooser lost. A strength number nobody can drill into is a number nobody can act on.
- **[M5-7]** The arena MUST be deterministic: the same `MatchSpec` MUST produce an identical
  `Result` on any machine and any run, **excluding `work[].ms`**, which is a wall-clock reading and
  can never repeat. A test MUST assert this by running one match twice, with the choosers rebuilt
  for each — a reference opponent carries a generator stream ([M5-9]), so reusing one would have
  the second run continue where the first stopped rather than replay it.
- **[M5-8]** A match in which any search reported `curtailed` ([0004 B4-29]) MUST fail. A curtailed
  search is the one case where [0004 B4-30] does not hold, so a match containing one is not
  reproducible and its number means nothing.

  It follows that a measuring lane MUST push the wall-clock fail-safe out of reach rather than rely
  on it not firing. With the shipped 4000 ms in place this requirement turns the lane into a load
  sensor: on a machine busy with anything else, `sharp` exceeds it, the match throws, and a gate
  fails for a reason that has nothing to do with the bot. Measured — three of the seven gates
  failed exactly that way when the lane shared a machine with the fast suite. The node budget is
  the bound that carries meaning here, and it is the one [M5-13]'s numbers were measured against.

### The reference opponents

- **[M5-9]** The arena MUST provide a **uniform random** chooser: uniform over `legalActions` from
  a seeded `Rng`. It is the floor, and it is a weak one — over 3000 recorded games random play
  averages 3.0 points, because it fills its own floor line.
- **[M5-10]** The arena MUST provide a **greedy** chooser: the position after each legal action,
  valued by [0004 B4-11]'s evaluation, best taken, with no search. It is `easy` ([0004 B4-33]) by
  construction, and naming it separately is deliberate — it is the reference the other tiers are
  measured against, and it MUST remain available even if `easy` is later redefined.
- **[M5-11]** A reference opponent MUST NOT be changed to make a threshold pass. Changing one
  invalidates every recorded number measured against it, and [M5-15]'s baseline MUST be regenerated
  in the same commit.

### The ladder

- **[M5-12]** Each tier MUST beat the tier below it, and every tier MUST beat uniform random. This
  is [0004 B4-36] made into a number.
- **[M5-13]** The **gating** lane MUST assert, over 40 recorded seeds each:

  | Match | Null (self-play) | Measured | Threshold |
  | --- | --- | --- | --- |
  | `easy` vs uniform random | ~50% | 100.0% | ≥ 95% |
  | `steady` vs `easy` | 62.5% | 90.0% | ≥ 70% |
  | `sharp` vs `steady` | 52.5% | 75.0% | ≥ 55% |
  | `sharp` vs `easy` | 62.5% | 97.5% | ≥ 80% |

  Re-measured when [0004 B4-30] was made to break ties on exact values only. Before it, the root
  could take an alpha-beta bound equal to the best value as a tie and play a worse move, and the
  same lane read 88.8%, 66.3% against a 40.0% null, and 92.5%. The thresholds were set from those
  figures and are unchanged.

  Each threshold is set against the match's **null** — the same player against itself over the same
  seeds — because a threshold below its null gates nothing. The `steady` row is why the nulls are
  here: at ≥ 60% it was cleared by substituting `easy` for `steady`, since two identical players
  split 62.5% on seat advantage alone ([M5-3]). The lane MUST print each match's null beside its
  result, so the number a gate has to beat is on screen next to the number it produced.

- **[M5-17]** The gating lane MUST run the tiers at **reduced node budgets**, declared in the lane
  and overridden through `Options.nodes` ([0004 B4-26]), chosen so the whole lane finishes within
  [M5-20]'s budget. It MUST assert the ordering **on the recorded seeds**, and it MUST NOT be
  reported as a measurement of the shipped opponent, nor as establishing the ordering as a fact
  about Azul — that is [M5-16]'s wide lane.

  The distinction is not pedantry. `sharp` over `steady` measured 66.3% with a one-sided 95% lower
  bound near 50%, which did not exclude the two being equal. It now measures 75.0% with a bound of
  62.4%, and that is still forty deals at a reduced budget. What the lane pins is that this bot,
  on these forty deals, is ordered; the self-play null beside it (now 52.5%) is the evidence that
  the horizon buys *something*.

  *An honest proxy, and the reason it needs saying: `sharp` at its shipped 400 000 nodes is about
  1.2 seconds a move ([0004 B4-47]) and a game is about 70 plies, so forty games is roughly an
  hour of wall-clock. That does not belong in a suite anyone runs on save. What the reduced lane
  can still catch is the thing most worth catching — a change that inverts the ladder or breaks a
  tier outright.*

- **[M5-14]** A reported winrate MUST carry a one-sided 95% lower confidence bound, computed by the
  Wilson interval on `wins + draws / 2` over `games`. A threshold in [M5-13] applies to the
  **point estimate**, and the bound MUST be reported beside it.

  *The point estimate, because the match is exactly reproducible ([M5-7]) and there is no sampling
  noise between runs to protect against. The bound is reported because generalisation beyond the
  recorded seeds is a real question, and 40 games answers it loosely: an observed 75% there has a
  lower bound near 62%.*

- **[M5-16]** A **wide** lane MUST exist, run on demand rather than in the suite, playing each
  ladder match over at least 200 recorded seeds at the shipped budgets, and MUST report the same
  `Result` fields. It is what the strength claims in the README and in *0004*'s Performance section
  are allowed to cite.
- **[M5-15]** The wide lane's `Result`s MUST be committed as a **baseline** file, with the bot's
  commit, the seed lists, the budgets and the machine. A change to the bot that moves any winrate
  by more than 5 points MUST update it in the same commit, and the reason MUST be in the commit
  message.

  *The baseline is the memory this project would otherwise not have. Without it "is the bot better
  than it was in March" has no answer, and every eval-weight change is argued from taste.*

### The blunder audit

Intent 0003 asks that the opponent "doesn't blunder in the endgame". That is not a winrate: a
player can win a match and still throw a round away, and a player can lose every game to a stronger
opponent without ever making a mistake worth pointing at.

- **[M5-18]** The arena MUST provide an audit that, over recorded positions, compares the move a
  tier played against the best move found by a **reference search** — `sharp` at ten times its
  node budget, that budget being for valuing the whole position and split across its legal moves —
  and reports the regret distribution: mean, 95th percentile, maximum, and the positions producing
  the worst ones.

  *The split matters and is easy to read the other way: a per-move budget of four million would
  make a twenty-move position cost eighty million nodes, four minutes rather than twelve seconds,
  and would put [M5-31]'s generator out of reach of anyone willing to run it.*
- **[M5-31]** The reference search's per-action values MUST be computed once and **committed
  beside the audit corpus**, and the gating lane MUST read them rather than recompute them. The
  file MUST record the budget and the bot commit that produced it, and a test MUST fail when the
  corpus and the recorded values disagree in length or in position.

  *Without this the audit cannot be gating arithmetic: four million nodes is about 11 seconds a
  position ([0004 B4-47]'s rate), so twenty-five positions would spend [M5-20]'s whole budget on
  the reference alone. Recording it makes the lane compare one cheap search against a fixed number,
  which is the same trade *0002* makes by committing vectors instead of running Python.*

  *It also makes the reference **stale by design**, and that is the correct failure mode: a
  reference regenerated whenever the bot changes measures the bot against itself and would call
  every regression a tie. Regenerating it is a deliberate act with a commit message, like
  [M5-15]'s baseline.*
- **[M5-19]** In the gating lane, `sharp` at its **shipped** budget MUST commit no **decisive
  blunder** — no position where the reference found a certain win and the played move gave it up —
  and over the *scored* positions MUST have a mean regret of no more than 1.5 points. There is
  deliberately **no threshold on the maximum**.

  *Two measures because there are two kinds of mistake and one unit cannot hold both. A terminal
  value carries `WIN` ([0004 B4-13]), so giving up a won game scores about two million; averaged in
  with the rest it drowns every point-sized mistake, and measured that way the mean came out near
  200 000 — a statement about results wearing the units of points.*

  *The numbers were written before the audit existed (5 and 0.5) and are now set from it. Measured
  over the committed corpus: shipped `sharp` 0 decisive / 1.076 mean / 13.66 max; `steady` 1 /
  0.985 / 8.94; `easy` 1 / 1.728 / 8.94; uniform random 2 / 6.588 / 17.33. So 1.5 discriminates
  against a one-ply player where 2 would not. The maximum clause is **dropped** rather than
  loosened: any bar admitting the shipped opponent's 13.66 also admits a player choosing uniformly
  at random, which would be a decoration and not a gate.*

  *Re-measured when [0004 B4-30] was made to break ties on exact values only: `sharp` 0 / 0.557 /
  5.94 over 20 scored positions; `steady` 1 / 0.884 / 8.94; `easy` and random unchanged, as they
  must be, because neither searches past one ply. 7.72 of the 13.66 was that bug, at the same
  position (seed 4242 ply 32). That weakens the argument above for dropping the maximum, since
  5.94 is far below random's 17.33. The clause is still absent, and whether to write one is the
  open question below.*

  *One limit on what "no decisive blunder" establishes, and one thing that is **not** a limit. It
  rests on **three positions** — the corpus holds exactly three where any move is valued as a
  certain win. But those three are fully reliable: every action at each was searched to completion
  (22/22, 16/16 and 4/4), and every winning move in them comes from a completed search, so "the
  reference found a certain win" is a fact there rather than an artifact of a truncated one. The
  caveat is sample size alone. And neither the mean nor the maximum tracks strength: `steady` scores better than
  shipped `sharp` on both. The decisive count is the only clause with power, on a sample that
  small.*
- **[M5-21]** The audit corpus MUST include positions from the last two rounds of recorded games,
  and MUST be recorded rather than sampled at run time.

  *The endgame is named in the intent and is where the bot is most likely to be wrong for a
  structural reason: it is where completing a row ends the game, where eating a floor penalty to
  secure a column can be correct, and where the boundary horizon of [0004 B4-6] is least
  forgiving — because the position past the boundary the bot refuses to look at may be the last
  one of the game.*

- **[M5-20]** The gating lane SHOULD finish in under 5 minutes and MUST run separately from
  `packages/bot`'s fast suite ([0004 B4-60]), which it is excluded from.

### What cannot be measured here

- **[M5-22]** "It beats a casual human player more often than not" MUST NOT be claimed on the
  strength of any number in this document. No chooser here is a human, and a ladder of programs
  measures a ladder of programs.
- **[M5-23]** A human play-test procedure MUST be recorded — the tier, the number of games, the
  seeds, who played, and the result — and its outcome MUST be written down beside the baseline of
  [M5-15]. It is evidence, not a test, and it MUST NOT gate a build.

  *Recorded rather than skipped, because it is the criterion the intent actually leads with, and
  the alternative to writing down a handful of honest games is quietly substituting a proxy nobody
  agreed to.*

## Invariants

- **[M5-24]** `wins + losses + draws === games` in every `Result`, and `winrate` equals
  `(wins + draws / 2) / games`.
- **[M5-25]** Every ply of every arena game was a member of `legalActions` at the position it was
  played from, and every game ended in a state satisfying the engine's census invariant
  ([0001 E1-40]).
- **[M5-26]** Regret is never negative: the reference search's best value is greater than or equal
  to the value it assigns any legal move, including the one played.

## Verification

- **[M5-27]** The suite MUST assert [M5-7] by running one small match twice and comparing the
  whole `Result`, and [M5-2] by running a deliberately illegal chooser and expecting the failure to
  name the seed and the ply.
- **[M5-28]** The suite MUST assert [M5-24], [M5-25] and [M5-26] over a small recorded match, and
  MUST assert [M5-3] by checking the seat counts of a match with an odd number of games.
- **[M5-29]** The suite MUST assert the Wilson bound of [M5-14] against hand-computed values,
  including the degenerate cases of 0 and `games` wins.
- **[M5-30]** Every requirement in this document MUST be either cited by at least one test, by
  identifier, or listed with a reason in the *Traceability exemptions* table, enforced exactly as
  [0003 U3-76] and [0004 B4-59] are.
- **[M5-32]** `bot`'s manifest MUST export the arena as `bot/arena`, so another workspace package
  can run a match. No existing test or behaviour changes; one test is added, for the export itself.

  *Added by [0008 A8-30]: the expert's gate plays it against `sharp` one single-seed match at a
  time, and a second copy of the match harness would be a second answer to "how strong is it".
  Exporting the arena is what keeps there being one.*

### Traceability exemptions

| Requirement | Why it is not testable |
| --- | --- |
| [M5-11] | A process promise about how a failing threshold is responded to. No run of the suite can see whether a reference opponent was changed for the right reason. |
| [M5-16], [M5-15] | Properties of a lane the suite does not run and of an artifact it does not produce. The baseline's *format* is checked when it is read; that it is kept current is a process promise. |
| [M5-20] | A `SHOULD` about the lane's own runtime. |
| [M5-22], [M5-23] | Statements about what may be claimed, and a procedure involving a human. The suite has no human and no claims. |

### What is not checked here

The arena's own source is scanned by nothing. [0004 B4-51]'s source check reads `packages/bot/src`
only, so `arena/` could grow a re-implemented rule — a penalty ladder, a wall stride, a second
reading of [0001 E1-38] — without tripping anything. That is accepted rather than fixed: this is
measurement code, it ships nowhere, and a second scanner over it would cost more than the risk. It
is written down so the next person to add strength arithmetic here knows the tripwire they are
used to is absent.

## Open questions

- **Is a winrate the right unit at all?** An Elo-style rating over the whole ladder would make
  "how much stronger is `sharp` than `steady`" a single number and would let a new candidate be
  placed without playing every rung. It needs many more games to be stable, and this spec starts
  with pairwise winrates because they are what the thresholds of [M5-13] need. If the ladder grows
  past three rungs, revisit.
- **Should the audit's reference be the bot itself at ten times the budget?** It measures regret
  against a deeper version of the same evaluation, so a systematic error in the evaluation is
  invisible to it — both searches share the blind spot. A second, independently-weighted evaluation
  would catch that, and nothing else here would.
- **The audit cannot rank a terminal fact against a heuristic guess, and roughly 40% of the corpus
  is such a pair.** A move that ends the game carries `±WIN`; a move that merely postpones it
  carries a guess. Comparing them says nothing, and comparing them anyway was the audit's most
  misleading output: at one recorded position the reference rates its best move at −1 and a
  game-ending move at −1 000 002, which reads as every tier throwing the game away — the shipped
  `sharp` included.

  It is **not** the round-boundary horizon. That was the first explanation and it is wrong: the
  reference calls the same search, so [0004 B4-6] applies to both sides and cancels in the
  difference. It is the reference's *depth*. Across the three positions, none of the alternatives
  valued as still-a-game had a completed search (0 of 23, 0 of 12, 0 of 7) while some of the moves
  condemned as losses did (1 of 9, 3 of 28, 0 of 24), and the two groups sat about a ply apart. The
  guess-valued alternatives are simply shallower searches that had not reached the terminal yet.

  Those pairs are counted apart — `hopeless` (every move already a certain loss), `heldOn` (the
  played move won too), and `condemned` (the reference rated the played move a loss and did not
  finish searching the alternatives) — and nothing gates on any of them. Honest, but it leaves the
  endgame, the thing intent 0003 names, measured on barely half the corpus. Closing it needs a
  reference deep enough that its guesses are worth something at a wide root, which is the next
  question below.
- **The reference is weakest exactly where the corpus's regret lives.** At the wide roots that
  produce every non-zero regret it gets 74 000–129 000 nodes per move and completes almost nothing;
  at the narrow late-round positions it completes easily and regret is 0.00. Overall it finishes
  261 of 743 searches. An oracle sharpest where nothing is at stake is a real limit on [M5-18], and
  it is the same limit as the 13.66 below. The corpus records per action whether the reference
  finished ([M5-31]) — recorded, and not yet used to filter anything, which is the cheapest
  available improvement to this instrument.
- **Regret tracks the branching factor, not the endgame, and the 13.66 outlier is unexplained.**
  Over the scored positions: eight with 30 or more legal moves average 2.357 and hold the 13.66
  maximum; eleven with fewer average 0.144 and top out at 1.36. Eleven of nineteen score exactly
  zero. The horizon does **not** explain it — the reference calls the same search, so [0004 B4-6]
  applies to both sides and cancels in the difference. What does not cancel is depth: at a 46-move
  root the reference gets about 87 000 nodes per move against `sharp`'s 400 000 spread across all
  of them, roughly ten times deeper into the same tree. So the maximum is measuring the *player*,
  and whether 13.66 is an evaluation weakness or just "400 000 is not 4 000 000 at a wide root" is
  open. It is not a tail of the distribution — the 95th percentile is 2.02 — it is a different
  animal, and it should be opened before any threshold is written around it.

  *Partly opened since.* Most of it was neither the evaluation nor the budget. It was the root
  taking an alpha-beta bound as a tie ([0004 B4-30]). With that fixed, the same position gives up
  5.94, the mean falls from 1.076 to 0.557, and the figures in this paragraph describe the search
  before the fix. What remains of 5.94 is the question above, at a smaller size.
- **How many recorded seeds is enough for [M5-15]'s baseline to be a useful memory?** 200 puts the
  95% bound roughly ±6 points around a 75% winrate, which is wide enough that a genuine 4-point
  improvement is invisible. The answer is probably "more, run overnight", and the question is
  whether that is worth the wall-clock.

## References

- Intent [0003 — Computer opponent](../intent/0003-computer-opponent.md)
- Spec [0001 — Engine core](0001-engine-core.md)
- Spec [0002 — Engine conformance vectors](0002-engine-conformance-vectors.md) — the model for this split
- Spec [0004 — Computer opponent](0004-computer-opponent.md)
