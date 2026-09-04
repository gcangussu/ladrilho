/**
 * The observation vector: layout, range, and perspective.
 *
 * The bot depends on this layout, so it is a contract rather than an
 * implementation detail. Perspective is tested through `encodeFor`
 * ([E1-67]) — the harness may not set `currentPlayer` to reach the other
 * seat, and does not need to [0002 V2-3].
 */

import { describe, expect, it } from 'vitest';
import {
  ENCODED_SIZE,
  FLOOR,
  NUM_COLORS,
  NUM_ROWS,
  OFF_BAG,
  OFF_CENTER,
  OFF_CENTER_TOTAL,
  OFF_FACTORIES,
  OFF_FACTORY_FLAGS,
  OFF_I_START,
  OFF_LID,
  OFF_MARKER_CENTER,
  OFF_MY_FLOOR,
  OFF_MY_LINES,
  OFF_MY_SETS,
  OFF_MY_WALL,
  OFF_OP_FLOOR,
  OFF_OP_LINES,
  OFF_OP_SETS,
  OFF_OP_WALL,
  OFF_ROUND,
  OFF_SCORES,
  OFF_TILES_LEFT,
  apply,
  encode,
  encodeFor,
  fromCanonical,
  legalActions,
  newGame,
  toCanonical,
  type CanonicalState,
  type Player,
} from '../src/index.js';
import { gameVectors, loadVectors } from './support/vectors.js';

/** A late position where the two seats genuinely differ. */
function contrastingPosition(): CanonicalState {
  const v = gameVectors()[6];
  const wanted = v.plies.find((p) => {
    const s = p.state;
    return (
      !s.isTerminal &&
      s.scores[0] !== s.scores[1] &&
      s.walls[0].some((x, i) => x !== s.walls[1][i]) &&
      s.plCount[0].some((n, r) => n !== s.plCount[1][r])
    );
  });
  if (wanted === undefined) throw new Error('no contrasting position in the vectors');
  return wanted.state;
}

describe('the layout is a contract [E1-53]', () => {
  it('exports every field offset in the table, holding the value shown there', () => {
    expect(ENCODED_SIZE).toBe(182);
    expect([
      OFF_MY_WALL,
      OFF_OP_WALL,
      OFF_MY_LINES,
      OFF_OP_LINES,
      OFF_MY_FLOOR,
      OFF_OP_FLOOR,
      OFF_SCORES,
      OFF_FACTORIES,
      OFF_FACTORY_FLAGS,
      OFF_CENTER,
      OFF_CENTER_TOTAL,
      OFF_MARKER_CENTER,
      OFF_BAG,
      OFF_LID,
      OFF_TILES_LEFT,
      OFF_I_START,
      OFF_ROUND,
      OFF_MY_SETS,
      OFF_OP_SETS,
    ]).toEqual([0, 25, 50, 80, 110, 117, 124, 126, 151, 156, 161, 162, 163, 168, 173, 174, 175, 176, 179]);
  });

  it('is a Float32Array of exactly ENCODED_SIZE values', () => {
    const v = encode(newGame(1));
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(ENCODED_SIZE);
  });

  it('gives an empty pattern line all zeros [E1-54]', () => {
    const s = newGame(1);
    // Nothing has been placed yet, so all ten line blocks are zero.
    const v = encode(s);
    for (let i = OFF_MY_LINES; i < OFF_MY_FLOOR; i++) expect(v[i], `index ${i}`).toBe(0);
    apply(s, legalActions(s).find((a) => a % 6 === 0)!);
    const filled = encodeFor(s, 0);
    // Row 0 now carries a colour bit and a fill; the rest still carry nothing.
    const row0 = Array.from(filled.slice(OFF_MY_LINES, OFF_MY_LINES + 6));
    expect(row0.filter((x) => x !== 0).length).toBe(2);
    for (let r = 1; r < NUM_ROWS; r++) {
      for (let k = 0; k < 6; k++) {
        expect(filled[OFF_MY_LINES + r * 6 + k], `row ${r} slot ${k}`).toBe(0);
      }
    }
  });

  it('encodes bag counts but never the bag order [E1-55]', () => {
    const snapshot = structuredClone(gameVectors()[0].plies[20].state);
    const reversed: CanonicalState = { ...snapshot, bag: snapshot.bag.slice().reverse() };
    const a = encode(fromCanonical(snapshot, 0));
    const b = encode(fromCanonical(reversed, 0));
    expect(Array.from(b)).toEqual(Array.from(a));
    // The counts themselves are public information and are encoded.
    const counts = [0, 0, 0, 0, 0];
    for (const c of snapshot.bag) counts[c]++;
    for (let c = 0; c < NUM_COLORS; c++) expect(a[OFF_BAG + c]).toBeCloseTo(counts[c] / 20, 6);
    // Two positions that will deal differently are still distinct states.
    expect(toCanonical(fromCanonical(reversed, 0))).not.toEqual(snapshot);
  });
});

describe('perspective [E1-67], [V2-25]', () => {
  it('encode is encodeFor(currentPlayer), and neither mutates', () => {
    for (const v of loadVectors().slice(0, 6)) {
      for (const index of [0, Math.floor(v.plies.length / 2), v.plies.length - 1]) {
        const s = fromCanonical(v.plies[index].state, 0);
        const before = toCanonical(s);
        expect(Array.from(encode(s))).toEqual(Array.from(encodeFor(s, s.currentPlayer)));
        expect(toCanonical(s)).toEqual(before);
      }
    }
  });

  it('mirrors the five paired regions and shares the rest, on one fixed position', () => {
    // Read from both seats of the *same* position: an `apply` would also move
    // tiles, and nothing about that is a perspective swap.
    const s = fromCanonical(contrastingPosition(), 0);
    const mine = encodeFor(s, 0);
    const theirs = encodeFor(s, 1);

    const pairs: [number, number, number][] = [
      [0, 25, 25], // walls
      [50, 80, 30], // pattern lines
      [110, 117, 7], // floors
      [124, 125, 1], // scores
      [176, 179, 3], // completed rows / columns / colours
    ];
    let swapped = 0;
    for (const [a, b, length] of pairs) {
      for (let i = 0; i < length; i++) {
        expect(theirs[b + i], `mirror ${a}+${i}`).toBe(mine[a + i]);
        expect(theirs[a + i], `mirror ${b}+${i}`).toBe(mine[b + i]);
        if (mine[a + i] !== mine[b + i]) swapped++;
      }
    }
    // The position must actually differ between the seats, or the assertion
    // above would pass on any encoder at all.
    expect(swapped).toBeGreaterThan(0);

    // Factories, centre, bag, lid, tiles-left and the round are seat-neutral.
    const shared = [...Array.from({ length: 174 - 126 }, (_, i) => 126 + i), 175];
    for (const i of shared) expect(theirs[i], `shared ${i}`).toBe(mine[i]);

    // Index 174 is deliberately in neither group: it is a disjunction with no
    // opposite-seat counterpart, and a whole-vector swap assertion would fail
    // a correct engine on that index alone [E1-63].
    expect(shared).not.toContain(OFF_I_START);
    expect(pairs.some(([a, b]) => a === OFF_I_START || b === OFF_I_START)).toBe(false);
  });
});

describe('the numeric range is what the spec states, not a blanket bound [E1-56], [V2-29]', () => {
  it('is finite and non-negative everywhere, with the two clamped fields in [0, 1]', () => {
    // Roughly a quarter of a million values, so the scan is plain JavaScript
    // and only the first fault becomes an assertion.
    const faults: string[] = [];
    let checked = 0;
    for (const v of loadVectors().slice(0, 8)) {
      for (const ply of v.plies) {
        const s = fromCanonical(ply.state, 0);
        for (const p of [0, 1] as Player[]) {
          const vec = encodeFor(s, p);
          for (let i = 0; i < vec.length; i++) {
            if (!Number.isFinite(vec[i])) faults.push(`${v.name} seat ${p} index ${i} not finite`);
            else if (vec[i] < 0) faults.push(`${v.name} seat ${p} index ${i} = ${vec[i]}`);
            checked++;
          }
          // Floor slots: min(occupied, 7) / 7. Round index: min(round, 10)/10.
          for (const i of [OFF_MY_FLOOR + 5, OFF_OP_FLOOR + 5, OFF_ROUND]) {
            if (vec[i] > 1) faults.push(`${v.name} seat ${p} clamped index ${i} = ${vec[i]}`);
          }
        }
      }
    }
    expect(faults.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(100_000);
  });

  it('leaves the scaled fields unclamped, because they legitimately exceed 1', () => {
    // Centre counts are divided by 10 though the centre holds more, and scores
    // by 100 though a finished game scores past it. Clamping either would
    // diverge from the reference encoder and corrupt every vector, so this
    // asserts the divisor is a scaling constant: the encoded value tracks the
    // raw count linearly rather than saturating.
    const busiest = loadVectors()
      .flatMap((v) => v.plies.map((p) => p.state))
      .reduce((best, s) => (Math.max(...s.center) > Math.max(...best.center) ? s : best));
    const s = fromCanonical(busiest, 0);
    const vec = encode(s);
    for (let c = 0; c < NUM_COLORS; c++) {
      expect(vec[OFF_CENTER + c]).toBeCloseTo(busiest.center[c] / 10, 5);
    }
    expect(vec[OFF_CENTER_TOTAL]).toBeCloseTo(
      busiest.center.reduce((a, b) => a + b, 0) / 20,
      5,
    );
    expect(vec[OFF_SCORES]).toBeCloseTo(busiest.scores[busiest.currentPlayer] / 100, 5);
  });
});

describe('the [174, 175) flag is a disjunction, not a "next round" bit [E1-63], [V2-30]', () => {
  it('reads correctly from both seats, before and after the marker is taken', () => {
    // A position where the marker is still in the centre, the player to move
    // is *not* the round's starter, and a centre take is available that will
    // not end the round.
    let found: { state: CanonicalState; action: number } | null = null;
    outer: for (const v of gameVectors()) {
      for (const ply of [{ state: v.initial }, ...v.plies]) {
        const s = ply.state;
        if (!s.markerInCenter || s.isTerminal) continue;
        if (s.currentPlayer === s.firstPlayer) continue;
        for (let c = 0; c < NUM_COLORS; c++) {
          if (s.center[c] > 0 && s.center[c] < s.tilesLeft) {
            found = { state: s, action: 5 * 30 + c * 6 + FLOOR };
            break outer;
          }
        }
      }
    }
    expect(found, 'no vector reaches the position this requirement needs').not.toBeNull();

    const s = fromCanonical(found!.state, 0);
    const starter = s.firstPlayer;
    const other = (1 - starter) as Player;
    expect(s.currentPlayer).toBe(other);
    expect(s.floorMarker).toEqual([false, false]);

    // Before the marker is taken: the round's starter sees 1, and the player
    // who neither started the round nor holds the marker sees 0.
    expect(encodeFor(s, starter)[OFF_I_START]).toBe(1);
    expect(encodeFor(s, other)[OFF_I_START]).toBe(0);

    // The non-starter takes from the centre and picks up the marker. From
    // here *both* seats see the flag set — the shape that discriminates the
    // disjunction from the field's misleading name. A port that implemented
    // "I start the next round" reports 0 for the starter here.
    apply(s, found!.action);
    expect(s.floorMarker[other]).toBe(true);
    expect(s.firstPlayer).toBe(starter);
    expect(encodeFor(s, starter)[OFF_I_START]).toBe(1);
    expect(encodeFor(s, other)[OFF_I_START]).toBe(1);
  });
});
