/**
 * Recorded seed lists [M5-4].
 *
 * Written down rather than generated, so a match is a fixed experiment and not
 * a fresh sample every run. That is what makes [M5-7] achievable and what turns
 * a threshold into a regression gate rather than a coin toss.
 *
 * These are arbitrary constants. They were not chosen by trying several and
 * keeping the flattering ones — doing that would make every number below a
 * statement about the seeds rather than about the players, and [M5-11] exists
 * to stop the same thing happening to reference opponents.
 */

/** The gating lane's 40 games [M5-13]. */
export const GATING_SEEDS: readonly number[] = Object.freeze(
  Array.from({ length: 40 }, (_, i) => 20260906 + i * 7919),
);

/** The wide lane's 200 [M5-16]. Run on demand, never in the suite. */
export const WIDE_SEEDS: readonly number[] = Object.freeze(
  Array.from({ length: 200 }, (_, i) => 19910101 + i * 104729),
);

/** A handful, for the harness's own tests. */
export const SMOKE_SEEDS: readonly number[] = Object.freeze([11, 4242, 20260906, 77, 500]);

/** The seed the uniform-random chooser draws from [M5-9], [M5-4]. */
export const RANDOM_CHOOSER_SEED = 31337;
