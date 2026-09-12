/**
 * What the original held, against what we hold [A8-35], [A8-12], [A8-52].
 *
 * [A8-35] is, stated honestly, a cross-language regression check between two
 * encoders written from one table: if both readers made the same mistake it
 * passes. The two checks that do not share that weakness are here beside it —
 * [A8-12], where the original's `valid_moves` interprets the board by its own
 * rules, and [A8-52], where the original's own opening board vouches for the
 * conventions nobody could derive from the table.
 *
 * Neither of those reaches every row. `valid_moves` reads the centre, the
 * displays and the pattern lines, and not the bag, the lid or the floor
 * counts — its `line_free[5]`/`wall_colour_free[5]` are unconditionally true,
 * so the floor is never what makes a move legal or illegal. The opening board
 * is one position. What reaches the rest is [A8-36] in `transitions.test.ts`,
 * where the original deals from row 1 by its own rules and recycles row 2 into
 * it: a shared misreading there deals different tiles and fails.
 */

import { describe, expect, it } from 'vitest';
import { newGame, toJSON } from 'engine';
import { EXPERT, encodeBoard, toTheirAction } from '../src/index.js';
import { fixtures, manifest } from './support/fixtures.js';

const POSITIONS = fixtures();
const MANIFEST = manifest();

describe('the fixtures [A8-34]', () => {
  it('[A8-34] cover whole games from every kind of player', () => {
    expect(POSITIONS.length).toBeGreaterThan(300);
    const players = new Set(MANIFEST.games.flatMap((g) => g.players.map((p) => p.split(':')[0])));
    expect([...players].sort()).toEqual(['easy', 'random', 'sharp', 'steady']);
    // Every ply of every game, the last round included.
    for (const game of MANIFEST.games) {
      const plies = POSITIONS.filter((p) => p.game === game.id);
      expect(plies.length, game.id).toBe(game.actions.length);
    }
  });

  it('[A8-34] record the constants this package plays with', () => {
    const recorded = MANIFEST.constants;
    expect(recorded['numMCTSSims']).toBe(EXPERT.simulations);
    expect(recorded['cpuct']).toBe(EXPERT.cpuct);
    expect(recorded['fpu']).toBe(EXPERT.fpu);
    expect(recorded['forcedPlayouts']).toBe(EXPERT.forcedPlayouts);
    expect(recorded['k']).toBe(EXPERT.k);
    expect(recorded['universeSeed']).toBe(EXPERT.universeSeed);
    expect(recorded['universes']).toBe(1); // which is why one seed is enough
    expect(recorded['drawValue']).toBe(Math.fround(EXPERT.drawValue));
    expect(recorded['nn_version']).toBe(84);
  });
});

describe('the board, against the original [A8-35]', () => {
  it('[A8-35] equals the original’s board on every fixture position', () => {
    for (const record of POSITIONS) {
      const ours = encodeBoard(record.position);
      expect([...ours], `${record.game} ply ${record.ply}`).toEqual([...record.board]);
    }
  });
});

describe('legality, against the original [A8-12]', () => {
  it('[A8-12] our legal actions are exactly the ones its valid_moves accepts', () => {
    for (const record of POSITIONS) {
      const ours = record.position.legalActions.map(toTheirAction).sort((a, b) => a - b);
      const theirs: number[] = [];
      for (let a = 0; a < 180; a++) {
        if (record.mask[a] !== 0) theirs.push(a);
      }
      expect(ours, `${record.game} ply ${record.ply}`).toEqual(theirs);
      expect(ours.length).toBeGreaterThan(0);
    }
  });
});

describe('the opening board, against the original [A8-52]', () => {
  it('[A8-52] matches on every row a deal does not touch', () => {
    // The original deals its own opening, so rows 1–8 differ by construction.
    // What is left is everything the table could not have told either of us:
    // the round starts at 1, an empty pattern line is -1, the marker starts in
    // the centre, and both walls start empty.
    const ours = encodeBoard(toJSON(newGame(20260911)));
    const theirs = MANIFEST.initialBoard;
    const rows = [0, ...Array.from({ length: 14 }, (_, i) => 9 + i)];
    for (const r of rows) {
      expect([...ours.slice(r * 6, r * 6 + 6)], `row ${r}`).toEqual(theirs.slice(r * 6, r * 6 + 6));
    }
    expect(ours[3 * 6 + 5], 'the marker starts in the centre').toBe(theirs[3 * 6 + 5]);
    // And the rows a deal touches really do differ, so the exclusion above is
    // not quietly excluding everything.
    expect([...ours.slice(6, 9 * 6)]).not.toEqual(theirs.slice(6, 9 * 6));
  });
});
