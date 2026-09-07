/**
 * The package's entry point [B4-4], [B4-16], and the three tiers [B4-32].
 *
 * A position arrives as `AzulJSON` and becomes a searchable state through
 * `fromJSON` [B4-5], [0001 E1-69] — which is the information barrier, not a
 * convenience: `toJSON` reports the bag as counts and never its order
 * [0001 E1-52], so there is no order here to leak. The bot cannot cheat
 * because it was never handed the thing it would cheat with.
 */

import { ACTION_SPACE, fromJSON, type AzulJSON } from 'engine';
import { search } from './search.js';

/**
 * The three opponents [B4-32], in strength order [B4-36]. They differ in **how
 * far ahead each can see**, not in how long each may take — a horizon is a
 * difference in kind, a stopwatch is not, and intent 0003 asks for settings
 * that are "actually different, not just slower versions of each other".
 */
export type Tier = 'easy' | 'steady' | 'sharp';

/** In strength order, weakest first [B4-36]. */
export const TIERS: readonly Tier[] = Object.freeze(['easy', 'steady', 'sharp'] as const);

/**
 * Plies of lookahead each tier is allowed.
 *
 * `easy` sees its own move and stops, which is what makes it structurally
 * incapable of denial [B4-33] — it never looks at the reply, so it cannot
 * prefer a move for what it leaves you. `steady` sees the reply and its own
 * answer [B4-34]. `sharp` deepens until its budget runs out or the round does
 * [B4-35].
 */
const DEPTHS: Readonly<Record<Tier, number>> = Object.freeze({
  easy: 1,
  steady: 3,
  sharp: Number.MAX_SAFE_INTEGER,
});

/**
 * Node budgets [B4-26]. Counted in nodes rather than milliseconds so the
 * answer does not depend on what else the machine was doing [B4-30].
 *
 * `easy`'s is `ACTION_SPACE` [0001 E1-6] — the size of the whole action space,
 * which a root can never exceed and rarely approaches. It is a bound, not a
 * throttle: `easy` is defined by its horizon and is never curtailed.
 */
export const BUDGETS: Readonly<Record<Tier, number>> = Object.freeze({
  easy: ACTION_SPACE,
  steady: 20_000,
  sharp: 400_000,
});

/** The wall-clock fail-safe [B4-28], in milliseconds. */
export const FAIL_SAFE_MS = 4000;

/**
 * The seed handed to `fromJSON`. Any constant does: the search never looks at
 * what a boundary ply deals [B4-7], and it never searches past one [B4-6]. It
 * is fixed rather than arbitrary because [B4-30] wants the same answer twice.
 */
const SEED = 0;

export interface Options {
  tier: Tier;
  /** Overrides the tier's node budget [B4-26]. For tests and 0005's arena. */
  nodes?: number;
  /** Overrides the fail-safe [B4-28]. */
  milliseconds?: number;
}

/** What the bot returns [B4-40]: plain data, structurally cloneable. */
export interface Choice {
  /** Always a member of `position.legalActions` [B4-16], [B4-42]. */
  action: number;
  /** Its value in points, from the seat's perspective [B4-11]. */
  value: number;
  /** Plies of lookahead completed. `1` for `easy` [B4-33]. */
  depth: number;
  /** Nodes expanded [B4-26], [B4-45]. */
  nodes: number;
  /** Every leaf was a boundary or terminal node [B4-20]. */
  complete: boolean;
  /** The clock stopped the search before its node budget [B4-29]. */
  curtailed: boolean;
}

/** A positive integer, or not an override at all [B4-39]. */
function positiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/**
 * Choose a move for `position.currentPlayer` [B4-4].
 *
 * Synchronous, and schedules nothing: keeping the page alive is done by *where*
 * this runs, which belongs to *0006 — Opponent in the interface*, not by
 * yielding in here.
 *
 * Throws on a terminal position rather than returning something [B4-16] — a
 * position with no legal actions [0001 E1-11] is not one anyone should be
 * asking about, and a caller that does has a bug worth surfacing.
 */
export function chooseMove(position: AzulJSON, options: Options): Choice {
  if (!TIERS.includes(options.tier)) {
    throw new TypeError(`unknown tier ${JSON.stringify(options.tier)}`);
  }
  const nodes = positiveInteger(options.nodes, 'nodes');
  const milliseconds = positiveInteger(options.milliseconds, 'milliseconds');
  if (position.legalActions.length === 0) {
    throw new Error('no legal actions: the game is over [0001 E1-11]');
  }

  const result = search(fromJSON(position, SEED), {
    maxDepth: DEPTHS[options.tier],
    nodes: nodes ?? BUDGETS[options.tier],
    milliseconds: milliseconds ?? FAIL_SAFE_MS,
  });

  return {
    action: result.action,
    value: result.value,
    depth: result.depth,
    nodes: result.nodes,
    complete: result.complete,
    curtailed: result.curtailed,
  };
}
