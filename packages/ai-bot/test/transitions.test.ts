/**
 * Every recorded ply, played by both programs [A8-36], [A8-51].
 *
 * This is the check the universe draw rests on. The board after a ply is
 * compared against the original's board after the same ply, boundary plies
 * included — and a boundary ply is a deal, so what is really being compared
 * there is the guess about what a future round deals: our engine popping an
 * order written down from the bag's counts, against the original's
 * `select_tiles_from_bag` drawing from the same counts.
 *
 * It is also the first check that reaches rows 1 and 2. [A8-35] compares two
 * encoders written from one table and [A8-12]'s `valid_moves` never reads
 * those rows, so before this a mistake shared by `src/board.ts` and
 * `tools/encoder.py` in the bag row or the lid row would pass everything. Here
 * the original deals from row 1 by its own rules, so a bag row that disagrees
 * deals different tiles. Row 2 is anchored where a round ends, when the lid
 * becomes the bag.
 *
 * Where the two programs disagree by design, *Known deviations* says so, and
 * each case is recognised by its condition, reported by name, and compared
 * only where that row allows. Any other difference fails.
 */

import { describe, expect, it } from 'vitest';
import { apply, clone, toJSON } from 'engine';
import { encodeBoard } from '../src/index.js';
import { universeRoot } from '../src/universe.js';
import { fixtures, manifest, type FixturePosition } from './support/fixtures.js';

const POSITIONS = fixtures();
const MANIFEST = manifest();

const COLS = 6;
const cell = (row: number, col: number): number => row * COLS + col;

/** The same board seen from the other seat, which is what `swap_players` does. */
function swapSeats(board: Int8Array): Int8Array {
  const out = Int8Array.from(board);
  out[cell(0, 0)] = board[cell(0, 1)];
  out[cell(0, 1)] = board[cell(0, 0)];
  const swapRows = (a: number, b: number): void => {
    for (let c = 0; c < COLS; c++) {
      out[cell(a, c)] = board[cell(b, c)];
      out[cell(b, c)] = board[cell(a, c)];
    }
  };
  swapRows(9, 10);
  swapRows(11, 12);
  for (let r = 0; r < 5; r++) swapRows(13 + r, 18 + r);
  return out;
}

interface Comparison {
  /** Deviation conditions that hold on this ply, by their names in the spec. */
  deviations: string[];
  /** Cells compared: `false` is one a deviation excuses. */
  compared: boolean[];
  ours: Int8Array;
  theirs: Int8Array;
}

/**
 * What to compare on this ply, and what *Known deviations* excuses.
 *
 * Each condition is decided from the original's board and the ply, never from
 * a rule re-implemented here: the seat to move comes from our engine and from
 * the original's own `next_player`, the floor counts from its board, the
 * scores from ours.
 */
function compare(record: FixturePosition): Comparison {
  const root = universeRoot(record.position);
  const child = clone(root);
  apply(child, record.action);
  const after = toJSON(child);
  let ours = encodeBoard(after);
  const theirs = record.theirs;

  const deviations: string[] = [];
  const compared = new Array<boolean>(138).fill(true);
  const exclude = (row: number, col: number): void => {
    compared[cell(row, col)] = false;
  };

  // `no-centre-take`: a round ended with the marker still in the centre, so
  // our engine gives the other seat the start and the original's search leaves
  // the last mover to move. Decided by the two programs' own answers, not by
  // either's rule: ours is the seat to move, theirs is `next_player`.
  const sameMoverHere = after.currentPlayer === record.position.currentPlayer;
  const sameMoverThere = record.theirNextPlayer === 0;
  if (sameMoverHere !== sameMoverThere) {
    deviations.push('no-centre-take');
    // Rows 1–8 and the round hold the deal and are compared as they are; the
    // seat-owned rows are compared swapped.
    ours = swapSeats(ours);
  }

  // `terminal-deal`: our engine ends the game before any refill; the original
  // deals five displays, increments the round and scores bonuses.
  if (after.isTerminal) {
    deviations.push('terminal-deal');
    for (let r = 1; r <= 8; r++) {
      for (let c = 0; c < COLS; c++) exclude(r, c);
    }
    for (let c = 2; c < COLS; c++) exclude(0, c);
  }

  // `floor-overflow`: tiles past the seventh slot go to our lid and keep
  // counting on theirs.
  // Exactly the table's condition. Our count is `min(tiles, 7) + marker` and
  // theirs is every tile ever placed plus the marker, so theirs is never the
  // smaller of the two: testing ours as well would add a clause that cannot
  // fire and that a later reader would take for a live one.
  if (theirs[cell(11, 5)] > 7 || theirs[cell(12, 5)] > 7) {
    deviations.push('floor-overflow');
    exclude(11, 5);
    exclude(12, 5);
  }

  // `score-wrap`: a score reaches 128, which our engine keeps and the
  // original's 8-bit board wraps.
  if (after.scores.some((score) => score > 127) || theirs[cell(0, 0)] < 0 || theirs[cell(0, 1)] < 0) {
    deviations.push('score-wrap');
    exclude(0, 0);
    exclude(0, 1);
  }

  return { deviations, compared, ours, theirs };
}

const COMPARISONS = POSITIONS.map((record) => ({ record, ...compare(record) }));

describe('every recorded ply, against the original [A8-36]', () => {
  it('[A8-36] reaches the same board, wherever Known deviations does not say otherwise', () => {
    const failures: string[] = [];
    for (const { record, deviations, compared, ours, theirs } of COMPARISONS) {
      for (let i = 0; i < 138; i++) {
        if (!compared[i]) continue;
        if (ours[i] !== theirs[i]) {
          failures.push(
            `${record.game} ply ${record.ply} row ${Math.floor(i / COLS)} col ${i % COLS}: ` +
              `ours ${ours[i]}, theirs ${theirs[i]}` +
              (deviations.length > 0 ? ` (deviations: ${deviations.join(', ')})` : ''),
          );
        }
      }
    }
    expect(failures.slice(0, 20).join('\n')).toBe('');
    expect(COMPARISONS.length).toBeGreaterThan(400);
  });

  it('[A8-36] compares the boundary plies, which is what checks the universe draw', () => {
    // A boundary ply is one that ended a round: its board holds a deal neither
    // program was told, computed from the bag's counts on both sides.
    const boundaries = COMPARISONS.filter(
      ({ record }) =>
        !record.position.isTerminal &&
        MANIFEST.games.find((g) => g.id === record.game)!.deals.some((d) => d.ply === record.ply),
    );
    expect(boundaries.length).toBeGreaterThan(20);
    for (const boundary of boundaries) {
      // Rows 1–8 are the bag and what it dealt, and no deviation excuses them
      // on a ply that is not terminal.
      for (let r = 1; r <= 8; r++) {
        for (let c = 0; c < COLS; c++) {
          expect(boundary.compared[cell(r, c)], `${boundary.record.game} ply ${boundary.record.ply}`).toBe(true);
        }
      }
    }
  });

  it('[A8-36] reports which deviations the corpus actually tripped', () => {
    const counts = new Map<string, number>();
    for (const { deviations } of COMPARISONS) {
      for (const name of deviations) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const known = ['terminal-deal', 'floor-overflow', 'no-centre-take', 'score-wrap', 'exhausted', 'late-tie'];
    for (const name of counts.keys()) expect(known).toContain(name);
    // Most plies deviate in no way at all; if that stopped being true the
    // comparison above would be excusing itself into vacuity.
    const clean = COMPARISONS.filter((c) => c.deviations.length === 0).length;
    expect(clean / COMPARISONS.length).toBeGreaterThan(0.8);
    // And the deviations that do occur are the ones a real game reaches: one
    // terminal ply per game, and floors that overflow in random play.
    expect(counts.get('terminal-deal')).toBe(MANIFEST.games.length);
    process.stdout.write(`[A8-36] deviations: ${JSON.stringify(Object.fromEntries(counts))}\n`);
  });
});

describe('the deviation machinery itself [A8-36]', () => {
  /**
   * Two of the four conditions never arose in this corpus — the printout above
   * says which did — so their handling here is code nothing above exercises.
   * These drive it directly rather than leaving a green suite to imply it was
   * covered. What they cannot establish is that the *spec's* rule for those
   * cases is right; only a corpus that reaches one could.
   */
  it('[A8-36] swaps exactly the seat-owned rows, and nothing else', () => {
    const board = new Int8Array(138);
    for (let i = 0; i < 138; i++) board[i] = ((i * 7) % 61) - 30;
    const swapped = swapSeats(board);
    expect([...swapSeats(swapped)]).toEqual([...board]);
    expect(swapped[cell(0, 0)]).toBe(board[cell(0, 1)]);
    expect(swapped[cell(0, 1)]).toBe(board[cell(0, 0)]);
    // The round and the deal are compared as they are.
    expect(swapped[cell(0, 2)]).toBe(board[cell(0, 2)]);
    for (let r = 1; r <= 8; r++) {
      for (let c = 0; c < COLS; c++) expect(swapped[cell(r, c)]).toBe(board[cell(r, c)]);
    }
    for (const [a, b] of [[9, 10], [11, 12], [13, 18], [17, 22]] as const) {
      for (let c = 0; c < COLS; c++) {
        expect(swapped[cell(a, c)]).toBe(board[cell(b, c)]);
        expect(swapped[cell(b, c)]).toBe(board[cell(a, c)]);
      }
    }
  });

  it('[A8-36] recognises no-centre-take from the two programs’ own answers', () => {
    // The condition is "their next mover disagrees with ours". Flipping the
    // original's recorded `next_player` on a real ply is exactly that
    // disagreement, so the comparison must name it and swap the seats.
    const record = POSITIONS.find((p) => !p.position.isTerminal)!;
    const flipped = compare({ ...record, theirNextPlayer: record.theirNextPlayer === 0 ? 1 : 0 });
    expect(flipped.deviations).toContain('no-centre-take');
    // Rows 1–8 and the round stay compared: the deal is not what differs.
    for (let r = 1; r <= 8; r++) expect(flipped.compared[cell(r, 0)]).toBe(true);
    expect(flipped.compared[cell(0, 2)]).toBe(true);
    // And the seat-owned rows really were swapped before comparing.
    const straight = compare(record);
    expect([...flipped.ours]).toEqual([...swapSeats(straight.ours)]);
  });

  it('[A8-36] excuses row 0 when a score would reach 128', () => {
    const record = POSITIONS.find((p) => !p.position.isTerminal)!;
    const posed = structuredClone(record.position);
    posed.players[0].score = 200;
    posed.scores = [200, posed.scores[1]];
    const wrapped = compare({ ...record, position: posed });
    expect(wrapped.deviations).toContain('score-wrap');
    expect(wrapped.compared[cell(0, 0)]).toBe(false);
    expect(wrapped.compared[cell(0, 1)]).toBe(false);
    // Only the two scores: the round beside them is still compared.
    expect(wrapped.compared[cell(0, 2)]).toBe(true);
  });

  it('[A8-36] excuses only the deal when a ply ends the game', () => {
    // The most valuable comparison in the file, and the one whose excuse had
    // no guard: on these plies row 0's scores are compared after the original
    // has run `score_bonuses`, so our end-game bonuses are checked against
    // upstream's, and rows 9–22 are compared after it tiled its last wall.
    // Widen the mask and the comparison quietly becomes vacuous.
    // Mutations: `exclude(0, c)` from c = 0 rather than 2, and the row loop
    // extended to 22; both red here and green everywhere else.
    const terminal = COMPARISONS.find((c) => c.deviations.includes('terminal-deal'));
    expect(terminal, 'no fixture ply ends a game').toBeDefined();
    expect(terminal!.compared[cell(0, 0)]).toBe(true);
    expect(terminal!.compared[cell(0, 1)]).toBe(true);
    for (let r = 9; r <= 22; r++) {
      for (let c = 0; c < COLS; c++) {
        expect(terminal!.compared[cell(r, c)], `row ${r} col ${c}`).toBe(true);
      }
    }
    // And every terminal ply is compared that way, not just the first.
    for (const { record, compared } of COMPARISONS.filter((c) =>
      c.deviations.includes('terminal-deal'),
    )) {
      expect(compared[cell(0, 0)], `${record.game} ply ${record.ply}`).toBe(true);
      expect(compared[cell(22, 4)], `${record.game} ply ${record.ply}`).toBe(true);
    }
  });

  it('[A8-36] excuses only the floor counts when a floor overflows', () => {
    const overflowing = COMPARISONS.find((c) => c.deviations.includes('floor-overflow'));
    expect(overflowing, 'no fixture overflows a floor').toBeDefined();
    expect(overflowing!.compared[cell(11, 5)]).toBe(false);
    expect(overflowing!.compared[cell(12, 5)]).toBe(false);
    // The rest of those rows — the pattern-line counts — still compared.
    for (let c = 0; c < 5; c++) {
      expect(overflowing!.compared[cell(11, c)]).toBe(true);
      expect(overflowing!.compared[cell(12, c)]).toBe(true);
    }
  });
});

describe('the deals [A8-36] must include [A8-51]', () => {
  /** A refill that recycles the lid partway through a display. */
  const shortDisplay = (bagBefore: number): boolean =>
    bagBefore > 0 && bagBefore < 20 && bagBefore % 4 !== 0;

  it('[A8-51] include a deal whose bag runs short partway through a display', () => {
    expect(MANIFEST.coverage['shortDisplay']).toBe(true);
    const plies = MANIFEST.games.flatMap((game) =>
      game.deals.filter((d) => shortDisplay(d.bagBefore)).map((d) => ({ game: game.id, ply: d.ply })),
    );
    expect(plies.length).toBeGreaterThan(0);
    for (const { game, ply } of plies) {
      const comparison = COMPARISONS.find((c) => c.record.game === game && c.record.ply === ply);
      expect(comparison, `${game} ply ${ply} is not in the fixtures`).toBeDefined();
      // Compared where it counts: the rows holding the deal it recycled into.
      for (let r = 1; r <= 8; r++) expect(comparison!.compared[cell(r, 0)]).toBe(true);
    }
  });

  it('[A8-51] include a deal following a round that left the bag at exactly zero', () => {
    expect(MANIFEST.coverage['emptyBagDeal']).toBe(true);
    const plies = MANIFEST.games.flatMap((game) =>
      game.deals.filter((d) => d.bagBefore === 0).map((d) => ({ game: game.id, ply: d.ply })),
    );
    expect(plies.length).toBeGreaterThan(0);
    for (const { game, ply } of plies) {
      const comparison = COMPARISONS.find((c) => c.record.game === game && c.record.ply === ply);
      expect(comparison, `${game} ply ${ply} is not in the fixtures`).toBeDefined();
      for (let r = 1; r <= 8; r++) expect(comparison!.compared[cell(r, 0)]).toBe(true);
    }
  });

  it('[A8-51] also cover a display taken whole from the recycled lid', () => {
    // The neighbouring arm of `setup_new_round`, where the recycle falls
    // between displays rather than inside one. Not [A8-51]'s requirement, and
    // rare — the corpus records whether it found one rather than claiming it.
    expect(MANIFEST.coverage['wholeDisplayFromLid']).toBe(true);
    const plies = MANIFEST.games.flatMap((game) =>
      game.deals
        .filter((d) => d.bagBefore > 0 && d.bagBefore < 20 && d.bagBefore % 4 === 0)
        .map((d) => ({ game: game.id, ply: d.ply })),
    );
    expect(plies.length).toBeGreaterThan(0);
    for (const { game, ply } of plies) {
      expect(COMPARISONS.some((c) => c.record.game === game && c.record.ply === ply)).toBe(true);
    }
  });
});
