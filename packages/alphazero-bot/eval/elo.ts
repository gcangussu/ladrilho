/**
 * Elo ratings for the pool of [Z11-73]: a checkpoint's performance rating
 * against opponents of known rating, a pool's ratings from its own games, and
 * the rule that decides whether a challenger takes a champion's place.
 *
 * The model is the logistic one: a player rated `r` scores
 * `1 / (1 + 10^((R - r) / 400))` against one rated `R`, a draw counting half.
 * Ratings are maximum-likelihood estimates; a standard error is the inverse
 * square root of the likelihood's curvature at the estimate.
 */

/** Points per natural-log unit of odds: `400 / ln 10`. */
export const ELO_SCALE = 400 / Math.LN10;

/** How far past the opponents' range a rating may go: a clean sweep has no finite MLE. */
export const ELO_BOUND = 800;

/** The expected score of `r` against `opponent`. */
export function expected(r: number, opponent: number): number {
  return 1 / (1 + Math.exp((opponent - r) / ELO_SCALE));
}

/** Games against one opponent: its rating, the games, and the score (wins plus half the draws). */
export interface Played {
  opponent: number;
  games: number;
  score: number;
}

export interface Rating {
  rating: number;
  /** The standard error, in Elo points. */
  se: number;
}

/**
 * The performance rating: the `r` at which the expected score equals the
 * actual one, summed over every opponent. The likelihood's slope in `r` falls
 * as `r` rises, so it is found by bisection, inside `[lowest - 800, highest +
 * 800]`, where a clean sweep or a whitewash stops.
 */
export function performance(records: readonly Played[]): Rating {
  const played = records.filter((x) => x.games > 0);
  if (played.length === 0) throw new Error('a performance rating needs at least one game');
  const slope = (r: number): number => played.reduce((s, x) => s + x.score - x.games * expected(r, x.opponent), 0);
  let lo = Math.min(...played.map((x) => x.opponent)) - ELO_BOUND;
  let hi = Math.max(...played.map((x) => x.opponent)) + ELO_BOUND;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (slope(mid) > 0) lo = mid;
    else hi = mid;
  }
  const rating = (lo + hi) / 2;
  const information = played.reduce((s, x) => {
    const e = expected(rating, x.opponent);
    return s + (x.games * e * (1 - e)) / (ELO_SCALE * ELO_SCALE);
  }, 0);
  return { rating, se: 1 / Math.sqrt(information) };
}

/** The games between two members of a pool, `score` being `a`'s. */
export interface Pairing {
  a: number;
  b: number;
  games: number;
  score: number;
}

/**
 * Every member's rating from the pool's own games, member `anchor` held at 0
 * so the scale is pinned. Each other member is set in turn to its performance
 * against the others' current ratings, which climbs the joint likelihood; it
 * stops when no rating moves by a thousandth of a point.
 */
export function fitPool(members: number, pairings: readonly Pairing[], anchor = 0): Rating[] {
  const ratings = new Array<number>(members).fill(0);
  const recordsOf = (i: number): Played[] =>
    pairings.flatMap((p) =>
      p.a === i
        ? [{ opponent: ratings[p.b], games: p.games, score: p.score }]
        : p.b === i
          ? [{ opponent: ratings[p.a], games: p.games, score: p.games - p.score }]
          : [],
    );
  for (let sweep = 0; sweep < 1000; sweep++) {
    let moved = 0;
    for (let i = 0; i < members; i++) {
      if (i === anchor) continue;
      const next = performance(recordsOf(i)).rating;
      moved = Math.max(moved, Math.abs(next - ratings[i]));
      ratings[i] = next;
    }
    if (moved < 1e-3) break;
  }
  return ratings.map((rating, i) => ({ rating, se: i === anchor ? 0 : performance(recordsOf(i)).se }));
}

/** How many standard errors decide a replacement without more games. */
export const MARGIN_SE = 2;

/**
 * [Z11-73]'s replacement rule, before more games: `replace` when the
 * challenger is at least two standard errors above the weakest champion,
 * `keep` when at least two below, `more` in between.
 */
export function verdict(challenger: Rating, weakest: number): 'replace' | 'keep' | 'more' {
  const gap = challenger.rating - weakest;
  if (gap >= MARGIN_SE * challenger.se) return 'replace';
  if (gap <= -MARGIN_SE * challenger.se) return 'keep';
  return 'more';
}

/** After the extra games: the higher rating takes the place, a tie keeping the champion. */
export function settle(challenger: Rating, weakest: number): 'replace' | 'keep' {
  return challenger.rating > weakest ? 'replace' : 'keep';
}
