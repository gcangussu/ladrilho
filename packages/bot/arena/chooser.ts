/**
 * What plays a game in the arena, and the two reference opponents every
 * measured number is relative to [M5-9], [M5-10].
 *
 * Every chooser is handed `toJSON` of the position and nothing else [M5-2],
 * reference opponents included. That is how the arena *enforces* [0004 B4-5]
 * rather than trusting it: the harness holds real `AzulState`s, so this seam is
 * where a bag order would leak if one could, and the type is what stops it.
 *
 * There is deliberately no escape hatch for the reference opponents. `greedy`
 * needs successor positions to value, and it gets them the way the bot does —
 * `fromJSON` then `clone`/`apply` [0001 E1-69] — rather than through a
 * state-shaped variant of this type. A hole opened "only for the reference
 * opponents" is still a hole, and it is in the one file whose job is to hold
 * the line.
 */

import {
  Rng,
  apply,
  clone,
  fromJSON,
  type AzulJSON,
} from 'engine';
import { chooseMove, evaluate, type Options } from '../src/index.js';

/**
 * What a chooser reports: the move, and what it cost to find.
 *
 * Richer than a bare action because a match has to refuse to average over a
 * curtailed search [M5-8] and has to report work done, and neither is
 * recoverable from an action alone.
 */
export interface Play {
  action: number;
  /** Nodes expanded. `0` for a reference opponent that does not search. */
  nodes: number;
  /** [0004 B4-29]. A match containing one fails [M5-8]. */
  curtailed: boolean;
  /** Plies of lookahead completed. `1` for a reference opponent. */
  depth: number;
  /**
   * Every leaf was a boundary or terminal node [0004 B4-20].
   *
   * Carried because without it nothing downstream can tell a search that ran
   * out of round from one that ran out of budget — which is exactly the
   * diagnostic wanted at a wide root, where the audit's regret is concentrated.
   */
  complete: boolean;
}

export type Chooser = (position: AzulJSON) => Play;

/** The seed handed to `fromJSON`; nothing here ever deals [0004 B4-6]. */
const SEED = 0;

/**
 * A tier of [0004 B4-32], wrapped as a chooser [M5-17].
 *
 * `options` carries the budget override the gating lane needs: `sharp` at its
 * shipped 400 000 nodes is over a second a move, and forty games of that does
 * not belong in any lane anyone runs on save.
 */
export function tier(options: Options): Chooser {
  return (position) => {
    const choice = chooseMove(position, options);
    return {
      action: choice.action,
      nodes: choice.nodes,
      curtailed: choice.curtailed,
      depth: choice.depth,
      complete: choice.complete,
    };
  };
}

/**
 * Uniform over `legalActions`, from a seeded generator [M5-9].
 *
 * The floor, and a very weak one: over 3000 recorded games random play averages
 * three points, because it fills its own floor line.
 *
 * The generator lives in the closure rather than being reseeded per position,
 * so a match draws one reproducible stream [M5-4]. It follows that a chooser
 * built here is single-use: two matches must not share one, or the second sees
 * a stream the first left mid-flight. `match` builds its choosers per match.
 */
export function uniformRandom(seed: number): Chooser {
  const rng = new Rng(seed);
  return (position) => ({
    action: position.legalActions[rng.below(position.legalActions.length)],
    nodes: 0,
    curtailed: false,
    depth: 0,
    complete: false,
  });
}

/**
 * Every legal action valued by [0004 B4-11]'s evaluation, best taken, no search
 * [M5-10].
 *
 * `easy` by construction, and named separately on purpose: it is the reference
 * the other tiers are measured against and it must survive `easy` being
 * redefined [M5-10]. Which is why it is written here against `evaluate`
 * directly rather than delegating to `chooseMove({ tier: 'easy' })` — the day
 * `easy` changes, this must not change with it.
 */
export function greedy(): Chooser {
  return (position) => {
    const root = fromJSON(position, SEED);
    const seat = root.currentPlayer;
    let best = -Infinity;
    let action = position.legalActions[0];
    for (const candidate of position.legalActions) {
      const child = clone(root);
      apply(child, candidate);
      const value = evaluate(child, seat);
      // Strictly greater, so ties fall to the lower action number — the same
      // tie-break [0004 B4-30] uses, which is what makes this deterministic.
      if (value > best) {
        best = value;
        action = candidate;
      }
    }
    return {
      action,
      nodes: position.legalActions.length,
      curtailed: false,
      depth: 1,
      complete: false,
    };
  };
}
