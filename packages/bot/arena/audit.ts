/**
 * The blunder audit [M5-18] through [M5-21], [M5-31].
 *
 * A winrate cannot see a blunder. A player can win a match and still throw a
 * round away, and can lose every game to a stronger opponent without ever
 * making a mistake worth pointing at. So this measures **regret**: how much
 * worse the move played was than the best move a much deeper search finds.
 *
 * The reference values are computed once and committed [M5-31], because four
 * million nodes is about eleven seconds a position and recomputing them would
 * spend [M5-20]'s whole budget before the tier under test made a single move.
 * That also makes the reference **stale by design**, which is the correct
 * failure mode: a reference regenerated whenever the bot changes measures the
 * bot against itself and calls every regression a tie.
 */

import { apply, clone, fromJSON, type AzulJSON } from 'engine';
import { evaluate } from '../src/index.js';
// Inside the package, so reaching the search directly is not a breach of
// [0004 B4-62], which is about what callers outside it can hold.
import { search } from '../src/search.js';
import type { Chooser } from './chooser.js';

/** One recorded position, with what a deep search thought of every move. */
export interface AuditPosition {
  /** The seed and ply this came from, so a finding can be reproduced. */
  seed: number;
  ply: number;
  /** How many rounds from the end — [M5-21] wants the last two. */
  roundsFromEnd: number;
  position: AzulJSON;
  /** `action -> value`, from the seat to move. Computed by the reference. */
  values: Record<number, number>;
  /**
   * `action -> did the reference finish searching it` [0004 B4-20].
   *
   * Recorded because without it the audit cannot tell a *fact* from a
   * *shallower guess*. Measured at the three positions where a move looked like
   * a certain loss: not one of the alternatives valued as "still a game" had a
   * completed search, and the two groups differed by about one ply of depth
   * (7.4–8.1 against 6.0–6.7). So the split between "certain loss" and "live
   * position" there was the reference's per-move budget running out, not a
   * property of the position — and any judgement built on it would be the
   * instrument measuring itself.
   */
  completed: Record<number, boolean>;
}

/** The committed corpus and the reference that produced it [M5-31]. */
export interface AuditCorpus {
  /** The bot commit the values were computed with. */
  botCommit: string;
  /** The node budget the reference search ran at. */
  referenceNodes: number;
  positions: AuditPosition[];
}

export interface Regret {
  seed: number;
  ply: number;
  /** Best value minus the value of the move played. Never negative [M5-26]. */
  regret: number;
  played: number;
  best: number;
}

export interface AuditReport {
  positions: number;
  /**
   * Positions where the played move gave up a *win* the reference had found.
   * Counted rather than averaged: losing a won game is a different kind of
   * mistake from giving up two points, and averaging them together lets one
   * swallow the other.
   */
  decisiveBlunders: Regret[];
  /** Positions whose regret is measured in points — neither move decides. */
  scored: number;
  /**
   * Positions where the reference could see no win to give up — every move it
   * valued was already a certain loss. Nothing to measure.
   */
  hopeless: number;
  /** Positions where the played move also won. A success, not a gap. */
  heldOn: number;
  /**
   * Positions where the reference condemned the played move and **did not
   * finish searching the alternatives**.
   *
   * Named for what it is rather than for what it looks like. It looks like "the
   * bot walked into a loss it could have avoided", and it is not: at the three
   * positions in this corpus, none of the alternatives valued as still-a-game
   * had a completed search, and they sat about a ply shallower than the moves
   * condemned as losses. Deepen them and many would very likely come back as
   * losses too, so the counterfactual is unestablished.
   *
   * Reported and never gated. A gate here would gate on how the reference split
   * its budget across a wide root — the instrument measuring itself. It is a
   * lead worth following to a position, not a verdict about a player.
   */
  condemned: Regret[];
  meanRegret: number;
  p95Regret: number;
  maxRegret: number;
  /** The worst handful, so a number can be drilled into [M5-6]. */
  worst: Regret[];
}

/**
 * Above this, a value is a claim about the *result* rather than the score
 * [0004 B4-13]. `WIN` is 1e6 and no reachable board is worth a thousand, so
 * anything past half of it is decisive and nothing else comes close.
 */
const DECISIVE = 500_000;



/**
 * What `chooser` gave up at each recorded position, against the committed
 * reference values [M5-18].
 *
 * Throws rather than skipping when a position's move is missing from the
 * recorded values: a corpus and a reference that have drifted apart produce a
 * regret of zero for every move nobody scored, which would read as a perfect
 * audit.
 */
export function audit(corpus: AuditCorpus, chooser: Chooser): AuditReport {
  const regrets: Regret[] = [];

  for (const entry of corpus.positions) {
    const play = chooser(entry.position);
    const best = Math.max(...Object.values(entry.values));
    const playedValue = entry.values[play.action];
    if (playedValue === undefined) {
      throw new Error(
        `seed ${entry.seed} ply ${entry.ply}: the corpus has no reference value for ` +
          `action ${play.action} — corpus and reference have drifted [M5-31]`,
      );
    }
    regrets.push({
      seed: entry.seed,
      ply: entry.ply,
      regret: best - playedValue,
      played: playedValue,
      best,
    });
  }

  // Classification is by **value only**: `AuditPosition.completed` is recorded
  // [M5-31] and deliberately not read here. Restricting these buckets to
  // actions the reference finished searching is the obvious next move and would
  // make `condemned` mean what its name says — it is not done, so do not assume
  // the buckets already respect it.
  //
  // Three populations, and the third exists because of a real limit on what
  // this audit can conclude.
  //
  // A value past `DECISIVE` is a *fact*: the game ends and this is who won
  // [0004 B4-13]. A value below it is a *guess*. Comparing the two is
  // meaningless, and doing it produced the audit's most misleading output: at
  // `seed 500 ply 44` the reference rates the best move at -1 and a
  // game-ending move at -1000002, so every tier — `sharp` at its full budget
  // included — reads as having thrown the game away. It has not. The reference
  // stops at the round boundary too [0004 B4-6], so its -1 is a guess about a
  // position that may lose anyway, while the -1000002 is a loss it can see. The
  // apparent blunder is the horizon, not the player.
  //
  // So: a decisive blunder is a *certain win* given up for something that is
  // not a certain win — facts on both sides. Points are compared only where
  // both values are guesses. Pairs that mix the two are counted and set aside,
  // because this instrument cannot rank them.
  const decisiveBlunders = regrets.filter((r) => r.best >= DECISIVE && r.played < DECISIVE);
  const scored = regrets.filter(
    (r) => Math.abs(r.best) < DECISIVE && Math.abs(r.played) < DECISIVE,
  );
  // The unrankable remainder is three different things, and lumping them into
  // one integer buried the only one worth looking at.
  const hopeless = regrets.filter((r) => r.best <= -DECISIVE);
  const heldOn = regrets.filter((r) => r.best >= DECISIVE && r.played >= DECISIVE);
  const condemned = regrets.filter(
    (r) => Math.abs(r.best) < DECISIVE && r.played <= -DECISIVE,
  );

  const sorted = [...scored].sort((x, y) => y.regret - x.regret);
  const values = scored.map((r) => r.regret);
  const ascending = [...values].sort((x, y) => x - y);
  return {
    positions: regrets.length,
    decisiveBlunders,
    scored: scored.length,
    hopeless: hopeless.length,
    heldOn: heldOn.length,
    condemned,
    meanRegret: values.reduce((t, v) => t + v, 0) / (values.length || 1),
    p95Regret: ascending.length === 0 ? 0 : ascending[Math.floor(0.95 * (ascending.length - 1))],
    maxRegret: sorted.length === 0 ? 0 : sorted[0].regret,
    worst: sorted.slice(0, 5),
  };
}

/**
 * Value every legal move of a position with a deep search — the reference of
 * [M5-18]. Called **only** by the corpus generator, never by {@link audit}.
 *
 * That separation is [M5-31]: a lane that recomputed these would be measuring
 * the bot against a copy of itself made at the same moment, and would call
 * every regression a tie.
 *
 * It reaches `search` directly rather than through the package entry, which is
 * not a hole in [0004 B4-62] — that requirement is about what *callers outside
 * the package* can reach, and this file is inside it.
 */
export function referenceValues(
  position: AzulJSON,
  nodes: number,
): { values: Record<number, number>; completed: Record<number, boolean> } {
  const values: Record<number, number> = {};
  const completed: Record<number, boolean> = {};
  const root = fromJSON(position, 0);
  const seat = root.currentPlayer;

  // `nodes` is the budget for valuing the **position**, split across its moves
  // — not a budget per move. Read the other way a position with twenty legal
  // actions would cost twenty times the stated figure, which at [M5-18]'s four
  // million is four minutes a position rather than twelve seconds.
  const perMove = Math.floor(nodes / position.legalActions.length);

  for (const action of position.legalActions) {
    const child = clone(root);
    apply(child, action);
    if (child.isTerminal || child.roundIndex !== root.roundIndex) {
      // A boundary child is a leaf [0004 B4-19], valued from the parent's seat
      // exactly as the search takes it.
      values[action] = evaluate(child, seat);
      // A boundary child is a terminal fact, not a truncated search.
      completed[action] = true;
      continue;
    }
    const below = search(child, {
      maxDepth: Number.MAX_SAFE_INTEGER,
      nodes: perMove,
      milliseconds: Number.MAX_SAFE_INTEGER,
    });
    // `search` reports from the seat to move in `child`; convert to ours.
    values[action] = child.currentPlayer === seat ? below.value : -below.value;
    completed[action] = below.complete;
  }
  return { values, completed };
}
