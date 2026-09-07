/**
 * The evaluation [B4-11] through [B4-15], plus the two properties that make it
 * safe to search with: it is exactly zero-sum [B4-43], and it cannot see the
 * deal [B4-7].
 *
 * The information barrier is tested *behaviourally* here rather than only by
 * the source check of [B4-51]. A `grep` proves the four field names do not
 * appear; changing a factory and watching the value refuse to move proves the
 * evaluation does not depend on them however it were written. Both are worth
 * having — the grep fails fast and readably, this one cannot be worked around.
 */

import { describe, expect, it } from 'vitest';
import {
  COLOR_BONUS,
  COL_BONUS,
  NUM_COLORS,
  ROW_BONUS,
  apply,
  clone,
  fromCanonical,
  legalActions,
  newGame,
  outcome,
  toCanonical,
  wallCol,
  type AzulState,
  type CanonicalState,
  type Player,
} from 'engine';
import { WIN, evaluate } from '../src/index.js';

/** Play `n` plies of a seeded game, first legal action each time. */
function played(seed: number, n: number): AzulState {
  const s = newGame(seed);
  for (let i = 0; i < n && !s.isTerminal; i++) apply(s, legalActions(s)[0]);
  return s;
}

/** A spread of positions from several seeds and depths. */
function corpus(): AzulState[] {
  const out: AzulState[] = [];
  for (const seed of [1, 7, 99, 4242, 31337]) {
    for (const n of [0, 5, 13, 27, 44, 61]) out.push(played(seed, n));
  }
  return out;
}

/** A finished game, played to the end. */
function finished(seed: number): AzulState {
  const s = newGame(seed);
  while (!s.isTerminal) apply(s, legalActions(s)[0]);
  return s;
}

describe('evaluate [B4-11]', () => {
  it('[B4-11] returns a finite number of points for every position', () => {
    for (const s of corpus()) {
      for (const p of [0, 1] as Player[]) {
        expect(Number.isFinite(evaluate(s, p))).toBe(true);
      }
    }
  });

  /**
   * Asserted as `===`, which is how [B4-12] is written, rather than through
   * `toBe`. They differ on exactly one pair of values: `toBe` is `Object.is`,
   * which separates `0` from `-0`, and a level position legitimately produces
   * one of each from the two seats. `0 === -0` is true and the requirement is
   * satisfied; a matcher stricter than the spec would be testing the matcher.
   */
  it('[B4-43] [B4-12] is exactly zero-sum', () => {
    for (const s of corpus()) {
      expect(evaluate(s, 0) === -evaluate(s, 1)).toBe(true);
    }
  });

  it('[B4-43] [B4-12] is exactly zero-sum on finished games too', () => {
    for (const seed of [3, 11, 500, 20260906]) {
      const s = finished(seed);
      expect(s.isTerminal).toBe(true);
      expect(evaluate(s, 0) === -evaluate(s, 1)).toBe(true);
    }
  });

  it('[B4-41] does not mutate the state it is given', () => {
    for (const s of corpus()) {
      const before = toCanonical(s);
      evaluate(s, 0);
      evaluate(s, 1);
      expect(toCanonical(s)).toEqual(before);
    }
  });
});

describe('terminal positions [B4-13]', () => {
  it('[B4-13] values a finished game by its result, not its board', () => {
    let wins = 0;
    for (const seed of [3, 11, 42, 500, 777, 20260906]) {
      const s = finished(seed);
      const result = outcome(s);
      if (result === 0) continue;
      const winner: Player = result === 1 ? 0 : 1;
      expect(Math.abs(evaluate(s, winner))).toBeGreaterThanOrEqual(WIN);
      expect(evaluate(s, winner)).toBeGreaterThan(0);
      expect(evaluate(s, (1 - winner) as Player)).toBeLessThan(0);
      wins++;
    }
    expect(wins).toBeGreaterThan(0);
  });

  it('[B4-13] carries the score margin alongside the win', () => {
    const s = finished(42);
    const result = outcome(s);
    if (result === 0) return; // a draw has no margin to carry
    const winner: Player = result === 1 ? 0 : 1;
    const margin = s.scores[winner] - s.scores[1 - winner];
    expect(evaluate(s, winner)).toBe(WIN + margin);
  });

  it('[B4-13] puts a win beyond anything the heuristic can reach', () => {
    // The best conceivable unfinished board is worth far less than WIN, so no
    // pile of bonuses can be mistaken for a won game.
    for (const s of corpus()) {
      if (s.isTerminal) continue;
      expect(Math.abs(evaluate(s, 0))).toBeLessThan(WIN / 100);
    }
  });
});

/**
 * The barrier [B4-7]. Each of the five banned fields is changed to something a
 * lawful position could hold, and the value must not move.
 */
describe('the evaluation cannot see the deal [B4-7]', () => {
  /** Edit a snapshot's board-side fields, keeping `tilesLeft` honest. */
  function withBoard(s: AzulState, edit: (c: CanonicalState) => void): AzulState {
    const c = toCanonical(s);
    edit(c);
    let tiles = 0;
    for (let col = 0; col < NUM_COLORS; col++) tiles += c.center[col];
    for (const f of c.factories) {
      for (let col = 0; col < NUM_COLORS; col++) tiles += f[col];
    }
    c.tilesLeft = tiles;
    return fromCanonical(c, 0);
  }

  it('[B4-7] ignores what the factories hold', () => {
    for (const s of corpus()) {
      if (s.isTerminal) continue;
      const moved = withBoard(s, (c) => {
        // Empty every display into the lid: a different board, same two seats.
        for (const f of c.factories) {
          for (let col = 0; col < NUM_COLORS; col++) {
            c.lid[col] += f[col];
            f[col] = 0;
          }
        }
      });
      expect(evaluate(moved, 0)).toBe(evaluate(s, 0));
    }
  });

  it('[B4-7] ignores the centre pool and the marker in it', () => {
    for (const s of corpus()) {
      if (s.isTerminal) continue;
      const moved = withBoard(s, (c) => {
        for (let col = 0; col < NUM_COLORS; col++) {
          c.lid[col] += c.center[col];
          c.center[col] = 0;
        }
        c.markerInCenter = false;
      });
      expect(evaluate(moved, 0)).toBe(evaluate(s, 0));
    }
  });

  it('[B4-7] ignores the bag and the lid', () => {
    for (const s of corpus()) {
      if (s.isTerminal) continue;
      const moved = withBoard(s, (c) => {
        c.lid = c.lid.map((n, i) => n + c.bag.filter((x) => x === i).length);
        c.bag = [];
      });
      expect(evaluate(moved, 0)).toBe(evaluate(s, 0));
    }
  });
});

/**
 * Posed positions, built through `fromCanonical` — the engine's own
 * constructor — rather than by writing state fields.
 */
function posed(edit: (c: CanonicalState) => void): AzulState {
  const c = toCanonical(newGame(1));
  // Clear the opening deal so the board is ours and `tilesLeft` is 0.
  for (const f of c.factories) {
    for (let col = 0; col < NUM_COLORS; col++) {
      c.bag.push(col as 0 | 1 | 2 | 3 | 4);
      f[col] = 0;
    }
  }
  c.tilesLeft = 0;
  c.markerInCenter = true;
  edit(c);
  return fromCanonical(c, 0);
}

describe('what the evaluation weighs [B4-14], [B4-15]', () => {
  it('[B4-14] prefers a higher engine score, all else equal', () => {
    const low = posed((c) => {
      c.scores = [10, 10];
    });
    const high = posed((c) => {
      c.scores = [30, 10];
    });
    expect(evaluate(high, 0)).toBeGreaterThan(evaluate(low, 0));
    expect(evaluate(high, 0) - evaluate(low, 0)).toBe(20);
  });

  it('[B4-14] counts a floor line against the seat holding it', () => {
    const clean = posed(() => {});
    const dirty = posed((c) => {
      c.floor[0][0] = 3;
      c.lid[0] -= 3;
    });
    expect(evaluate(dirty, 0)).toBeLessThan(evaluate(clean, 0));
  });

  it('[B4-14] credits a pattern line that will tile, by what it will score', () => {
    const empty = posed(() => {});
    // Row 0 holds its one tile: it will tile, alone, for 1 point.
    const ready = posed((c) => {
      c.plColor[0][0] = 0;
      c.plCount[0][0] = 1;
      c.bag.splice(c.bag.indexOf(0), 1);
    });
    expect(evaluate(ready, 0)).toBeGreaterThan(evaluate(empty, 0));
  });

  it('[B4-14] treats a barely-started long row as a liability', () => {
    const empty = posed(() => {});
    // One tile toward row 4, which needs five: four still owed.
    const opened = posed((c) => {
      c.plColor[0][4] = 0;
      c.plCount[0][4] = 1;
      c.bag.splice(c.bag.indexOf(0), 1);
    });
    expect(evaluate(opened, 0)).toBeLessThan(evaluate(empty, 0));
  });

  /**
   * [B4-15]'s whole point. Row 0 and row 1 both tile; the wall cells they fill
   * are adjacent in a column, so the second tile placed scores against the
   * first. An evaluation that valued both rows against the *starting* wall
   * would score 1 + 1; one that advances the wall in row order scores 1 + 2.
   */
  it('[B4-15] scores a later row against a tile an earlier row just placed', () => {
    // Colour 0 sits at column 0 in row 0, and colour 4 at column 0 in row 1 —
    // the same column, adjacent rows.
    expect(wallCol(0, 0)).toBe(0);
    expect(wallCol(4, 1)).toBe(0);
    const both = posed((c) => {
      c.plColor[0][0] = 0;
      c.plCount[0][0] = 1;
      c.plColor[0][1] = 4;
      c.plCount[0][1] = 2;
      c.bag.splice(c.bag.indexOf(0), 1);
      c.bag.splice(c.bag.indexOf(4), 1);
      c.bag.splice(c.bag.indexOf(4), 1);
    });
    const onlyFirst = posed((c) => {
      c.plColor[0][0] = 0;
      c.plCount[0][0] = 1;
      c.bag.splice(c.bag.indexOf(0), 1);
    });
    const onlySecond = posed((c) => {
      c.plColor[0][1] = 4;
      c.plCount[0][1] = 2;
      c.bag.splice(c.bag.indexOf(4), 1);
      c.bag.splice(c.bag.indexOf(4), 1);
    });
    const base = evaluate(posed(() => {}), 0);
    const first = evaluate(onlyFirst, 0) - base;
    const second = evaluate(onlySecond, 0) - base;
    const together = evaluate(both, 0) - base;
    // Strictly more than the two in isolation: the adjacency is the surplus.
    expect(together).toBeGreaterThan(first + second);
  });

  /**
   * Four tiles that nearly close *something* beat four tiles that nearly close
   * nothing — and the ordering between the somethings follows [0001 E1-38]'s
   * own values rather than this test's intuition.
   *
   * The scattered wall below shares no row, no column and no colour between
   * any two of its four tiles, which is the only honest control: an earlier
   * version of this test used four tiles of one colour as the "scattered"
   * case and failed, correctly — four-fifths of a colour set is worth 10 and
   * beats four-fifths of a column, which is worth 7.
   */
  it('[B4-14] values a nearly-complete set above four unrelated tiles', () => {
    // Column 0, four different colours, four different rows.
    const column = posed((c) => {
      for (let r = 0; r < 4; r++) c.walls[0][r * NUM_COLORS + wallCol((5 - r) % 5, r)] = 1;
    });
    // Rows 0..3, columns 0/2/4/1, colours 0/1/2/3 — no two share anything.
    const scattered = posed((c) => {
      for (const [r, col] of [
        [0, 0],
        [1, 2],
        [2, 4],
        [3, 1],
      ]) {
        c.walls[0][r * NUM_COLORS + col] = 1;
      }
    });
    const cells = (s: AzulState): number => s.walls[0].reduce((n, x) => n + x, 0);
    expect(cells(column)).toBe(cells(scattered));
    expect(evaluate(column, 0)).toBeGreaterThan(evaluate(scattered, 0));
  });

  it('[B4-14] ranks a near-complete colour above a near-complete column [0001 E1-38]', () => {
    // Follows from COLOR_BONUS 10 > COL_BONUS 7 > ROW_BONUS 2: the evaluation
    // must not invent its own ordering of the three bonuses.
    const colour = posed((c) => {
      for (let r = 0; r < 4; r++) c.walls[0][r * NUM_COLORS + wallCol(0, r)] = 1;
    });
    const column = posed((c) => {
      for (let r = 0; r < 4; r++) c.walls[0][r * NUM_COLORS + wallCol((5 - r) % 5, r)] = 1;
    });
    const row = posed((c) => {
      for (let col = 0; col < 4; col++) c.walls[0][col] = 1;
    });
    expect(evaluate(colour, 0)).toBeGreaterThan(evaluate(column, 0));
    expect(evaluate(column, 0)).toBeGreaterThan(evaluate(row, 0));
  });

  it('[B4-14] uses the engine bonus constants for a completed set', () => {
    expect(ROW_BONUS).toBe(2);
    expect(COL_BONUS).toBe(7);
    expect(COLOR_BONUS).toBe(10);
    const empty = posed(() => {});
    const fullRow = posed((c) => {
      for (let col = 0; col < NUM_COLORS; col++) c.walls[0][col] = 1;
    });
    // A complete row is worth its bonus, plus whatever the five cells add to
    // five columns' and five colours' proximity — so at least the bonus.
    expect(evaluate(fullRow, 0) - evaluate(empty, 0)).toBeGreaterThanOrEqual(ROW_BONUS);
  });
});

describe('symmetry', () => {
  it('[B4-12] values the mirrored position oppositely', () => {
    const s = played(1234, 30);
    const mirrored = fromCanonical(
      {
        ...toCanonical(s),
        walls: [s.walls[1].slice(), s.walls[0].slice()],
        plColor: [s.plColor[1].slice(), s.plColor[0].slice()],
        plCount: [s.plCount[1].slice(), s.plCount[0].slice()],
        floor: [s.floor[1].slice(), s.floor[0].slice()],
        floorMarker: [s.floorMarker[1], s.floorMarker[0]],
        scores: [s.scores[1], s.scores[0]],
      },
      0,
    );
    expect(evaluate(mirrored, 0)).toBeCloseTo(evaluate(s, 1), 10);
  });

  it('[B4-11] gives two identical boards a value of zero', () => {
    const level = posed((c) => {
      c.scores = [7, 7];
    });
    expect(evaluate(level, 0)).toBe(0);
    expect(evaluate(level, 1)).toBe(0);
  });
});

/** Kept honest: `clone` must not change what a position is worth. */
describe('cloning', () => {
  it('[B4-41] values a clone identically [0001 E1-48]', () => {
    for (const s of corpus()) {
      expect(evaluate(clone(s), 0)).toBe(evaluate(s, 0));
    }
  });
});
