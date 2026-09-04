/**
 * The rules of a ply, of round resolution and of the refill, exercised
 * directly. The vectors prove agreement with the oracle; these pin the
 * individual requirements to positions chosen to isolate them, which is what
 * makes a failure readable.
 *
 * Every position here is built through the engine's own surface — `newGame`
 * with a chosen bag order through the shuffle seam, or `fromCanonical` — never
 * by writing state fields [0002 V2-3].
 */

import { describe, expect, it } from 'vitest';
import {
  CENTER,
  FLOOR,
  NUM_COLORS,
  apply,
  encodeAction,
  floorOccupied,
  floorPenalty,
  fromCanonical,
  legalActions,
  outcome,
  recount,
  toCanonical,
  wallCol,
  type AzulState,
  type CanonicalState,
  type Color,
} from '../src/index.js';
import { gameDealing, mono } from './support/fixtures.js';
import { gameVectors, loadVectors } from './support/vectors.js';

/** Plays to the floor until the round index changes, then stops. */
function playRoundToFloor(s: AzulState): void {
  const round = s.roundIndex;
  while (s.roundIndex === round && !s.isTerminal) {
    const floorMove = legalActions(s).find((a) => a % 6 === FLOOR);
    if (floorMove === undefined) throw new Error('no floor move [E1-12]');
    apply(s, floorMove);
  }
}

describe('taking tiles', () => {
  const mixed = (): AzulState =>
    gameDealing([0, 0, 1, 1, 2, 2, 3, 3, ...mono(4), ...mono(0), ...mono(1)] as Color[]);

  it('removes every tile of the colour from the source [E1-15]', () => {
    const s = mixed();
    expect(s.factories[0]).toEqual([2, 2, 0, 0, 0]);
    apply(s, encodeAction(0, 0, FLOOR));
    expect(s.factories[0][0]).toBe(0);
    expect(s.floor[0][0]).toBe(2);
  });

  it('pushes the rest of a display into the centre [E1-16]', () => {
    const s = mixed();
    apply(s, encodeAction(0, 0, FLOOR));
    expect(s.factories[0]).toEqual([0, 0, 0, 0, 0]);
    expect(s.center).toEqual([0, 2, 0, 0, 0]);
    // A take from the centre moves nothing anywhere else.
    apply(s, encodeAction(CENTER, 1, FLOOR));
    expect(s.center).toEqual([0, 0, 0, 0, 0]);
  });

  it('moves the marker on the first take from the centre only [E1-17]', () => {
    const s = mixed();
    expect(s.markerInCenter).toBe(true);
    apply(s, encodeAction(0, 0, FLOOR)); // player 0: two yellow reach the centre
    apply(s, encodeAction(CENTER, 1, FLOOR)); // player 1 takes them, and the marker
    expect(s.markerInCenter).toBe(false);
    expect(s.floorMarker).toEqual([false, true]);
    expect(s.floor[1]).toEqual([0, 2, 0, 0, 0]); // the marker is not a tile [E1-3]

    apply(s, encodeAction(1, 2, FLOOR)); // player 0: two red taken, two black to the centre
    expect(s.center).toEqual([0, 0, 0, 2, 0]);
    apply(s, encodeAction(CENTER, 3, FLOOR)); // a later centre take moves no marker
    expect(s.markerInCenter).toBe(false);
    expect(s.floorMarker).toEqual([false, true]);
  });

  it('stores the floor as counts per colour, with the marker apart [E1-3]', () => {
    const s = mixed();
    apply(s, encodeAction(0, 0, FLOOR));
    apply(s, encodeAction(CENTER, 1, FLOOR));
    expect(s.floor[1].length).toBe(NUM_COLORS);
    // Two tiles and a marker: three occupied slots, but only two tile counts.
    expect(s.floor[1].reduce((a, b) => a + b, 0)).toBe(2);
    expect(floorOccupied(s, 1)).toBe(3);
  });

  it('fills a pattern line to capacity and overflows the surplus [E1-18]', () => {
    // Display 0 holds three blue; row 0 takes one and the other two spill.
    const s = gameDealing([0, 0, 0, 1, ...mono(2), ...mono(3), ...mono(4), ...mono(1)] as Color[]);
    apply(s, encodeAction(0, 0, 0));
    expect(s.plCount[0][0]).toBe(1);
    expect(s.plColor[0][0]).toBe(0);
    expect(s.floor[0]).toEqual([2, 0, 0, 0, 0]);
  });

  it('overflows every tile when the destination is the floor [E1-19]', () => {
    const s = gameDealing([...mono(0), ...mono(1), ...mono(2), ...mono(3), ...mono(4)]);
    apply(s, encodeAction(0, 0, FLOOR));
    expect(s.floor[0]).toEqual([4, 0, 0, 0, 0]);
    expect(s.plCount[0]).toEqual([0, 0, 0, 0, 0]);
  });

  it('caps the floor at seven slots, marker included, and lids the rest [E1-20]', () => {
    const s = gameDealing([...mono(0), ...mono(1), 2, 2, 3, 3, ...mono(4), 0, 1, 2, 3] as Color[]);
    apply(s, encodeAction(0, 0, FLOOR)); // player 0: four blue on the floor
    apply(s, encodeAction(1, 1, FLOOR)); // player 1
    apply(s, encodeAction(3, 4, FLOOR)); // player 0: four teal onto four occupied slots
    expect(s.floor[0]).toEqual([4, 0, 0, 0, 3]); // only three of the four teal fitted
    expect(s.lid[4]).toBe(1); // the fourth went straight to the lid
    expect(floorOccupied(s, 0)).toBe(7);

    apply(s, encodeAction(2, 2, FLOOR)); // player 1: two black reach the centre
    // Player 0 now takes the marker onto an already-full floor: occupancy goes
    // past seven [E1-26] and the tiles taken go straight to the lid.
    apply(s, encodeAction(CENTER, 3, FLOOR));
    expect(s.floorMarker[0]).toBe(true);
    expect(floorOccupied(s, 0)).toBe(8);
    expect(s.floor[0][3]).toBe(0);
    expect(s.lid[3]).toBe(2);
    // Slots beyond the seventh cost nothing [E1-27].
    expect(floorPenalty(s, 0)).toBe(-14);
  });

  it('counts occupied slots with the marker and stops the penalty at seven [E1-26], [E1-27]', () => {
    const s = gameDealing([...mono(0), ...mono(1), ...mono(2), ...mono(3), ...mono(4)]);
    expect(floorOccupied(s, 0)).toBe(0);
    expect(floorPenalty(s, 0)).toBe(0);
    apply(s, encodeAction(0, 0, FLOOR));
    expect(floorOccupied(s, 0)).toBe(4);
    expect(floorPenalty(s, 0)).toBe(-6); // -1 -1 -2 -2
  });

  it('decrements tilesLeft, passes the turn, and resolves at zero [E1-21]', () => {
    const s = gameDealing([...mono(0), ...mono(1), ...mono(2), ...mono(3), ...mono(4)]);
    expect(s.tilesLeft).toBe(20);
    expect(s.currentPlayer).toBe(0);
    apply(s, encodeAction(0, 0, FLOOR));
    expect(s.tilesLeft).toBe(16);
    expect(s.currentPlayer).toBe(1);
    apply(s, encodeAction(1, 1, FLOOR));
    expect(s.tilesLeft).toBe(12);
    expect(s.currentPlayer).toBe(0);
    apply(s, encodeAction(2, 2, FLOOR));
    apply(s, encodeAction(3, 3, FLOOR));
    expect(s.tilesLeft).toBe(4);
    expect(s.roundIndex).toBe(0);
    // The last take of the round runs the whole resolution inside this call.
    apply(s, encodeAction(4, 4, FLOOR));
    expect(s.roundIndex).toBe(1);
    expect(s.tilesLeft).toBe(20); // already refilled
  });
});

describe('round resolution', () => {
  /**
   * Five monochrome displays, so the round is exactly five plies and nothing
   * ever reaches the centre.
   */
  function monoRound(): AzulState {
    return gameDealing([...mono(0), ...mono(1), ...mono(2), ...mono(3), ...mono(4)]);
  }

  it('resolves only full lines, and leaves a partial one alone [E1-22]', () => {
    const s = monoRound();
    apply(s, encodeAction(0, 0, 3)); // player 0 fills row 3 exactly (four tiles)
    apply(s, encodeAction(1, 1, FLOOR));
    apply(s, encodeAction(2, 2, 4)); // player 0 puts four of five into row 4
    apply(s, encodeAction(3, 3, FLOOR));
    expect(s.plCount[0]).toEqual([0, 0, 0, 4, 4]);
    apply(s, encodeAction(4, 4, FLOOR)); // round resolves

    // Row 3 tiled and emptied; row 4 waits for next round untouched.
    expect(s.plCount[0]).toEqual([0, 0, 0, 0, 4]);
    expect(s.plColor[0]).toEqual([-1, -1, -1, -1, 2]);
    expect(s.walls[0][3 * 5 + wallCol(0, 3)]).toBe(1);
  });

  it('places one tile, lids the other r, and empties the line [E1-23]', () => {
    const s = monoRound();
    apply(s, encodeAction(0, 0, 3));
    apply(s, encodeAction(1, 1, FLOOR));
    apply(s, encodeAction(2, 2, FLOOR));
    apply(s, encodeAction(3, 3, FLOOR));
    const lidBefore = s.lid[0];
    apply(s, encodeAction(4, 4, FLOOR));
    expect(s.walls[0].reduce((a, b) => a + b, 0)).toBe(1);
    expect(s.lid[0]).toBe(lidBefore + 3); // the three leftovers of a four-tile line
    expect(s.plCount[0][3]).toBe(0);
    expect(s.plColor[0][3]).toBe(-1);
  });

  it('sends every floor tile to the lid at round end [E1-29]', () => {
    const s = monoRound();
    playRoundToFloor(s);
    expect(s.floor[0]).toEqual([0, 0, 0, 0, 0]);
    expect(s.floor[1]).toEqual([0, 0, 0, 0, 0]);
    expect(s.lid.reduce((a, b) => a + b, 0)).toBe(20);
  });

  it('hands the marker back to the centre and starts the holder [E1-30]', () => {
    const s = gameDealing([0, 0, 1, 1, ...mono(2), ...mono(3), ...mono(4), ...mono(0)] as Color[]);
    apply(s, encodeAction(0, 0, FLOOR)); // two yellow reach the centre
    apply(s, encodeAction(CENTER, 1, FLOOR)); // player 1 takes the marker
    expect(s.floorMarker[1]).toBe(true);
    while (s.roundIndex === 0) {
      apply(s, legalActions(s).find((a) => a % 6 === FLOOR)!);
    }
    expect(s.markerInCenter).toBe(true);
    expect(s.floorMarker).toEqual([false, false]);
    expect(s.firstPlayer).toBe(1);
    expect(s.currentPlayer).toBe(1);
  });

  it('counts round transitions, not deals [E1-35]', () => {
    const s = gameDealing([...mono(0), ...mono(1), ...mono(2), ...mono(3), ...mono(4)]);
    // A fresh game has dealt its first round and is still at 0. An engine that
    // reported 1 here would mismatch every vector from its first ply.
    expect(s.roundIndex).toBe(0);
    playRoundToFloor(s);
    expect(s.roundIndex).toBe(1);
    playRoundToFloor(s);
    expect(s.roundIndex).toBe(2);
  });
});

describe('the refill', () => {
  it('deals four to each display in order, from the end of the bag [E1-32]', () => {
    // `gameDealing` writes its argument into the tail of the bag, last tile
    // first; if the engine dealt from the head, or out of display order, these
    // displays would not hold what the fixture says they hold.
    const dealt: Color[] = [0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4];
    const s = gameDealing(dealt);
    for (let i = 0; i < 5; i++) {
      const expected = [0, 0, 0, 0, 0];
      for (let k = 0; k < 4; k++) expected[dealt[i * 4 + k]]++;
      expect(s.factories[i], `display ${i}`).toEqual(expected);
    }
    expect(s.bag.length).toBe(80);
    expect(s.tilesLeft).toBe(20);
  });

  it('recycles when a draw finds the bag empty, not when it reaches zero [E1-33]', () => {
    // Floor-only play returns every tile to the lid and puts none on a wall,
    // so the game runs on and the bag drains exactly 20 a round. The fifth
    // refill consumes the last tile of the bag; the recycle must wait for the
    // sixth refill's first draw. An eager implementation shuffles one round
    // early and deals a different game from that moment on.
    let calls = 0;
    const s = gameDealing([...mono(0), ...mono(1), ...mono(2), ...mono(3), ...mono(4)]);
    expect(s.shufflesUsed).toBe(1);
    for (let round = 1; round <= 4; round++) {
      playRoundToFloor(s);
      expect(s.bag.length, `after refill ${round + 1}`).toBe(80 - 20 * round);
      expect(s.shufflesUsed, `after refill ${round + 1}`).toBe(1);
    }
    expect(s.bag.length).toBe(0); // the fifth deal consumed the last tile exactly
    expect(s.lid.reduce((a, b) => a + b, 0)).toBe(80);
    expect(s.shufflesUsed).toBe(1);
    calls = s.shufflesUsed;

    playRoundToFloor(s); // the sixth refill's first draw finds the bag empty
    expect(s.shufflesUsed).toBe(calls + 1);
    expect(s.lid).toEqual([0, 0, 0, 0, 0]);
    expect(s.bag.length).toBe(80);
  });
});

describe('game end', () => {
  it('ends after the round in which a wall row completes [E1-36]', () => {
    for (const v of gameVectors()) {
      let sawComplete = false;
      for (const ply of v.plies) {
        const complete = ply.state.walls.some((wall) =>
          [0, 5, 10, 15, 20].some((base) => wall.slice(base, base + 5).every((x) => x === 1)),
        );
        if (complete) sawComplete = true;
        // A row can only appear at a round resolution, and the state that has
        // one is terminal in the same `apply`.
        expect(complete, `${v.name}: complete row without a terminal state`).toBe(
          ply.state.isTerminal,
        );
      }
      expect(sawComplete, v.name).toBe(true);
    }
  });

  it('reports +1, -1, 0 and null as the spec states [E1-39]', () => {
    const vectors = loadVectors();
    // Unfinished.
    const running = fromCanonical(vectors[0].plies[0].state, 0);
    expect(outcome(running)).toBeNull();
    // Decided, both directions, straight off the recordings.
    const wins = vectors.filter((v) => v.final.outcome === 1);
    const losses = vectors.filter((v) => v.final.outcome === -1);
    const draws = vectors.filter((v) => v.final.outcome === 0);
    expect(wins.length).toBeGreaterThan(0);
    expect(losses.length).toBeGreaterThan(0);
    expect(draws.length).toBeGreaterThan(0);
    for (const v of [wins[0], losses[0], draws[0]]) {
      const s = fromCanonical(v.plies[v.plies.length - 1].state, 0);
      expect(outcome(s), v.name).toBe(v.final.outcome);
    }

    // A tie on score breaks on complete rows. No recorded game happens to end
    // level on score with unequal rows, so the position is posed by loading a
    // recorded terminal snapshot with the two scores levelled — a canonical
    // snapshot is plain data and `fromCanonical` is the sanctioned way in
    // [E1-62], which is not the field-poking [0002 V2-3] forbids.
    const unequalRows = vectors.find((v) => {
      const last = v.plies[v.plies.length - 1].state;
      if (!last.isTerminal) return false;
      const rows = last.walls.map((wall) =>
        [0, 5, 10, 15, 20].filter((b) => wall.slice(b, b + 5).every((x) => x === 1)).length,
      );
      return rows[0] !== rows[1];
    });
    expect(unequalRows).toBeDefined();
    const snapshot: CanonicalState = {
      ...unequalRows!.plies[unequalRows!.plies.length - 1].state,
      scores: [40, 40],
    };
    const rows = snapshot.walls.map((wall) =>
      [0, 5, 10, 15, 20].filter((b) => wall.slice(b, b + 5).every((x) => x === 1)).length,
    );
    expect(outcome(fromCanonical(snapshot, 0))).toBe(rows[0] > rows[1] ? 1 : -1);
  });
});

describe('derived state', () => {
  it('rebuilds only what the board implies, leaving the counters alone [E1-5]', () => {
    const v = gameVectors()[0];
    for (const index of [0, 10, 40]) {
      const s = fromCanonical(v.plies[index].state, 0);
      const before = toCanonical(s);
      // The engine keeps everything current on every `apply`, so `recount` on
      // an untouched state is a no-op — `shufflesUsed` included, which no
      // board implies and which `recount` must therefore not touch.
      recount(s);
      expect(toCanonical(s), `ply ${index}`).toEqual(before);
      expect(s.shufflesUsed).toBe(before.shufflesUsed);
    }
  });
});
