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
import { encodedStates, gameVectors, loadVectors } from './support/vectors.js';

/** The five paired regions of the layout [V2-25]. */
const PAIRS: { name: string; a: number; b: number; length: number }[] = [
  { name: 'walls', a: OFF_MY_WALL, b: OFF_OP_WALL, length: 25 },
  { name: 'pattern lines', a: OFF_MY_LINES, b: OFF_OP_LINES, length: 30 },
  { name: 'floors', a: OFF_MY_FLOOR, b: OFF_OP_FLOOR, length: 7 },
  { name: 'scores', a: OFF_SCORES, b: OFF_SCORES + 1, length: 1 },
  { name: 'completed sets', a: OFF_MY_SETS, b: OFF_OP_SETS, length: 3 },
];

/** Every state the committed vectors hold, `initial` and each ply. */
function allStates(): { where: string; state: CanonicalState }[] {
  const out: { where: string; state: CanonicalState }[] = [];
  for (const v of loadVectors()) {
    out.push({ where: `${v.name} initial`, state: v.initial });
    v.plies.forEach((p, i) => out.push({ where: `${v.name} ply ${i}`, state: p.state }));
  }
  return out;
}

/**
 * For each paired region, the first recorded state whose two seats actually
 * **differ** across it, with both seats' vectors [V2-25].
 *
 * There is no single position that discriminates all five: measured over every
 * state in the vectors, the floor pair differs in 1 958 of them, the
 * completed-set pair in 27, and none differs in all five at once. So each pair
 * gets its own witness, and a pair with no witness at all is a failure rather
 * than a silently vacuous assertion.
 */
function witnesses(): Map<string, { where: string; mine: Float32Array; theirs: Float32Array }> {
  const found = new Map<string, { where: string; mine: Float32Array; theirs: Float32Array }>();
  for (const { where, state } of allStates()) {
    if (found.size === PAIRS.length) break;
    let mine: Float32Array | null = null;
    let theirs: Float32Array | null = null;
    for (const pair of PAIRS) {
      if (found.has(pair.name)) continue;
      if (mine === null) {
        const s = fromCanonical(state, 0);
        mine = encodeFor(s, 0);
        theirs = encodeFor(s, 1);
      }
      let differs = false;
      for (let i = 0; i < pair.length && !differs; i++) {
        if (mine[pair.a + i] !== mine[pair.b + i]) differs = true;
      }
      if (differs) found.set(pair.name, { where, mine, theirs: theirs! });
    }
  }
  return found;
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

  it('mirrors each paired region on a position where that pair actually differs', () => {
    // Read from both seats of the *same* position: an `apply` would also move
    // tiles, and nothing about that is a perspective swap.
    //
    // Non-vacuity is checked **per pair**, not in aggregate. A region that
    // happens to be identical between the seats mirrors under any encoder at
    // all, so one summed "something differed" counter leaves whole regions
    // unasserted — which is how an encoder reading the *encoding* seat's floor
    // marker for both players survives a test written to catch it.
    const found = witnesses();
    expect(
      PAIRS.map((p) => p.name).filter((name) => !found.has(name)),
      'no recorded state distinguishes the seats across these regions',
    ).toEqual([]);

    for (const pair of PAIRS) {
      const { where, mine, theirs } = found.get(pair.name)!;
      let swapped = 0;
      for (let i = 0; i < pair.length; i++) {
        expect(theirs[pair.b + i], `${pair.name} at ${where}: mirror ${pair.a}+${i}`).toBe(
          mine[pair.a + i],
        );
        expect(theirs[pair.a + i], `${pair.name} at ${where}: mirror ${pair.b}+${i}`).toBe(
          mine[pair.b + i],
        );
        if (mine[pair.a + i] !== mine[pair.b + i]) swapped++;
      }
      // This pair, on this position, is a real swap rather than a tautology.
      expect(swapped, `${pair.name} at ${where} does not distinguish the seats`).toBeGreaterThan(0);

      // Factories, centre, bag, lid, tiles-left and the round are seat-neutral.
      const shared = [...Array.from({ length: 174 - 126 }, (_, i) => 126 + i), 175];
      for (const i of shared) expect(theirs[i], `shared ${i} at ${where}`).toBe(mine[i]);
    }

    // Index 174 is deliberately in neither group: it is a disjunction with no
    // opposite-seat counterpart, and a whole-vector swap assertion would fail
    // a correct engine on that index alone [E1-63].
    const shared = [...Array.from({ length: 174 - 126 }, (_, i) => 126 + i), 175];
    expect(shared).not.toContain(OFF_I_START);
    expect(PAIRS.some((p) => p.a === OFF_I_START || p.b === OFF_I_START)).toBe(false);
  });
});

describe('the contents match the oracle value for value [V2-38], [E1-53], [E1-67]', () => {
  it('agrees with the recorded oracle encoding, both seats, on every handcrafted position state', () => {
    // [V2-25], [V2-29] and [V2-30] pin the length, the dtype, the two clamped
    // fields, the excluded bag order and the [174] disjunction — and leave most
    // of the 182 slots unpinned, so a wrong divisor, a field reading the other
    // player's board, or an inverted flag passes all of them. The oracle
    // computes the same 182 floats from the same position; this compares them.
    //
    // The comparison is exact, not approximate. The oracle's values are
    // float32; the generator widens each to the double that represents it
    // exactly and writes the shortest decimal that reads back as that double,
    // so a `Float32Array` element equals the parsed number identically.
    const states = encodedStates();
    const faults: string[] = [];
    let compared = 0;
    for (const { where, state, encoded } of states) {
      const s = fromCanonical(state, 0);
      for (const p of [0, 1] as Player[]) {
        const got = encodeFor(s, p);
        for (let i = 0; i < ENCODED_SIZE; i++) {
          if (got[i] !== encoded[p][i]) {
            faults.push(`${where} seat ${p} index ${i}: ${got[i]} != oracle ${encoded[p][i]}`);
          }
          compared++;
        }
      }
    }
    expect(faults.slice(0, 8)).toEqual([]);
    // All seven fixtures, every state each holds, both seats.
    expect(states.length).toBeGreaterThanOrEqual(90);
    expect(compared).toBe(states.length * 2 * ENCODED_SIZE);
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
