/**
 * The harness itself [M5-27] through [M5-29], and the invariants a reported
 * number rests on [M5-24], [M5-25], [M5-26].
 *
 * These run in the fast suite because they are about the *arena*, not about
 * strength: a match of five games between two cheap choosers exercises every
 * clause here. The measurements themselves are [M5-13]'s lane, which takes
 * minutes and lives in `ladder/`.
 */

import { describe, expect, it } from 'vitest';
import {
  apply,
  fromJSON,
  newGame,
  tileCensus,
  toJSON,
  type AzulJSON,
} from 'engine';
import {
  GATING_SEEDS,
  RANDOM_CHOOSER_SEED,
  SMOKE_SEEDS,
  WIDE_SEEDS,
  greedy,
  match,
  tier,
  uniformRandom,
  wilsonLowerBound,
  type Chooser,
} from '../arena/index.js';

/** Two cheap choosers, rebuilt per match — `uniformRandom` holds a stream. */
const cheap = (): { a: Chooser; b: Chooser } => ({
  a: greedy(),
  b: uniformRandom(RANDOM_CHOOSER_SEED),
});

describe('a match is reproducible [M5-7]', () => {
  /**
   * Run twice in one process, and — the part that matters — with freshly built
   * choosers each time.
   *
   * Reusing one `uniformRandom` across both runs would make this pass for the
   * wrong reason in one direction and fail for the wrong reason in the other:
   * its generator is a stream, so the second run would continue where the first
   * stopped. Building them per match is what the requirement actually needs,
   * and it is what `ladder/` does too.
   */
  it('[M5-27] [M5-7] produces an identical Result from an identical MatchSpec', () => {
    const first = match({ ...cheap(), seeds: SMOKE_SEEDS });
    const second = match({ ...cheap(), seeds: SMOKE_SEEDS });
    // `ms` is wall-clock and cannot be identical; everything else must be.
    const withoutTiming = (r: typeof first): unknown => ({
      ...r,
      work: r.work.map((w) => ({ nodes: w.nodes })),
    });
    expect(withoutTiming(second)).toEqual(withoutTiming(first));
  });

  it('[M5-7] a stale random chooser changes the result — the stream is real', () => {
    // Guards the test above: if `uniformRandom` held no state, rebuilding it
    // per match would be pointless and the reproducibility claim vacuous.
    //
    // Compared on ply count, not on wins. Greedy beats uniform random in every
    // game [M5-9], so `lostSeeds` is empty either way — an earlier version
    // compared exactly that and asserted `[] !== []`.
    const shared = uniformRandom(RANDOM_CHOOSER_SEED);
    const first = match({ a: greedy(), b: shared, seeds: SMOKE_SEEDS });
    const second = match({ a: greedy(), b: shared, seeds: SMOKE_SEEDS });
    expect(second.plies).not.toBe(first.plies);
  });
});

describe('an illegal move fails the match [M5-2]', () => {
  it('[M5-27] [M5-2] names the seed and the ply', () => {
    const rogue: Chooser = (position) => ({
      // 179 is the top of the action space [0001 E1-6] and is essentially never
      // legal; if it happens to be, take something certainly illegal instead.
      action: position.legalActions.includes(179) ? -1 : 179,
      nodes: 0,
      curtailed: false,
      depth: 0,
      complete: false,
    });
    expect(() => match({ a: rogue, b: greedy(), seeds: [SMOKE_SEEDS[0]] })).toThrow(
      /seed \d+ ply \d+: chooser returned/,
    );
  });

  it('[M5-8] a curtailed search fails the match rather than being averaged in', () => {
    const exhausted: Chooser = (position) => ({
      action: position.legalActions[0],
      nodes: 1,
      curtailed: true,
      depth: 1,
      complete: false,
    });
    expect(() => match({ a: exhausted, b: greedy(), seeds: [SMOKE_SEEDS[0]] })).toThrow(
      /curtailed/,
    );
  });

  it('[M5-5] a runaway game fails rather than hanging', () => {
    expect(() =>
      match({ ...cheap(), seeds: [SMOKE_SEEDS[0]], maxPlies: 3 }),
    ).toThrow(/exceeded 3 plies/);
  });

  it('[M5-2] hands the chooser a view whose bag is counts, never an order', () => {
    const seen: AzulJSON[] = [];
    const spy: Chooser = (position) => {
      seen.push(position);
      return {
        action: position.legalActions[0],
        nodes: 0,
        curtailed: false,
        depth: 0,
        complete: false,
      };
    };
    match({ a: spy, b: greedy(), seeds: [SMOKE_SEEDS[0]] });
    expect(seen.length).toBeGreaterThan(10);
    // Every position, not just one: five counts and never an order, all game.
    for (const position of seen) expect(position.bag).toHaveLength(5);
    // The opening still has a full bag — keeping only the *last* position would
    // have sampled the end of the game, where the bag is legitimately empty.
    expect(seen[0].bag.reduce((total, n) => total + n, 0)).toBeGreaterThan(50);
  });
});

describe('what a Result says [M5-3], [M5-6], [M5-24]', () => {
  const result = match({ ...cheap(), seeds: SMOKE_SEEDS });

  it('[M5-28] [M5-24] adds up', () => {
    expect(result.wins + result.losses + result.draws).toBe(result.games);
    expect(result.games).toBe(SMOKE_SEEDS.length);
    expect(result.winrate).toBeCloseTo((result.wins + result.draws / 2) / result.games, 12);
  });

  it('[M5-28] [M5-3] alternates seats, equal within one', () => {
    expect(result.seats[0] + result.seats[1]).toBe(result.games);
    expect(Math.abs(result.seats[0] - result.seats[1])).toBeLessThanOrEqual(1);
    // An odd seed count is the case that distinguishes "equal" from "within
    // one", so the smoke list is deliberately odd.
    expect(SMOKE_SEEDS.length % 2).toBe(1);
  });

  it('[M5-6] reports the seed of every game its first chooser lost', () => {
    expect(result.lostSeeds).toHaveLength(result.losses);
    for (const seed of result.lostSeeds) expect(SMOKE_SEEDS).toContain(seed);
  });

  it('[M5-6] reports work for both sides', () => {
    // `greedy` expands one node per legal action; uniform random expands none.
    expect(result.work[0].nodes).toBeGreaterThan(0);
    expect(result.work[1].nodes).toBe(0);
    expect(result.plies).toBeGreaterThan(result.games);
  });

  it('[M5-8] reports zero curtailed, because a curtailed match throws', () => {
    expect(result.curtailed).toBe(0);
  });
});

describe('every arena game is lawful [M5-1], [M5-25]', () => {
  /**
   * Asserted on the games **the arena actually plays**, by watching from inside
   * a chooser.
   *
   * An earlier version hand-rolled a greedy-versus-greedy loop and checked
   * that, which is not the arena's games at all: `match` alternates seats and
   * pairs two different opponents, so the positions it reaches are not the ones
   * a self-play loop reaches. `playGame` does enforce legality in production,
   * but nothing asserted the census of a single arena position.
   */
  it('[M5-28] [M5-25] [M5-1] plays only legal moves and conserves tiles', () => {
    const inner = greedy();
    let checked = 0;
    // The chooser is handed a view [M5-2], so the census is checked on a state
    // rebuilt from it — which is also a second proof the view is complete.
    const watched: Chooser = (position) => {
      expect(tileCensus(fromJSON(position, 0)), `position ${checked}`).toEqual([
        20, 20, 20, 20, 20,
      ]);
      const play = inner(position);
      expect(position.legalActions, `position ${checked}`).toContain(play.action);
      checked++;
      return play;
    };

    const result = match({
      a: watched,
      b: uniformRandom(RANDOM_CHOOSER_SEED),
      seeds: SMOKE_SEEDS,
    });
    expect(result.games).toBe(SMOKE_SEEDS.length);
    expect(checked).toBeGreaterThan(50);
  });
});

/**
 * [M5-29]. Hand-computed against the Wilson formula rather than against this
 * implementation, including both degenerate ends.
 */
describe('the Wilson lower bound [M5-14]', () => {
  /**
   * Checked against a second, algebraically equivalent arrangement of the
   * Wilson formula rather than against numbers written down by hand.
   *
   * Hand-computed constants were tried first and three of the four were wrong,
   * which would have pinned the implementation to my arithmetic rather than to
   * the formula. The closed form below multiplies out the same interval and
   * shares no expression with the implementation, so a slip in either shows up
   * as a disagreement.
   */
  function closedForm(successes: number, games: number): number {
    if (games === 0) return 0;
    const z = 1.6448536269514722;
    const p = successes / games;
    const z2 = z * z;
    const root = Math.sqrt(z2 + 4 * games * p * (1 - p));
    return (2 * games * p + z2 - z * root) / (2 * (games + z2));
  }

  it('[M5-29] agrees with an independent arrangement of the formula', () => {
    for (const [successes, games] of [
      [30, 40],
      [76, 100],
      [150, 200],
      [20.5, 40],
      [1, 3],
      [39, 40],
    ] as const) {
      expect(wilsonLowerBound(successes, games), `${successes}/${games}`).toBeCloseTo(
        closedForm(successes, games),
        12,
      );
    }
    // And a value spelled out, so the pair cannot drift together unnoticed.
    expect(wilsonLowerBound(30, 40)).toBeCloseTo(0.6240270595, 9);
  });

  it('[M5-29] handles zero and n successes without going outside [0, 1]', () => {
    expect(wilsonLowerBound(0, 40)).toBe(0);
    const all = wilsonLowerBound(40, 40);
    expect(all).toBeGreaterThan(0.9);
    expect(all).toBeLessThan(1);
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('[M5-29] rises with the sample at a fixed winrate', () => {
    // The same 75% is a weaker claim from 40 games than from 200.
    expect(wilsonLowerBound(150, 200)).toBeGreaterThan(wilsonLowerBound(30, 40));
  });

  it('[M5-14] takes a fractional success count, because a draw is half a win', () => {
    expect(wilsonLowerBound(20.5, 40)).toBeGreaterThan(wilsonLowerBound(20, 40));
  });
});

describe('the recorded seeds [M5-4]', () => {
  it('[M5-4] are fixed lists, distinct, and sized as the spec says', () => {
    expect(GATING_SEEDS).toHaveLength(40);
    expect(WIDE_SEEDS).toHaveLength(200);
    expect(new Set(GATING_SEEDS).size).toBe(GATING_SEEDS.length);
    expect(new Set(WIDE_SEEDS).size).toBe(WIDE_SEEDS.length);
    // In range for [0003 U3-13]'s reduction, so a seed names one deal.
    for (const seed of [...GATING_SEEDS, ...WIDE_SEEDS]) {
      expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
    }
  });

  it('[M5-4] a reference opponent draws from a seeded generator, not the clock', () => {
    const one = uniformRandom(RANDOM_CHOOSER_SEED);
    const two = uniformRandom(RANDOM_CHOOSER_SEED);
    const position = toJSON(newGame(SMOKE_SEEDS[0]));
    for (let i = 0; i < 20; i++) expect(two(position).action).toBe(one(position).action);
  });
});

describe('the reference opponents [M5-9], [M5-10]', () => {
  it('[M5-10] greedy is easy by construction, but written separately', () => {
    // They agree today because `easy` *is* a one-ply eval [0004 B4-33]. They
    // are separate functions so that [M5-10] survives `easy` being redefined —
    // the day it changes, this assertion is the thing that notices.
    const easy = tier({ tier: 'easy' });
    const reference = greedy();
    for (const seed of SMOKE_SEEDS.slice(0, 3)) {
      const s = newGame(seed);
      for (let i = 0; i < 12 && !s.isTerminal; i++) {
        const position = toJSON(s);
        expect(reference(position).action, `seed ${seed}`).toBe(easy(position).action);
        apply(s, position.legalActions[0]);
      }
    }
  });

  it('[M5-9] uniform random is a genuinely weak floor', () => {
    const result = match({
      a: greedy(),
      b: uniformRandom(RANDOM_CHOOSER_SEED),
      seeds: SMOKE_SEEDS,
    });
    expect(result.winrate).toBe(1);
    expect(result.meanScore[0]).toBeGreaterThan(result.meanScore[1] + 20);
  });
});
