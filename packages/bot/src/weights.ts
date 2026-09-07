/**
 * The evaluation's tuned constants, in one place because they are the only
 * numbers in this package that are a matter of taste rather than of rule.
 *
 * Everything else the evaluation uses — what a placed tile scores, what a
 * floor line costs, what a completed row is worth — comes from the engine
 * [B4-8]. These are the weights that turn those facts into a preference, and
 * preference is the whole of what a bot is for.
 *
 * They are hand-set, not fitted. Intent 0003 puts training out of scope and
 * spec 0004's *Open questions* records why fitting them against the arena is
 * not obviously allowed under that. The values below are the ones the
 * prototype in spec 0005's measured ladder used.
 */

/** Credit for a pattern line that will tile this round, per point it earns. */
export const LINE_COMPLETE = 1.0;

/**
 * Credit per tile already committed to a line that will *not* tile this round,
 * and the debt per tile it still needs.
 *
 * The debt is the larger of the two on purpose: a half-filled row 4 is a
 * liability, not an asset, until the tiles to finish it are in hand.
 */
export const LINE_PARTIAL = 0.55;
export const LINE_WASTE = 0.9;

/**
 * How much of an end-of-game bonus a partly-built row, column or colour is
 * worth, as a fraction of the bonus itself.
 *
 * Cubed rather than linear so that four-fifths of a column is worth far more
 * than half of it — which is true, because the fifth tile is the one that pays
 * and the bot should not be rewarded for spreading itself across five columns
 * it will never close.
 */
export const PROXIMITY_EXPONENT = 3;
