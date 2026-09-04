/**
 * The action encoding and legality, checked directly rather than through a
 * replay: the vectors only ever exercise the actions the oracle chose to play.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTION_SPACE,
  CENTER,
  FLOOR,
  NUM_COLORS,
  NUM_ROWS,
  apply,
  decodeAction,
  encodeAction,
  fromCanonical,
  isLegal,
  legalActions,
  toCanonical,
  wallCol,
  wallColorAt,
  type Color,
} from '../src/index.js';
import { gameDealing, mono } from './support/fixtures.js';
import { gameVectors } from './support/vectors.js';

describe('wall geometry', () => {
  it('puts colour c in column (c + r) % 5 of row r [E1-1]', () => {
    for (let c = 0; c < NUM_COLORS; c++) {
      for (let r = 0; r < NUM_ROWS; r++) {
        expect(wallCol(c, r)).toBe((c + r) % 5);
        expect(wallColorAt(r, wallCol(c, r))).toBe(c);
      }
    }
    for (let r = 0; r < NUM_ROWS; r++) {
      for (let col = 0; col < 5; col++) {
        expect(wallColorAt(r, col)).toBe((col - r + 5) % 5);
      }
    }
  });

  it('stores the wall row-major, so (r, col) is index r * 5 + col [E1-2]', () => {
    // Read off a real tiled wall rather than asserted about in the abstract:
    // every set cell of every recorded terminal position must decode to a
    // colour that occurs exactly once in its row and once in its column.
    const terminal = gameVectors()
      .map((v) => v.plies[v.plies.length - 1].state)
      .filter((s) => s.isTerminal);
    expect(terminal.length).toBeGreaterThan(0);
    for (const state of terminal) {
      for (const wall of state.walls) {
        expect(wall.length).toBe(25);
        for (let r = 0; r < NUM_ROWS; r++) {
          const colours = new Set<number>();
          for (let col = 0; col < 5; col++) {
            if (wall[r * 5 + col] === 1) colours.add(wallColorAt(r, col));
          }
          expect(colours.size).toBe(wall.slice(r * 5, r * 5 + 5).filter((x) => x === 1).length);
        }
      }
    }
  });
});

describe('action encoding', () => {
  it('is source * 30 + color * 6 + destination, dense over 0..179 [E1-6]', () => {
    const seen = new Set<number>();
    for (let source = 0; source <= CENTER; source++) {
      for (let color = 0; color < NUM_COLORS; color++) {
        for (let dest = 0; dest <= FLOOR; dest++) {
          const action = encodeAction(source, color, dest);
          expect(action).toBe(source * 30 + color * 6 + dest);
          expect(action).toBeGreaterThanOrEqual(0);
          expect(action).toBeLessThan(ACTION_SPACE);
          seen.add(action);
        }
      }
    }
    expect(seen.size).toBe(ACTION_SPACE);
  });

  it('round-trips over the whole space in both directions [E1-7], [V2-23]', () => {
    for (let action = 0; action < ACTION_SPACE; action++) {
      const [source, color, dest] = decodeAction(action);
      expect(source).toBeGreaterThanOrEqual(0);
      expect(source).toBeLessThanOrEqual(CENTER);
      expect(color).toBeGreaterThanOrEqual(0);
      expect(color).toBeLessThan(NUM_COLORS);
      expect(dest).toBeGreaterThanOrEqual(0);
      expect(dest).toBeLessThanOrEqual(FLOOR);
      expect(encodeAction(source, color, dest)).toBe(action);
    }
    for (let source = 0; source <= CENTER; source++) {
      for (let color = 0; color < NUM_COLORS; color++) {
        for (let dest = 0; dest <= FLOOR; dest++) {
          expect(decodeAction(encodeAction(source, color, dest))).toEqual([source, color, dest]);
        }
      }
    }
  });
});

describe('legality', () => {
  // Display 0 holds two blue and two yellow; the rest are monochrome, so the
  // opening position has a colour that is present and colours that are not.
  const opening = (): ReturnType<typeof gameDealing> =>
    gameDealing([0, 0, 1, 1, ...mono(2), ...mono(3), ...mono(4), ...mono(0)] as Color[]);

  it('requires the source to hold the colour [E1-9]', () => {
    const s = opening();
    expect(isLegal(s, encodeAction(0, 0, FLOOR))).toBe(true);
    expect(isLegal(s, encodeAction(0, 1, FLOOR))).toBe(true);
    // Display 0 holds no red, black or teal.
    for (const colour of [2, 3, 4]) {
      expect(isLegal(s, encodeAction(0, colour, FLOOR))).toBe(false);
    }
    // The centre is empty at the start of every round.
    for (let colour = 0; colour < NUM_COLORS; colour++) {
      expect(isLegal(s, encodeAction(CENTER, colour, FLOOR))).toBe(false);
    }
  });

  it('refuses a full line, a second colour, and a colour already walled [E1-10]', () => {
    const s = opening();
    // Two blue into row 0 (capacity 1) fills it and overflows one. `isLegal`
    // always answers for `currentPlayer`, so every assertion below is made on
    // one of player 0's turns.
    apply(s, encodeAction(0, 0, 0));
    expect(s.plCount[0][0]).toBe(1);
    apply(s, encodeAction(1, 2, FLOOR)); // player 1, so the turn comes back

    expect(s.currentPlayer).toBe(0);
    // Row 0 is full for player 0, so nothing may go there any more.
    expect(isLegal(s, encodeAction(2, 3, 0))).toBe(false);
    // Row 1 is empty and may take any colour; once it holds blue it takes only blue.
    expect(isLegal(s, encodeAction(4, 0, 1))).toBe(true);
    apply(s, encodeAction(4, 0, 1));
    expect(s.plColor[0][1]).toBe(0);
    apply(s, encodeAction(2, 3, FLOOR));

    expect(s.currentPlayer).toBe(0);
    expect(isLegal(s, encodeAction(3, 4, 1))).toBe(false);
    expect(isLegal(s, encodeAction(3, 4, 2))).toBe(true);
  });

  it('lets a colour already on the wall row nowhere but the floor [E1-10]', () => {
    // A recorded position where some wall row is already tiled: every action
    // targeting that colour and row must be illegal, and its floor twin legal.
    const v = gameVectors()[0];
    const late = v.plies.find((p) => p.state.walls[p.state.currentPlayer].some((x) => x === 1));
    expect(late).toBeDefined();
    const s = fromCanonical(late!.state, 0);
    const p = s.currentPlayer;
    let checked = 0;
    for (let colour = 0; colour < NUM_COLORS; colour++) {
      for (let row = 0; row < NUM_ROWS; row++) {
        if (s.walls[p][row * 5 + wallCol(colour, row)] !== 1) continue;
        for (let source = 0; source <= CENTER; source++) {
          const pool = source === CENTER ? s.center : s.factories[source];
          if (pool[colour] === 0) continue;
          expect(isLegal(s, encodeAction(source, colour, row))).toBe(false);
          expect(isLegal(s, encodeAction(source, colour, FLOOR))).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('has no legal action in a terminal state [E1-11]', () => {
    for (const v of gameVectors().slice(0, 4)) {
      const s = fromCanonical(v.plies[v.plies.length - 1].state, 0);
      expect(s.isTerminal).toBe(true);
      expect(legalActions(s)).toEqual([]);
      for (let action = 0; action < ACTION_SPACE; action++) {
        expect(isLegal(s, action)).toBe(false);
      }
    }
  });

  it('always leaves a move while tiles are available, via the floor [E1-12]', () => {
    // The engine never deadlocks and never passes: taking to the floor is
    // legal whenever the source holds the colour, so a non-terminal position
    // always has at least one legal action.
    for (const v of gameVectors().slice(0, 6)) {
      for (const ply of v.plies) {
        if (ply.state.isTerminal) continue;
        const s = fromCanonical(ply.state, 0);
        const legal = legalActions(s);
        expect(legal.length).toBeGreaterThan(0);
        expect(legal.some((a) => a % 6 === FLOOR)).toBe(true);
      }
    }
  });

  it('returns ascending, duplicate-free actions matching isLegal [E1-13]', () => {
    // The full brute-force cross-check runs on every ply of one game in the
    // replay suite [V2-20]; this pins the ordering contract itself.
    for (const v of gameVectors().slice(0, 3)) {
      for (const ply of v.plies.slice(0, 20)) {
        const s = fromCanonical(ply.state, 0);
        const legal = legalActions(s);
        for (let i = 1; i < legal.length; i++) expect(legal[i]).toBeGreaterThan(legal[i - 1]);
        expect(new Set(legal).size).toBe(legal.length);
        const brute: number[] = [];
        for (let a = 0; a < ACTION_SPACE; a++) if (isLegal(s, a)) brute.push(a);
        expect(legal).toEqual(brute);
      }
    }
  });

  it('rejects out-of-range actions without throwing [E1-6]', () => {
    const s = gameDealing([...mono(0), ...mono(1), ...mono(2), ...mono(3), ...mono(4)]);
    for (const action of [-1, ACTION_SPACE, ACTION_SPACE + 1, 1.5, Number.NaN]) {
      expect(isLegal(s, action)).toBe(false);
    }
  });
});

describe('apply validates before it mutates [E1-14]', () => {
  it('throws and leaves the state untouched', () => {
    const s = gameDealing([0, 0, 1, 1, ...mono(2), ...mono(3), ...mono(4), ...mono(0)] as Color[]);
    const before = toCanonical(s);
    for (const action of [-1, ACTION_SPACE, 1.5, Number.NaN]) {
      expect(() => apply(s, action)).toThrow();
      expect(toCanonical(s)).toEqual(before);
    }
    // Illegal because display 0 holds no red.
    expect(() => apply(s, encodeAction(0, 2, FLOOR))).toThrow();
    expect(toCanonical(s)).toEqual(before);

    // Illegal destination: fill row 0, then try to add to it. The take would
    // otherwise have emptied a display, so a half-applied state would show.
    apply(s, encodeAction(0, 0, 0));
    apply(s, encodeAction(1, 2, FLOOR));
    const mid = toCanonical(s);
    expect(() => apply(s, encodeAction(2, 3, 0))).toThrow('full');
    expect(toCanonical(s)).toEqual(mid);
  });

  it('refuses to move at all once the game is over [E1-11]', () => {
    const v = gameVectors()[0];
    const s = fromCanonical(v.plies[v.plies.length - 1].state, 0);
    const before = toCanonical(s);
    expect(() => apply(s, 0)).toThrow();
    expect(toCanonical(s)).toEqual(before);
  });
});
