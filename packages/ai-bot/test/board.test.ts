/**
 * The board encoder, checked here against the table it was written from.
 *
 * Stated honestly, that is the weaker half: a test written from the same table
 * shares its reader's mistakes. The independent anchors are the fixture checks
 * against the original's own boards ([A8-35], [A8-36], [A8-52]); what this file
 * adds is readable failures for the cases a fixture would only report as "row
 * 11 differs".
 */

import { describe, expect, it } from 'vitest';
import {
  CENTER,
  FLOOR,
  apply,
  encodeAction,
  legalActions,
  newGame,
  toJSON,
  type AzulJSON,
} from 'engine';
import { encodeBoard } from '../src/index.js';

function row(board: Int8Array, r: number): number[] {
  return Array.from(board.slice(r * 6, r * 6 + 6));
}

describe('the board [A8-8]', () => {
  it('[A8-8] lays out the opening position as the table says', () => {
    const position = toJSON(newGame(7));
    const board = encodeBoard(position);
    expect(board).toBeInstanceOf(Int8Array);
    expect(board.length).toBe(138);
    expect(row(board, 0)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(row(board, 1)).toEqual([...position.bag, 0]);
    expect(row(board, 2)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(row(board, 3)).toEqual([0, 0, 0, 0, 0, 1]);
    for (let d = 0; d < 5; d++) expect(row(board, 4 + d)).toEqual([...position.factories[d], 0]);
    expect(row(board, 9)).toEqual([-1, -1, -1, -1, -1, 0]);
    expect(row(board, 10)).toEqual([-1, -1, -1, -1, -1, 0]);
    for (const r of [11, 12, 13, 17, 18, 22]) expect(row(board, r)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('[A8-8] is from the perspective of the seat to move', () => {
    const s = newGame(7);
    // Seat 0 takes a display's first colour into its bottom pattern line.
    const take = legalActions(s).find((a) => a >= encodeAction(0, 0, 4) && a % 6 === 4)!;
    apply(s, take);
    const position = toJSON(s);
    expect(position.currentPlayer).toBe(1);
    const board = encodeBoard(position);
    const seat0 = position.players[0].patternLines;
    // Seat 1 is "me" now, so seat 0's line lands in the "them" rows.
    expect(row(board, 9)).toEqual([-1, -1, -1, -1, -1, 0]);
    expect(row(board, 10)).toEqual([...seat0.map((l) => l.color), 0]);
    expect(row(board, 12).slice(0, 5)).toEqual(seat0.map((l) => l.count));
    expect(row(board, 12)[4]).toBeGreaterThan(0);
  });

  it('[A8-8] counts floors into row 2, and the marker into the floor count', () => {
    const s = newGame(11);
    // Seat 0 sends a display to the floor; seat 1 then takes from the centre,
    // picking up the marker.
    apply(s, legalActions(s).find((a) => a % 6 === FLOOR)!);
    const floored = toJSON(s).players[0].floor;
    const centreTake = legalActions(s).find((a) => ((a / 30) | 0) === CENTER && a % 6 === FLOOR)!;
    apply(s, centreTake);
    const position = toJSON(s);
    const board = encodeBoard(position);
    const bothFloors = position.players[0].floor.map((n, c) => n + position.players[1].floor[c]);
    expect(row(board, 2)).toEqual([...bothFloors, 0]);
    expect(floored.reduce((x, y) => x + y)).toBeGreaterThan(0);
    // Back to seat 0: seat 1 is "them", holds the marker, and its floor count
    // includes it.
    expect(position.currentPlayer).toBe(0);
    expect(position.players[1].floorMarker).toBe(true);
    expect(row(board, 3)[5]).toBe(0);
    expect(row(board, 10)[5]).toBe(1);
    const theirTiles = position.players[1].floor.reduce((x, y) => x + y);
    expect(row(board, 12)[5]).toBe(theirTiles + 1);
    expect(row(board, 11)[5]).toBe(floored.reduce((x, y) => x + y));
  });

  it('[A8-8] copies each wall row by row', () => {
    const position = toJSON(newGame(3));
    const posed: AzulJSON = structuredClone(position);
    posed.players[0].wall[0][2] = 1;
    posed.players[1].wall[4][0] = 1;
    const board = encodeBoard(posed);
    expect(row(board, 13)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(row(board, 22)).toEqual([1, 0, 0, 0, 0, 0]);
  });
});

describe('scores saturate [A8-9]', () => {
  it('[A8-9] encodes a score above 127 as 127, and leaves one below alone', () => {
    const posed: AzulJSON = structuredClone(toJSON(newGame(3)));
    posed.players[0].score = 200;
    posed.players[1].score = 126;
    const board = encodeBoard(posed);
    expect(row(board, 0).slice(0, 2)).toEqual([127, 126]);
    posed.players[0].score = 128;
    posed.players[1].score = 127;
    expect(row(encodeBoard(posed), 0).slice(0, 2)).toEqual([127, 127]);
  });
});
