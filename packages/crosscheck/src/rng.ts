/**
 * The tool's own generator [C10-5]: `xoshiro128**` seeded by `splitmix32`.
 *
 * Deliberately not the TypeScript engine's `Rng`, though it is the same
 * algorithm: the shuffles and moves come from this tool, never from either
 * engine (intent 0008), and a change to the engine's generator must not move
 * which games a run invents.
 */

/** One `splitmix32` step: the next output and the advanced counter. */
export function splitmix32(a: number): [value: number, next: number] {
  const s = (a + 0x9e3779b9) | 0;
  let t = s ^ (s >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  t = t ^ (t >>> 15);
  return [t >>> 0, s];
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Stream {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  /**
   * The stream of game `game` in a run seeded `seed` [C10-6]. Each state word
   * is a word of a `splitmix32` chain over the seed XOR the same word of a
   * chain over the game index, so every word — and so the very first output,
   * which `xoshiro128**` takes from one word alone — depends on both, and a
   * game never depends on the games before it.
   */
  constructor(seed: number, game: number) {
    let a = seed | 0;
    let b = (game ^ 0x5bd1e995) | 0;
    const words: number[] = [];
    for (let i = 0; i < 4; i++) {
      let x: number;
      let y: number;
      [x, a] = splitmix32(a);
      [y, b] = splitmix32(b);
      words.push((x ^ y) >>> 0);
    }
    [this.s0, this.s1, this.s2, this.s3] = words;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** A stream from four raw state words, for checking the generator alone [C10-42]. */
  static fromState(s0: number, s1: number, s2: number, s3: number): Stream {
    const s = new Stream(0, 0);
    [s.s0, s.s1, s.s2, s.s3] = [s0 >>> 0, s1 >>> 0, s2 >>> 0, s3 >>> 0];
    return s;
  }

  /** The next 32-bit output. */
  next(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** A uniform integer in `0 .. n - 1`, `n >= 1`, by rejection. */
  below(n: number): number {
    const limit = 0x100000000 - (0x100000000 % n);
    let r = this.next();
    while (r >= limit) r = this.next();
    return r % n;
  }

  /** A uniform element of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    return items[this.below(items.length)];
  }

  /** Fisher–Yates, descending, in place [C10-7]. */
  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i >= 1; i--) {
      const j = this.below(i + 1);
      const x = items[i];
      items[i] = items[j];
      items[j] = x;
    }
  }
}
