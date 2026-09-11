import { describe, expect, it } from 'vitest';
import { CENTER, FLOOR, encodeAction } from 'engine';
import { fromTheirAction, toTheirAction } from '../src/index.js';

describe('the two action encodings [A8-11]', () => {
  it('[A8-11] are exact inverses over 0..179, in both directions', () => {
    const images = new Set<number>();
    for (let a = 0; a < 180; a++) {
      expect(fromTheirAction(toTheirAction(a))).toBe(a);
      expect(toTheirAction(fromTheirAction(a))).toBe(a);
      images.add(toTheirAction(a));
    }
    expect(images.size).toBe(180);
    expect(Math.min(...images)).toBe(0);
    expect(Math.max(...images)).toBe(179);
  });

  it('[A8-11] put our centre at their source 0 and our display d at their d + 1', () => {
    // Their table, from AzulLogicNumba.py's comment: 0 is "Centre, Blue, Line
    // 1", 29 "Centre, White, Floor", 30 "Factory 1, Blue, Line 1", 179
    // "Factory 5, White, Floor". Written out, not recomputed from the formula.
    expect(toTheirAction(encodeAction(CENTER, 0, 0))).toBe(0);
    expect(toTheirAction(encodeAction(CENTER, 4, FLOOR))).toBe(29);
    expect(toTheirAction(encodeAction(0, 0, 0))).toBe(30);
    expect(toTheirAction(encodeAction(0, 4, FLOOR))).toBe(59);
    expect(toTheirAction(encodeAction(4, 4, FLOOR))).toBe(179);
    expect(toTheirAction(encodeAction(2, 3, 1))).toBe(3 * 30 + 3 * 6 + 1);
  });

  it('[A8-11] leave colour and destination alone', () => {
    for (let a = 0; a < 180; a++) expect(toTheirAction(a) % 30).toBe(a % 30);
  });
});
