/**
 * The two additions the bot needs: `placementValue` [E1-68] and `fromJSON`
 * [E1-69].
 *
 * Both exist to serve *0004 — Computer opponent*, and both are pinned here
 * against the thing they are supposed to agree with rather than against a
 * hand-written expectation: `placementValue` against the round scoring of the
 * whole vector corpus, `fromJSON` against every position the corpus holds,
 * because in both cases the claim is about all of them.
 *
 * The *other* half of [E1-68] — that [E1-24] has exactly **one**
 * implementation — is not testable from here, because a correct second copy
 * behaves identically. `purity.test.ts` carries that claim, by reading the
 * source and asserting the callers delegate.
 */

import { describe, expect, it } from 'vitest';
import {
  NUM_COLORS,
  NUM_ROWS,
  apply,
  fromCanonical,
  fromJSON,
  legalActions,
  newGame,
  placementValue,
  toCanonical,
  toJSON,
  wallCol,
  type AzulState,
  type Color,
} from '../src/index.js';
import { loadVectors } from './support/vectors.js';

/** An empty flat `[25]` wall [E1-2]. */
function emptyWall(): number[] {
  return new Array<number>(NUM_ROWS * NUM_COLORS).fill(0);
}

describe('placementValue [E1-68]', () => {
  it('[E1-68] [E1-24] scores a tile that lands alone as 1', () => {
    expect(placementValue(emptyWall(), 0, 0)).toBe(1);
    expect(placementValue(emptyWall(), 2, 3)).toBe(1);
  });

  it('[E1-68] [E1-24] scores a horizontal run alone as its length', () => {
    const wall = emptyWall();
    wall[0] = 1;
    wall[1] = 1;
    // Placing at (0, 2) extends a run of two to three; nothing above or below.
    expect(placementValue(wall, 0, 2)).toBe(3);
  });

  it('[E1-68] [E1-24] scores a vertical run alone as its length', () => {
    const wall = emptyWall();
    wall[0 * 5 + 1] = 1;
    wall[1 * 5 + 1] = 1;
    expect(placementValue(wall, 2, 1)).toBe(3);
  });

  it('[E1-68] [E1-24] adds both runs when the tile joins a cross', () => {
    const wall = emptyWall();
    wall[1 * 5 + 0] = 1; // left of (1,1)
    wall[0 * 5 + 1] = 1; // above (1,1)
    wall[2 * 5 + 1] = 1; // below (1,1)
    // h = 2 (itself + left), v = 3 (itself + above + below), both > 1.
    expect(placementValue(wall, 1, 1)).toBe(5);
  });

  it('[E1-68] counts runs on both sides of the new tile', () => {
    const wall = emptyWall();
    wall[0] = 1;
    wall[1] = 1;
    wall[3] = 1;
    wall[4] = 1;
    // (0,2) closes the row: a run of five.
    expect(placementValue(wall, 0, 2)).toBe(5);
  });

  it('[E1-68] does not read the cell it is asked about', () => {
    const wall = emptyWall();
    wall[1 * 5 + 0] = 1;
    const unset = placementValue(wall, 1, 1);
    wall[1 * 5 + 1] = 1;
    const set = placementValue(wall, 1, 1);
    expect(set).toBe(unset);
  });

  it('[E1-68] [E1-51] leaves the wall it is given untouched', () => {
    const wall = emptyWall();
    wall[0] = 1;
    const before = wall.slice();
    placementValue(wall, 0, 1);
    expect(wall).toEqual(before);
  });

  /**
   * The requirement that matters. [E1-68] says round scoring computes its gain
   * by calling this, so the corpus that pins round scoring pins this too: if
   * the refactor changed any arithmetic, a recorded score diverges.
   */
  it('[E1-68] leaves every recorded round score unchanged', () => {
    const vectors = loadVectors();
    expect(vectors.length).toBeGreaterThan(30);
    let checked = 0;
    for (const vector of vectors) {
      // The seam of [E1-61], replaying the recorded order by index. A `game`
      // starts at `newGame`, whose creation shuffle is index 0; a `position`
      // is loaded, and loading never shuffles [0002 V2-36].
      const shuffle = (bag: Color[], index: number): void => {
        const recorded = vector.shuffles[index];
        for (let i = 0; i < recorded.length; i++) bag[i] = recorded[i];
      };
      const s =
        vector.kind === 'game'
          ? newGame(0, shuffle)
          : fromCanonical(vector.initial, 0, shuffle);
      for (const ply of vector.plies) {
        apply(s, ply.action);
        expect(s.scores, `${vector.name} ply ${checked} scores`).toEqual(ply.state.scores);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe('fromJSON [E1-69]', () => {
  /** Play `n` plies of a fresh game, taking the first legal action each time. */
  function played(seed: number, n: number): AzulState {
    const s = newGame(seed);
    for (let i = 0; i < n && !s.isTerminal; i++) apply(s, legalActions(s)[0]);
    return s;
  }

  it('[E1-69] reproduces legalActions and tilesLeft for a mid-game position', () => {
    const s = played(999, 25);
    const json = toJSON(s);
    const rebuilt = fromJSON(json, 42);
    expect(legalActions(rebuilt)).toEqual(json.legalActions);
    expect(rebuilt.tilesLeft).toBe(json.tilesLeft);
  });

  it('[E1-69] fills the bag with the reported counts, in ascending colour order', () => {
    const s = played(7, 30);
    const json = toJSON(s);
    const rebuilt = fromJSON(json, 1);
    const counts = [0, 0, 0, 0, 0];
    for (const c of rebuilt.bag) counts[c]++;
    expect(counts).toEqual(json.bag);
    expect(rebuilt.bag).toEqual([...rebuilt.bag].sort((a, b) => a - b));
  });

  it('[E1-69] carries every board field across unchanged', () => {
    const s = played(31337, 40);
    const json = toJSON(s);
    const rebuilt = fromJSON(json, 5);
    const c = toCanonical(rebuilt);
    expect(c.factories).toEqual(json.factories);
    expect(c.center).toEqual(json.center);
    expect(c.markerInCenter).toBe(json.markerInCenter);
    expect(c.lid).toEqual(json.lid);
    expect(c.scores).toEqual(json.scores);
    expect(c.currentPlayer).toBe(json.currentPlayer);
    expect(c.firstPlayer).toBe(json.firstPlayer);
    expect(c.roundIndex).toBe(json.round);
    expect(c.isTerminal).toBe(json.isTerminal);
    expect(c.exhausted).toBe(json.exhausted);
    for (const p of [0, 1] as const) {
      expect(c.walls[p]).toEqual(json.players[p].wall.flat());
      expect(c.plColor[p]).toEqual(json.players[p].patternLines.map((l) => l.color));
      expect(c.plCount[p]).toEqual(json.players[p].patternLines.map((l) => l.count));
      expect(c.floor[p]).toEqual(json.players[p].floor);
      expect(c.floorMarker[p]).toBe(json.players[p].floorMarker);
    }
  });

  it('[E1-69] sets shufflesUsed to 0, which AzulJSON does not carry', () => {
    const s = played(11, 60);
    expect(s.shufflesUsed).toBeGreaterThan(0);
    expect(fromJSON(toJSON(s), 0).shufflesUsed).toBe(0);
  });

  it('[E1-69] [E1-41] throws when tilesLeft disagrees with the board', () => {
    const json = toJSON(newGame(3));
    expect(() => fromJSON({ ...json, tilesLeft: json.tilesLeft + 1 }, 0)).toThrow(/tilesLeft/);
  });

  it('[E1-69] takes the shuffle seam the other constructors take [E1-61]', () => {
    const json = toJSON(newGame(3));
    let seen = -1;
    const rebuilt = fromJSON(json, 0, (_bag, index) => {
      seen = index;
    });
    // Loading itself never shuffles [E1-62]; the seam is held for later.
    expect(seen).toBe(-1);
    expect(rebuilt.shuffle).not.toBeNull();
  });

  it('[E1-69] rebuilds every position in the vector corpus', () => {
    const vectors = loadVectors();
    let checked = 0;
    for (const vector of vectors) {
      for (const ply of vector.plies) {
        const s = fromCanonical(ply.state, 0);
        const json = toJSON(s);
        const rebuilt = fromJSON(json, 0);
        expect(legalActions(rebuilt), `${vector.name} ply ${checked}`).toEqual(json.legalActions);
        expect(rebuilt.tilesLeft).toBe(json.tilesLeft);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  /**
   * The barrier itself [0004 B4-5]: `toJSON` reports counts, so two states
   * differing only in bag order are the same `AzulJSON`, and `fromJSON` cannot
   * be told them apart. This is what makes the bot's information barrier a
   * property of the type rather than a promise.
   */
  it('[E1-69] [E1-52] cannot distinguish two states differing only in bag order', () => {
    const s = played(4242, 20);
    const other = fromCanonical({ ...toCanonical(s), bag: [...s.bag].reverse() }, 0);
    expect(toJSON(other)).toEqual(toJSON(s));
    expect(toCanonical(fromJSON(toJSON(other), 0))).toEqual(
      toCanonical(fromJSON(toJSON(s), 0)),
    );
  });
});

/**
 * `placementValue` against an independent reading of [E1-24], over every cell
 * of a few thousand random walls.
 *
 * The corpus test above proves the engine did not change; this proves the
 * arithmetic is right in the first place, including on walls no game reaches.
 *
 * What makes it a genuine second reading is that it never scans. The
 * implementation walks outward from the cell while occupied; the reference
 * below joins the line into a string and lets a regex find the maximal block
 * covering the index. A reference that walked outward too could only catch a
 * mis-transcription — this one catches an off-by-one in the walk itself.
 */
describe('placementValue against a second reading of [E1-24]', () => {
  /**
   * Deliberately *not* a directional scan. The tile is placed, the line is
   * joined into a string of `0`s and `1`s, and the string is split on `0` —
   * the run is then the length of whichever segment contains the new tile,
   * found by counting how many cells precede it.
   *
   * An earlier version of this walked outward from `col ± 1` while occupied,
   * which is the implementation with one substitution: it could only catch a
   * mis-transcription, never an off-by-one in the scan itself. This can,
   * because it never scans.
   */
  function runLength(cells: readonly number[], at: number): number {
    const line = cells.map((x, i) => (i === at || x ? '1' : '0')).join('');
    // The regex finds every maximal block of occupied cells and where it
    // starts; the run is whichever block covers `at`. No walking outward, so
    // an off-by-one in the implementation's scan cannot be mirrored here.
    for (const match of line.matchAll(/1+/g)) {
      const start = match.index;
      if (at >= start && at < start + match[0].length) return match[0].length;
    }
    throw new Error(`cell ${at} is unoccupied in ${line}`);
  }

  function reference(wall: readonly number[], row: number, col: number): number {
    const across = [0, 1, 2, 3, 4].map((i) => wall[row * 5 + i]);
    const down = [0, 1, 2, 3, 4].map((i) => wall[i * 5 + col]);
    const h = runLength(across, col);
    const v = runLength(down, row);
    if (h === 1 && v === 1) return 1;
    return (h > 1 ? h : 0) + (v > 1 ? v : 0);
  }

  it('[E1-68] [E1-24] agrees on every cell of 2000 random walls', () => {
    let rngState = 20260906;
    const nextBit = (): number => {
      rngState = (Math.imul(rngState, 1103515245) + 12345) | 0;
      return (rngState >>> 16) & 1;
    };
    let compared = 0;
    for (let trial = 0; trial < 2000; trial++) {
      const wall = emptyWall();
      for (let i = 0; i < wall.length; i++) wall[i] = nextBit();
      for (let row = 0; row < NUM_ROWS; row++) {
        for (let col = 0; col < NUM_COLORS; col++) {
          if (wall[row * 5 + col]) continue; // [E1-68] asks about an unset cell
          expect(placementValue(wall, row, col), `wall ${wall.join('')} at ${row},${col}`).toBe(
            reference(wall, row, col),
          );
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(20_000);
  });

  it('[E1-68] [E1-1] scores a lone tile as 1 at every colour cell of the real wall', () => {
    for (let c = 0; c < NUM_COLORS; c++) {
      for (let r = 0; r < NUM_ROWS; r++) {
        expect(placementValue(emptyWall(), r, wallCol(c, r))).toBe(1);
      }
    }
  });
});
