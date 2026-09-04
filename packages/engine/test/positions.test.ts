/**
 * What the seven handcrafted positions are *for* [0002 V2-16].
 *
 * `replay.test.ts` already proves the port agrees with the oracle on every ply
 * of these fixtures. This file asserts that each fixture still exercises the
 * situation it was built for — a position that quietly stopped covering its
 * requirement would otherwise keep passing forever.
 *
 * Everything below reads the recorded oracle states, so these are assertions
 * about behaviour, not restatements of the fixture's own note.
 */

import { describe, expect, it } from 'vitest';
import {
  COLOR_BONUS,
  COL_BONUS,
  NUM_ROWS,
  ROW_BONUS,
  completedColors,
  completedCols,
  completedRows,
  floorOccupied,
  floorPenalty,
  fromCanonical,
} from '../src/index.js';
import { loadVectors, type Vector } from './support/vectors.js';

function position(slug: string): Vector {
  const v = loadVectors().find((x) => x.name === `${slug}.json`);
  if (v === undefined) throw new Error(`missing fixture ${slug} [V2-16]`);
  return v;
}

/** The ply at which a round resolved — the one whose `roundIndex` moved. */
function resolutionPly(v: Vector): number {
  let round = v.initial.roundIndex;
  for (let i = 0; i < v.plies.length; i++) {
    if (v.plies[i].state.roundIndex !== round) return i;
    round = v.plies[i].state.roundIndex;
  }
  throw new Error(`${v.name}: no round resolved`);
}

describe('handcrafted positions [V2-16]', () => {
  it('all seven exist and carry a note [V2-17]', () => {
    const slugs = [
      'position-01-two-runs',
      'position-02-cascade',
      'position-03-overfull-floor',
      'position-04-clamped-penalty',
      'position-05-empty-bag-and-lid',
      'position-06-untouched-centre',
      'position-07-column-and-colour',
    ];
    for (const slug of slugs) {
      const v = position(slug);
      expect(v.kind).toBe('position');
      expect(v.note, slug).toBeTruthy();
    }
  });

  it('scores both runs when a tile joins a horizontal and a vertical at once [E1-24]', () => {
    const v = position('position-01-two-runs');
    const i = resolutionPly(v);
    const before = i === 0 ? v.initial : v.plies[i - 1].state;
    const after = v.plies[i].state;
    // The tile lands on (2,2) with (2,1), (2,3), (1,2) and (3,2) already set:
    // h = 3 and v = 3, so 6 — against 1 for an engine that scores the tile
    // alone, and 3 for one that counts only the longer run.
    expect(before.plCount[0][2]).toBe(3);
    expect(after.walls[0][2 * 5 + 2]).toBe(1);
    const floorTiles = before.floor[0].reduce((a, b) => a + b, 0);
    expect(floorTiles).toBe(1); // one floor tile, so the penalty is exactly -1
    expect(after.scores[0] - before.scores[0]).toBe(6 - 1);
  });

  it('lets a later line score off a tile an earlier one just placed [E1-25]', () => {
    const v = position('position-02-cascade');
    const i = resolutionPly(v);
    const before = i === 0 ? v.initial : v.plies[i - 1].state;
    const after = v.plies[i].state;
    // Row 0 places colour 1 at (0,1); row 1 then places colour 0 at (1,1) and
    // sees it, scoring 2. Resolve bottom-up and the total is 1 + 1.
    expect(before.plCount[0][0]).toBe(1);
    expect(before.plCount[0][1]).toBe(2);
    expect(after.walls[0][0 * 5 + 1]).toBe(1);
    expect(after.walls[0][1 * 5 + 1]).toBe(1);
    expect(after.scores[0] - before.scores[0]).toBe(1 + 2 - 1);
  });

  it('counts the marker as a floor slot and stops the penalty at seven [E1-20], [E1-26], [E1-27]', () => {
    const v = position('position-03-overfull-floor');
    // Player 0 holds seven floor tiles and then takes the marker.
    const overfull = v.plies.find((p) => {
      const s = p.state;
      return s.floorMarker[0] && s.floor[0].reduce((a, b) => a + b, 0) === 7;
    });
    expect(overfull, 'no ply reaches eight occupied slots').toBeDefined();
    const s = fromCanonical(overfull!.state, 0);
    expect(floorOccupied(s, 0)).toBe(8);
    expect(floorPenalty(s, 0)).toBe(-14); // the eighth slot costs nothing
    // The tile that could not fit went straight to the lid, not onto the floor.
    const i = v.plies.indexOf(overfull!);
    const before = i === 0 ? v.initial : v.plies[i - 1].state;
    expect(overfull!.state.floor[0]).toEqual(before.floor[0]);
    expect(overfull!.state.lid.reduce((a, b) => a + b, 0)).toBeGreaterThan(
      before.lid.reduce((a, b) => a + b, 0),
    );

    const r = resolutionPly(v);
    expect(v.plies[r].state.scores[0]).toBe(v.plies[r - 1].state.scores[0] - 14);
  });

  it('clamps a round at zero rather than carrying a debt forward [E1-28]', () => {
    const v = position('position-04-clamped-penalty');
    const i = resolutionPly(v);
    const before = v.plies[i - 1].state;
    const after = v.plies[i].state;
    expect(before.scores[0]).toBe(3);
    expect(before.floor[0].reduce((a, b) => a + b, 0)).toBe(7); // a -14 penalty
    expect(after.scores[0]).toBe(0); // not -11
    // And the debt does not reappear: later plies stay at zero.
    for (const ply of v.plies.slice(i)) expect(ply.state.scores[0]).toBe(0);
  });

  it('recycles the lid, deals short, then deals nothing at all [E1-33], [E1-34], [E1-37]', () => {
    const v = position('position-05-empty-bag-and-lid');
    expect(v.census).toBe('short');
    const census = v.initial.bag.length + v.initial.lid.reduce((a, b) => a + b, 0);
    expect(census).toBeLessThan(100);

    let round = v.initial.roundIndex;
    let recycle = -1;
    let shortDeal = -1;
    let shuffles = v.initial.shufflesUsed;
    for (let i = 0; i < v.plies.length; i++) {
      const s = v.plies[i].state;
      if (s.roundIndex !== round) {
        // [E1-33] a draw found the bag empty, so the lid was recycled and
        // shuffled — the one place a refill consumes randomness.
        if (s.shufflesUsed > shuffles && recycle < 0) recycle = i;
        // [E1-34] bag and lid both ran out mid-deal, leaving displays short.
        if (s.tilesLeft > 0 && s.tilesLeft < 20 && shortDeal < 0) shortDeal = i;
        round = s.roundIndex;
      }
      shuffles = s.shufflesUsed;
    }
    expect(recycle, 'no lid recycle [E1-33]').toBeGreaterThanOrEqual(0);
    expect(shortDeal, 'no partial deal [E1-34]').toBeGreaterThanOrEqual(0);
    expect(recycle).toBeLessThan(shortDeal);

    // [E1-37] the last refill deals nothing at all: the game stops and says so.
    const last = v.plies[v.plies.length - 1].state;
    expect(last.isTerminal).toBe(true);
    expect(last.exhausted).toBe(true);
    expect(shortDeal).toBeLessThan(v.plies.length - 1);
    expect(v.final.exhausted).toBe(true);
  });

  it('starts the next round by alternation when nobody took the centre [E1-31]', () => {
    const v = position('position-06-untouched-centre');
    const i = resolutionPly(v);
    // Nothing reached the centre all round — every display was monochrome —
    // so the marker never left it.
    for (let k = 0; k <= i; k++) {
      expect(v.plies[k].state.center, `ply ${k}`).toEqual([0, 0, 0, 0, 0]);
    }
    expect(v.plies[i].state.markerInCenter).toBe(true);
    expect(v.plies[i].state.floorMarker).toEqual([false, false]);
    // The player who did not move last starts, preserving alternation.
    const lastMover = i === 0 ? v.initial.currentPlayer : v.plies[i - 1].state.currentPlayer;
    expect(v.plies[i].state.firstPlayer).toBe(1 - lastMover);
    expect(v.plies[i].state.currentPlayer).toBe(1 - lastMover);
  });

  it('adds the row, column and colour bonuses on ending [E1-38]', () => {
    const v = position('position-07-column-and-colour');
    const i = v.plies.findIndex((p) => p.state.isTerminal);
    expect(i).toBeGreaterThanOrEqual(0);
    const before = i === 0 ? v.initial : v.plies[i - 1].state;
    const s = fromCanonical(v.plies[i].state, 0);
    expect(completedRows(s, 0)).toBe(1);
    expect(completedCols(s, 0)).toBe(1);
    expect(completedColors(s, 0)).toBe(1);
    const bonus = ROW_BONUS * 1 + COL_BONUS * 1 + COLOR_BONUS * 1;
    // The round scored 10 for the two five-long runs, less one floor tile;
    // the bonuses are added on top, and are not clamped by [E1-28].
    expect(v.plies[i].state.scores[0]).toBe(before.scores[0] + 10 - 1 + bonus);
    expect(bonus).toBe(19);
    // The wall really does hold a full row, a full column and a full colour.
    let rowCells = 0;
    for (let col = 0; col < NUM_ROWS; col++) rowCells += s.walls[0][col];
    expect(rowCells).toBe(5);
  });
});
