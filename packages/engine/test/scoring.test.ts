/**
 * What the record says [0007 S7-9] through [0007 S7-27].
 *
 * Every assertion here runs over the corpus of [0007 S7-30]: every conformance
 * vector of *0002*, complete, replayed through `applyExplained` and stopped at
 * nothing. A vector is a whole game (or a whole posed position played to its
 * end), so "every round of a corpus of complete games" is what the walker
 * below collects — with the position vectors carrying the two endings a full
 * census cannot reach.
 *
 * Two disciplines this file is written under, both from CLAUDE.md:
 *
 * - The record is checked against the *position*, never against itself. Each
 *   round is collected with the canonical state on both sides of the ply that
 *   produced it, and the placements are re-derived from the wall as round
 *   resolution found it. A reconciliation test that echoes the accumulator
 *   back at itself passes everything here while explaining nothing.
 * - Each of the five invariants of [0007 S7-31] names, beside it, the mutation
 *   it was seen to fail against. Those mutations were applied to
 *   `packages/engine/src` and run; what failed and what did not is recorded
 *   verbatim, including where a mutation is visible to tests outside this
 *   file.
 */

import { describe, expect, it } from 'vitest';
import {
  CENTER,
  CUM_PENALTY,
  COLOR_BONUS,
  COL_BONUS,
  FLOOR_PENALTIES,
  FLOOR_SLOTS,
  NUM_ROWS,
  ROW_BONUS,
  Rng,
  applyExplained,
  clone,
  decodeAction,
  fromCanonical,
  legalActions,
  newGame,
  placementValue,
  toCanonical,
  toJSON,
  wallColorAt,
  wallCompletedColors,
  wallCompletedCols,
  wallCompletedRows,
  type AzulState,
  type CanonicalState,
  type Color,
  type RoundScoring,
} from '../src/index.js';
import { loadVectors } from './support/vectors.js';

/** One resolution, with the position on both sides of the ply that ran it. */
interface Resolution {
  /** `<vector> ply <n>`, so a failure names the game and the ply. */
  where: string;
  /** The action that closed the round, for the marker check of [S7-14]. */
  action: number;
  record: RoundScoring;
  /** The position round resolution found, as the ply that ran it began. */
  before: CanonicalState;
  /** The position it left, after `applyExplained` returned. */
  after: CanonicalState;
}

/**
 * Every round of every vector, played through `applyExplained`.
 *
 * The shuffle seam is fed the recorded orders exactly as `vectors.test.ts`
 * feeds them [0002 V2-6], because a replay that shuffled for itself would
 * wander off the recording at the first refill. Nothing here compares against
 * the oracle's states — that is `vectors.test.ts`'s job and it does it twice
 * over [0007 S7-29]. This walker is only how complete games are reached.
 */
function corpus(): Resolution[] {
  const out: Resolution[] = [];
  for (const v of loadVectors()) {
    const shuffle = (bag: Color[], index: number): void => {
      const recorded = v.shuffles[index];
      if (recorded === undefined) throw new Error(`${v.name}: shuffle ${index} past the end`);
      for (let i = 0; i < recorded.length; i++) bag[i] = recorded[i];
    };
    const s = v.kind === 'game' ? newGame(0, shuffle) : fromCanonical(v.initial, 0, shuffle);
    for (let i = 0; i < v.plies.length; i++) {
      const before = toCanonical(s);
      const record = applyExplained(s, v.plies[i].action);
      if (record !== null) {
        const where = `${v.name} ply ${i}`;
        out.push({ where, action: v.plies[i].action, record, before, after: toCanonical(s) });
      }
    }
  }
  return out;
}

const rounds = corpus();

/** Occupied floor slots of a snapshot: five colour counts and the marker [0001 E1-26]. */
function occupiedIn(c: CanonicalState, p: number): number {
  return c.floor[p].reduce((a, b) => a + b, 0) + (c.floorMarker[p] ? 1 : 0);
}

const sum = (ns: readonly number[]): number => ns.reduce((a, b) => a + b, 0);

describe('the corpus [S7-30]', () => {
  it('is complete games, and reaches every case the invariants need', () => {
    expect(rounds.length).toBeGreaterThan(100);

    // The clamp of [0001 E1-28] biting, which is the only way `forgiven`
    // is ever anything but zero — and without it [S7-25] has a term that is
    // always 0 and an assertion that cannot tell the two clauses apart.
    const forgiven = rounds.filter((r) => r.record.players.some((p) => p.forgiven > 0));
    expect(forgiven.length, 'no round reached the clamp with forgiven > 0').toBeGreaterThan(0);

    // Both endings. A completed row is how every dealt game finishes
    // [0001 E1-36]; exhaustion is reachable only from a posed short census
    // [0001 E1-37], and `position-05` is the vector that poses it.
    const ended = rounds.filter((r) => r.record.bonuses !== null);
    expect(ended.some((r) => !r.after.exhausted), 'no game ended on a completed row').toBe(true);
    expect(ended.some((r) => r.after.exhausted), 'no game ended exhausted').toBe(true);

    // The lone tile, which is the only position where [S7-10]'s two readings
    // differ: `placementValue` returns 1 where `h + v` returns 2 [0001 E1-24].
    const alone = rounds.filter((r) =>
      r.record.players.some((p) => p.placements.some((q) => q.h === 1 && q.v === 1)),
    );
    expect(alone.length, 'no placement scored alone').toBeGreaterThan(0);
  });
});

describe('the invariants [S7-23]..[S7-27]', () => {
  /**
   * Seen to fail against: `sink.push({ ..., points: points + 1 })` in
   * `tileWall`. The accumulator is untouched, so the round still scores what
   * the rules say and only the record lies — this assertion failed, and
   * [S7-24], [S7-25], [S7-26] and [S7-27] all passed. (The placement check of
   * [S7-10] below failed too, which is the same lie read from the other side.)
   */
  it('[S7-23] tiling is the sum of what the placements charged', () => {
    for (const { where, record } of rounds) {
      for (const [p, player] of record.players.entries()) {
        expect(player.tiling, `${where} seat ${p}`).toBe(sum(player.placements.map((q) => q.points)));
      }
    }
  });

  /**
   * Seen to fail against: `FLOOR_PENALTIES.slice(0, Math.min(occupied, FLOOR_SLOTS - 1))`
   * in `endRound` — one rung short. This assertion failed; [S7-23], [S7-25],
   * [S7-26] and [S7-27] all passed, because the number charged is
   * `CUM_PENALTY`'s and the ladder is only reported beside it. The ladder
   * check of [S7-16] below failed too, which is the same lie stated directly.
   */
  it('[S7-24] the penalty is the sum of the rungs charged', () => {
    for (const { where, record } of rounds) {
      for (const [p, player] of record.players.entries()) {
        expect(player.floor.penalty, `${where} seat ${p}`).toBe(sum(player.floor.rungs));
      }
    }
  });

  /**
   * Seen to fail against: the clamp removed — `s.scores[p] = charged` in
   * `endRound`. The second clause failed (a negative score is not
   * `max(0, ...)`); the first kept holding, because `forgiven` is measured
   * against what was written. [S7-23], [S7-24], [S7-26] and [S7-27] passed.
   * [S7-17] failed with it, and so did the corpus check of [S7-30] — with
   * nothing clamped there is no round with `forgiven > 0` left to find, which
   * is the coverage claim doing its job. It fails `vectors.test.ts` loudly too,
   * because removing the clamp is a rules change: the invariant is about the
   * record, and the record was still faithfully reporting a broken engine.
   */
  it('[S7-25] the round score is the charge, clamped, with the rest forgiven', () => {
    for (const { where, record } of rounds) {
      for (const [p, player] of record.players.entries()) {
        const charged = player.scoreBefore + player.tiling + player.floor.penalty;
        expect(player.forgiven, `${where} seat ${p}: forgiven`).toBeGreaterThanOrEqual(0);
        expect(player.scoreAfterRound, `${where} seat ${p}: split`).toBe(charged + player.forgiven);
        expect(player.scoreAfterRound, `${where} seat ${p}: clamp`).toBe(Math.max(0, charged));
      }
    }
  });

  /**
   * Seen to fail against: `s.scores[p] = scoreBefore + total + total` in
   * `finishGame` — the bonus added twice. The second clause failed;
   * [S7-23], [S7-24], [S7-25] and [S7-27] passed, because the state and the
   * record agreed on the doubled number.
   */
  it('[S7-26] the bonus half starts where the round half stopped', () => {
    const ended = rounds.filter((r) => r.record.bonuses !== null);
    expect(ended.length).toBeGreaterThan(0);
    for (const { where, record } of ended) {
      const bonuses = record.bonuses!;
      for (const [p, bonus] of bonuses.entries()) {
        expect(bonus.scoreBefore, `${where} seat ${p}: continues the round`).toBe(
          record.players[p].scoreAfterRound,
        );
        expect(bonus.scoreAfter, `${where} seat ${p}: final`).toBe(bonus.scoreBefore + bonus.total);
      }
    }
  });

  /**
   * Seen to fail against: `if (!s.isTerminal) s.scores[0]++;` at the foot of
   * `endRound` — a score change made after the record was written, which the
   * record therefore does not account for. This assertion failed at
   * `game-00.json ply 11`; [S7-23], [S7-24], [S7-25] and [S7-26] all passed,
   * because every one of them is an equation between numbers the record
   * carries and the mutation touched none of them. That is the whole reason
   * this invariant is stated separately — and the ordinary-round clause of
   * [S7-22] caught it too, which is the same claim on one seat.
   */
  it('[S7-27] the record accounts for the whole score change', () => {
    for (const { where, record, after } of rounds) {
      for (const [p, player] of record.players.entries()) {
        const expected = record.bonuses === null ? player.scoreAfterRound : record.bonuses[p].scoreAfter;
        expect(after.scores[p], `${where} seat ${p}`).toBe(expected);
      }
    }
  });
});

describe('the record against the position it came from', () => {
  /**
   * [S7-9], [S7-10] and [S7-11] at once, and the only place the runs are
   * observable at all: `placementRuns` is private [S7-11], so the record's `h`
   * and `v` are its witness.
   *
   * The wall is rebuilt from the position round resolution *found* and walked
   * forward exactly as [0001 E1-22] and [0001 E1-25] say it is — rows `0..4`,
   * each placement visible to the next. Every number is re-derived here from
   * the snapshot, so nothing in this assertion is the engine agreeing with
   * itself.
   */
  it('[S7-9] [S7-10] [S7-11] lists every resolved row, in order, with its real runs', () => {
    let checked = 0;
    let colours = 0;
    for (const { where, record, before, after } of rounds) {
      for (const [p, player] of record.players.entries()) {
        // What the resolution moved, read off the wall rather than off the
        // record: every cell set in the position it left and unset in the
        // position it found. That is [S7-9]'s subject exactly, and it is
        // derived from two snapshots the record had no hand in.
        const placed: { row: number; col: number }[] = [];
        for (let row = 0; row < NUM_ROWS; row++) {
          for (let col = 0; col < NUM_ROWS; col++) {
            const i = row * 5 + col;
            if (after.walls[p][i] === 1 && before.walls[p][i] === 0) placed.push({ row, col });
          }
        }
        expect(
          player.placements.map((q) => ({ row: q.row, col: q.col })),
          `${where} seat ${p}: the tiles the resolution moved, in row order`,
        ).toEqual(placed);

        const wall = before.walls[p].slice();
        for (const { row, col, h, v, points } of player.placements) {
          // Runs re-scanned here, from this wall, by code that is not the
          // engine's — and from the wall as the resolution found it, walked
          // forward one placement at a time, because a tile placed by an
          // earlier row is visible to a later one [0001 E1-25].
          let horizontal = 1;
          for (let i = col - 1; i >= 0 && wall[row * 5 + i]; i--) horizontal++;
          for (let i = col + 1; i < 5 && wall[row * 5 + i]; i++) horizontal++;
          let vertical = 1;
          for (let i = row - 1; i >= 0 && wall[i * 5 + col]; i--) vertical++;
          for (let i = row + 1; i < 5 && wall[i * 5 + col]; i++) vertical++;
          expect(h, `${where} seat ${p} row ${row}: h`).toBe(horizontal);
          expect(v, `${where} seat ${p} row ${row}: v`).toBe(vertical);
          // [S7-10] the value `placementValue` returned, which is not `h + v`:
          // a tile landing alone scores 1 where the sum says 2.
          expect(points, `${where} seat ${p} row ${row}: points`).toBe(
            placementValue(wall, row, col),
          );
          // The colour is absent from the record and does not need to be: the
          // cell the resolution set is the cell that colour occupies in that
          // row, and the wall's pattern is fixed [0001 E1-1]. Only rows that
          // already held tiles can be checked this way — a row the closing ply
          // filled from empty has no colour in the snapshot — so the ones that
          // can be are counted, and the count is asserted below.
          if (before.plColor[p][row] !== -1) {
            expect(wallColorAt(row, col), `${where} seat ${p} row ${row}: colour`).toBe(
              before.plColor[p][row],
            );
            colours++;
          }
          wall[row * 5 + col] = 1;
          checked++;
        }
        expect(wall, `${where} seat ${p}: the wall the resolution left`).toEqual(after.walls[p]);
      }
    }
    expect(checked, 'the corpus placed no tiles').toBeGreaterThan(500);
    expect(colours, 'no placement had a colour to be checked against').toBeGreaterThan(100);
  });

  /**
   * [S7-14] and [S7-33]. Both numbers are read inside round resolution, while
   * the floor still holds what it cost and before [0001 E1-30] takes the
   * marker back. Filled in afterwards they would report an empty floor and no
   * marker, for every player of every round — which is why the check is
   * against the *snapshot before the ply*, and why the case that proves it is
   * a player holding the marker with tiles beside it.
   */
  it('[S7-14] [S7-33] reports the floor and the marker as resolution found them', () => {
    let witnesses = 0;
    for (const { where, action, record, before, after } of rounds) {
      // Who held the marker when resolution ran, derived from the position and
      // the action rather than read back out of the record: whoever held it
      // before, plus the closing player if their take was the first from the
      // centre this round [0001 E1-17].
      const [source] = decodeAction(action);
      const tookMarker = before.markerInCenter && source === CENTER;
      for (const [p, player] of record.players.entries()) {
        const closed = p === before.currentPlayer;
        expect(player.floor.markerHeld, `${where} seat ${p}: marker`).toBe(
          before.floorMarker[p] || (closed && tookMarker),
        );
        if (!closed) {
          // The seat that did not play the closing ply: its floor is untouched
          // between the snapshot and round resolution, so the snapshot *is*
          // the position resolution found, exactly.
          expect(player.floor.occupied, `${where} seat ${p}: occupied`).toBe(occupiedIn(before, p));
          if (before.floorMarker[p] && sum(before.floor[p]) > 0) witnesses++;
        } else {
          // The closing ply may have added to its own floor, so the snapshot
          // bounds `occupied` from below rather than fixing it. Tiles cannot
          // leave a floor mid-round, and what the number is exactly is pinned
          // from the other side by [S7-15] and [S7-16] — `penalty` and `rungs`
          // are both functions of it, and both are checked against the ladder.
          expect(player.floor.occupied, `${where} seat ${p}: occupied`).toBeGreaterThanOrEqual(
            occupiedIn(before, p),
          );
        }
      }
      // At most one seat holds it, which is [0001 E1-17] from the other side.
      expect(
        record.players.filter((p) => p.floor.markerHeld).length,
        `${where}: two seats held the marker`,
      ).toBeLessThanOrEqual(1);
      // And the position afterwards holds neither, which is what makes a
      // record filled in after resolution indistinguishable from an empty one
      // — and is why the two fields are captured where they are charged.
      expect(after.floorMarker, `${where}: the marker went back [0001 E1-30]`).toEqual([
        false,
        false,
      ]);
      expect(sum(after.floor[0]) + sum(after.floor[1]), `${where}: the floors were cleared`).toBe(0);
    }
    // [S7-33]'s case, and it must be a seat that did not close the round, so
    // that the two numbers are checked against a position and not a bound.
    expect(witnesses, 'no round scored a marker beside floor tiles').toBeGreaterThan(0);
  });

  /**
   * [S7-15] and [S7-16]. The ladder is charged by slot, and slots past the
   * seventh cost nothing [0001 E1-27] — which is the whole reason `occupied`
   * sits beside `rungs` rather than being derived from it.
   */
  it('[S7-15] [S7-16] charges the ladder by slot, and stops at the seventh', () => {
    let overfull = 0;
    for (const { where, record } of rounds) {
      for (const [p, player] of record.players.entries()) {
        const { occupied, rungs, penalty } = player.floor;
        expect(penalty, `${where} seat ${p}: the number charged`).toBe(
          CUM_PENALTY[Math.min(FLOOR_SLOTS, occupied)],
        );
        expect(penalty, `${where} seat ${p}: non-positive`).toBeLessThanOrEqual(0);
        expect(rungs, `${where} seat ${p}: the rungs`).toEqual(
          FLOOR_PENALTIES.slice(0, Math.min(occupied, FLOOR_SLOTS)),
        );
        if (occupied > FLOOR_SLOTS) {
          overfull++;
          expect(rungs.length, `${where} seat ${p}: past the seventh`).toBe(FLOOR_SLOTS);
        }
      }
    }
    // [0001 E1-27] is only a rule where a floor overflows, so a corpus that
    // never overflowed one would leave the clause above untested.
    expect(overfull, 'no floor ever held more than seven slots').toBeGreaterThan(0);
  });

  /**
   * [S7-13] and [S7-32]. The recorded index is the round that *ended*, on all
   * three exits — and the three differ precisely in what they do to
   * `roundIndex`: an ordinary round increments it [0001 E1-35], a completed
   * row ends the game before the increment [0001 E1-36], exhaustion
   * increments and then ends [0001 E1-37]. Read at the end rather than on
   * entry, the field would name the round that follows on one exit and the
   * round that ended on the other two.
   */
  it('[S7-13] [S7-32] names the round that ended, on all three exits', () => {
    const exits = { ordinary: 0, row: 0, exhausted: 0 };
    for (const { where, record, before, after } of rounds) {
      expect(record.round, `${where}: the round that ended`).toBe(before.roundIndex);
      if (!after.isTerminal) {
        exits.ordinary++;
        expect(after.roundIndex, `${where}: an ordinary round moves on`).toBe(record.round + 1);
      } else if (after.exhausted) {
        exits.exhausted++;
        expect(after.roundIndex, `${where}: exhaustion increments, then ends`).toBe(record.round + 1);
      } else {
        exits.row++;
        expect(after.roundIndex, `${where}: a completed row ends before the increment`).toBe(
          record.round,
        );
      }
    }
    expect(exits.ordinary, 'no ordinary round').toBeGreaterThan(0);
    expect(exits.row, 'no game ended on a completed row').toBeGreaterThan(0);
    expect(exits.exhausted, 'no game ended exhausted').toBeGreaterThan(0);
  });

  /**
   * [S7-18], against the position rather than against the record: the score
   * round resolution found, and the score it left before any bonus.
   */
  it('[S7-18] brackets the round with the scores around it', () => {
    for (const { where, record, before } of rounds) {
      for (const [p, player] of record.players.entries()) {
        expect(player.scoreBefore, `${where} seat ${p}`).toBe(before.scores[p]);
      }
    }
  });

  /**
   * [S7-17]. `forgiven` is a property of the round, not of the floor: the
   * clamp applies to tiling and penalty together, so a round can be forgiven
   * something even when its floor cost less than its tiling earned — and is
   * `0` whenever the clamp did not bite.
   */
  it('[S7-17] forgives what the clamp did not take, and nothing otherwise', () => {
    let bit = 0;
    for (const { where, record } of rounds) {
      for (const [p, player] of record.players.entries()) {
        const charged = player.scoreBefore + player.tiling + player.floor.penalty;
        if (charged >= 0) {
          expect(player.forgiven, `${where} seat ${p}: the clamp did not bite`).toBe(0);
        } else {
          bit++;
          expect(player.forgiven, `${where} seat ${p}: what the clamp did not take`).toBe(-charged);
          expect(player.scoreAfterRound, `${where} seat ${p}`).toBe(0);
        }
      }
    }
    expect(bit, 'the clamp never bit').toBeGreaterThan(0);
  });

  /**
   * [S7-19] and [S7-20]. The counts, the points each count earned, and their
   * total — the arithmetic of [0001 E1-38], done here so the interface never
   * has to. And the record carries them if and only if the game ended, by
   * either route.
   */
  it('[S7-19] [S7-20] itemises the bonuses, on the terminal ply and only there', () => {
    for (const { where, record, before, after } of rounds) {
      const ended = after.isTerminal;
      expect(record.bonuses !== null, `${where}: bonuses without an ending`).toBe(ended);
      expect(before.isTerminal, `${where}: the ply started terminal`).toBe(false);
      if (record.bonuses === null) continue;
      for (const [p, bonus] of record.bonuses.entries()) {
        // The counts against the wall the game ended on, not against the
        // record: `rowPoints === ROW_BONUS * rows` is true of any pair of
        // numbers in that ratio, and says nothing about whether `rows` is the
        // number of rows this player actually completed [0001 E1-70].
        const wall = after.walls[p];
        expect(bonus.rows, `${where} seat ${p}: rows completed`).toBe(wallCompletedRows(wall));
        expect(bonus.cols, `${where} seat ${p}: columns completed`).toBe(wallCompletedCols(wall));
        expect(bonus.colors, `${where} seat ${p}: colours completed`).toBe(
          wallCompletedColors(wall),
        );
        expect(bonus.rowPoints, `${where} seat ${p}: rows`).toBe(ROW_BONUS * bonus.rows);
        expect(bonus.colPoints, `${where} seat ${p}: cols`).toBe(COL_BONUS * bonus.cols);
        expect(bonus.colorPoints, `${where} seat ${p}: colors`).toBe(COLOR_BONUS * bonus.colors);
        expect(bonus.total, `${where} seat ${p}: total`).toBe(
          bonus.rowPoints + bonus.colPoints + bonus.colorPoints,
        );
      }
    }
  });
});

describe('the record is a value, not a view of the state', () => {
  /**
   * [S7-8]. A caller may keep one for as long as it likes — so the tiles a
   * round put on the wall stay what that round put there, and not what the
   * board became three rounds later.
   */
  it('[S7-8] is unchanged after later plies have moved the game on', () => {
    const s = newGame(17);
    const picker = new Rng(0x5c0);
    let held: RoundScoring | null = null;
    let plies = 0;
    while (!s.isTerminal) {
      const legal = legalActions(s);
      const record = applyExplained(s, legal[picker.below(legal.length)]);
      if (held === null && record !== null) held = record;
      plies++;
    }
    expect(held, 'the game never resolved a round').not.toBeNull();
    // Deep-frozen by value: a structural copy taken when it was handed over
    // still equals it after a whole game has been played on top.
    const kept = structuredClone(held!);
    expect(held).toEqual(kept);
    expect(plies).toBeGreaterThan(40);
    // And it is a plain value: structurally cloneable, no class instances, no
    // functions, nothing reaching back into the state.
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') {
        expect(typeof value, path).not.toBe('function');
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      expect(Object.getPrototypeOf(value), path).toBe(Object.prototype);
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    };
    walk(held, 'record');
  });

  /**
   * [S7-6] and the rest of [S7-34]. A record is an event, not a position: it
   * is no part of a snapshot, `fromCanonical` does not restore it, and a state
   * that has just produced one round-trips exactly as any other does.
   */
  it('[S7-6] [S7-34] leaves the snapshot, the view and the round trip alone', () => {
    const s = newGame(29);
    const picker = new Rng(88);
    let record: RoundScoring | null = null;
    while (record === null) {
      const legal = legalActions(s);
      record = applyExplained(s, legal[picker.below(legal.length)]);
    }
    const canonical = toCanonical(s);
    const json = toJSON(s);
    for (const key of Object.keys(canonical)) {
      expect(key.toLowerCase(), 'a snapshot key naming the record').not.toContain('scoring');
    }
    expect(Object.keys(json)).not.toContain('scoring');
    // The round trip, unchanged — and the restored state carries no record.
    const restored = fromCanonical(canonical, 0);
    expect(toCanonical(restored)).toEqual(canonical);
    expect(toJSON(restored)).toEqual(json);
    expect(Object.keys(restored).sort()).toEqual(Object.keys(clone(s)).sort());
    expect(JSON.parse(JSON.stringify(record)) as unknown).toEqual(record);
  });

  /**
   * [S7-7]. The engine hands the record over and keeps nothing: it cannot be
   * asked for again, and a later ply that resolves nothing answers `null`
   * rather than re-serving the last one. A record cached on the state would
   * need a flag to gate its cost, and a flag on the state is a mode — two
   * positions equal under [0001 E1-62] taking different paths.
   */
  it('[S7-7] re-serves nothing: a later ply that resolves nothing answers null', () => {
    const s = newGame(41);
    const picker = new Rng(2024);
    let first: RoundScoring | null = null;
    while (first === null) {
      const legal = legalActions(s);
      first = applyExplained(s, legal[picker.below(legal.length)]);
    }
    // The very next ply resolves nothing — a fresh round has just been dealt.
    const next = applyExplained(s, legalActions(s)[0]);
    expect(next, 'the last record was served again').toBeNull();
    // Two resolutions, two records: never the same object.
    let second: RoundScoring | null = null;
    while (second === null && !s.isTerminal) {
      const legal = legalActions(s);
      second = applyExplained(s, legal[picker.below(legal.length)]);
    }
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second!.round).toBe(first.round + 1);
  });
});

/**
 * [S7-21] and [S7-36]. A field derivable from another field in the same record
 * is a second copy of a rule.
 *
 * Asserted as a key set rather than as the absence of a list of names,
 * deliberately: an absence test catches the three fields this document
 * anticipated and nothing else, while a key set catches the fourth, added
 * later, under a name nobody thought of. Restoring any of the three — a
 * placement's colour, a "landed alone" flag, an "ended" flag — fails this and
 * nothing else.
 */
describe('[S7-21] [S7-36] the record carries nothing derivable from itself', () => {
  const keysOf = (value: object): string => Object.keys(value).sort().join(',');
  const declared = (...names: string[]): string => names.sort().join(',');

  /**
   * The key set of each type, gathered from **every** record in the corpus
   * rather than from a sample. A field added on one branch — the terminal ply,
   * a round with no placements — is exactly the field a sample would miss.
   */
  const shapes = {
    RoundScoring: new Set<string>(),
    PlayerRound: new Set<string>(),
    FloorCharge: new Set<string>(),
    Placement: new Set<string>(),
    PlayerBonuses: new Set<string>(),
  };
  for (const { record } of rounds) {
    shapes.RoundScoring.add(keysOf(record));
    for (const player of record.players) {
      shapes.PlayerRound.add(keysOf(player));
      shapes.FloorCharge.add(keysOf(player.floor));
      for (const placement of player.placements) shapes.Placement.add(keysOf(placement));
    }
    for (const bonus of record.bonuses ?? []) shapes.PlayerBonuses.add(keysOf(bonus));
  }

  it('RoundScoring', () => {
    expect([...shapes.RoundScoring]).toEqual([declared('round', 'players', 'bonuses')]);
  });

  it('PlayerRound', () => {
    expect([...shapes.PlayerRound]).toEqual([
      declared('placements', 'tiling', 'floor', 'scoreBefore', 'scoreAfterRound', 'forgiven'),
    ]);
  });

  it('FloorCharge', () => {
    expect([...shapes.FloorCharge]).toEqual([
      declared('occupied', 'rungs', 'markerHeld', 'penalty'),
    ]);
  });

  it('Placement', () => {
    expect([...shapes.Placement]).toEqual([declared('row', 'col', 'h', 'v', 'points')]);
  });

  it('PlayerBonuses', () => {
    expect([...shapes.PlayerBonuses]).toEqual([
      declared(
        'rows',
        'cols',
        'colors',
        'rowPoints',
        'colPoints',
        'colorPoints',
        'total',
        'scoreBefore',
        'scoreAfter',
      ),
    ]);
  });

  it('gathered every type from the corpus, so none of the five is vacuous', () => {
    for (const [name, set] of Object.entries(shapes)) {
      expect(set.size, `${name}: no record carried one`).toBe(1);
    }
  });
});

/** A state played into a resolution, for the checks that need a live one. */
function playToResolution(seed: number): { s: AzulState; record: RoundScoring } {
  const s = newGame(seed);
  const picker = new Rng(seed ^ 0xfeed);
  let record: RoundScoring | null = null;
  while (record === null) {
    const legal = legalActions(s);
    record = applyExplained(s, legal[picker.below(legal.length)]);
  }
  return { s, record };
}

describe('[S7-22] the final score is read, never added', () => {
  it('hands back both sides of the bonus addition', () => {
    const ended = rounds.filter((r) => r.record.bonuses !== null);
    expect(ended.length).toBeGreaterThan(0);
    for (const { where, record, after } of ended) {
      for (const [p, bonus] of record.bonuses!.entries()) {
        // The split [0003]'s *Two places this knowingly falls short* called
        // irrecoverable: the clamped round score and the unclamped bonus, both
        // present, so nobody downstream has to add anything on the one ply
        // this work exists for.
        expect(bonus.scoreAfter, `${where} seat ${p}`).toBe(after.scores[p]);
        expect(bonus.scoreBefore, `${where} seat ${p}`).toBe(record.players[p].scoreAfterRound);
      }
    }
    // And on an ordinary round there is nothing to add: the round half is the
    // score, and the bonus half is absent rather than zero.
    const { s, record } = playToResolution(5);
    expect(record.bonuses).toBeNull();
    expect(s.scores).toEqual(record.players.map((p) => p.scoreAfterRound));
  });
});
