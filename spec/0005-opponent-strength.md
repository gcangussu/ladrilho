---
title: Opponent strength
author: Gabriel Cangussu
date: 2026-09-06
status: draft
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
roughly 72–76% against the rung below. That is the evidence for [0004 B4-32]'s claim that a
horizon is a real difference in kind, and it is why [M5-13]'s thresholds are set at 60% and 80% —
comfortably under what was measured, so a threshold failure means a regression rather than noise.

These are **prototype numbers and are not a baseline**. The committed baseline of [M5-15] is
produced by the shipped bot.

## Definitions

| Term | Meaning |
| --- | --- |
| **Chooser** | Anything satisfying `(position: AzulJSON) => number`, returning a legal action. A tier of [0004 B4-32] wrapped with its options is one; so is a reference opponent. |
| **Match** | `n` games between two choosers over a recorded seed list, seats alternated ([M5-3]). |
| **Result** | What a match reports ([M5-6]). |
| **Winrate** | `(wins + draws / 2) / n`, from the first chooser's side. Draws count half because [0001 E1-39] makes them a real outcome rather than an error. |
| **Regret** | For one position, the value of the best move a reference search finds minus the value it assigns the move actually played. Never negative. |
| **Blunder** | A played move whose regret exceeds [M5-19]'s threshold. |

## Data model

```ts
type Chooser = (position: AzulJSON) => number;

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
  from one seat measures the seat as much as the player.*

- **[M5-4]** The seed list MUST be recorded in the repository, not generated. Any randomness a
  reference opponent needs MUST come from a seeded `Rng` ([0001 E1-46]) whose seed is part of the
  match specification.
- **[M5-5]** A match MUST fail rather than hang if a game exceeds `maxPlies`, defaulting to 400 —
  roughly six times the mean game length.
- **[M5-6]** A match MUST report every field of `Result`, and MUST report the seed of every game
  its first chooser lost. A strength number nobody can drill into is a number nobody can act on.
- **[M5-7]** The arena MUST be deterministic: the same `MatchSpec` MUST produce a byte-identical
  `Result` on any machine and any run. A test MUST assert this by running one match twice.
- **[M5-8]** A match in which any search reported `curtailed` ([0004 B4-29]) MUST fail. A curtailed
  search is the one case where [0004 B4-30] does not hold, so a match containing one is not
  reproducible and its number means nothing.

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

  | Match | Threshold |
  | --- | --- |
  | `easy` vs uniform random | ≥ 95% |
  | `steady` vs `easy` | ≥ 60% |
  | `sharp` vs `steady` | ≥ 60% |
  | `sharp` vs `easy` | ≥ 80% |

  Every threshold sits well under what the prototype measured, so a failure is a regression and
  not a close call.

- **[M5-17]** The gating lane MUST run the tiers at **reduced node budgets**, declared in the lane
  and overridden through `Options.nodes` ([0004 B4-26]), chosen so the whole lane finishes within
  [M5-20]'s budget. It MUST assert the ordering, and it MUST NOT be reported as a measurement of
  the shipped opponent.

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
  node budget — and reports the regret distribution: mean, 95th percentile, maximum, and the
  positions producing the worst ones.
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
- **[M5-19]** In the gating lane, `sharp` MUST have a maximum regret of no more than 5 points and a
  mean regret of no more than 0.5 over the audit corpus.
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

### Traceability exemptions

| Requirement | Why it is not testable |
| --- | --- |
| [M5-11] | A process promise about how a failing threshold is responded to. No run of the suite can see whether a reference opponent was changed for the right reason. |
| [M5-16], [M5-15] | Properties of a lane the suite does not run and of an artifact it does not produce. The baseline's *format* is checked when it is read; that it is kept current is a process promise. |
| [M5-20] | A `SHOULD` about the lane's own runtime. |
| [M5-22], [M5-23] | Statements about what may be claimed, and a procedure involving a human. The suite has no human and no claims. |

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
- **How many recorded seeds is enough for [M5-15]'s baseline to be a useful memory?** 200 puts the
  95% bound roughly ±6 points around a 75% winrate, which is wide enough that a genuine 4-point
  improvement is invisible. The answer is probably "more, run overnight", and the question is
  whether that is worth the wall-clock.

## References

- Intent [0003 — Computer opponent](../intent/0003-computer-opponent.md)
- Spec [0001 — Engine core](0001-engine-core.md)
- Spec [0002 — Engine conformance vectors](0002-engine-conformance-vectors.md) — the model for this split
- Spec [0004 — Computer opponent](0004-computer-opponent.md)
