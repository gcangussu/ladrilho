/**
 * The engine's own generator [E1-46]: a 32-bit `xoshiro128**` stream seeded
 * through `splitmix32`. `Math.random` is deliberately not used — a game has to
 * replay identically on any platform and any JS engine.
 *
 * The algorithm, the seeding, and the shuffle direction are part of the
 * contract: change any of them and every recorded game changes. They do *not*
 * reproduce ludometer's tile order for a given seed [E1-49] — Python's
 * Mersenne Twister is a different generator — which is why conformance is
 * replay-based rather than seed-based.
 */

/** One `splitmix32` step. Returns the next output and the advanced counter. */
function splitmix32(a: number): [value: number, next: number] {
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

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  /**
   * Seeds the stream. The seed is reduced to 32 bits, so seeds that differ
   * only above bit 31 produce the same game.
   */
  constructor(seed: number) {
    let a = seed | 0;
    [this.s0, a] = splitmix32(a);
    [this.s1, a] = splitmix32(a);
    [this.s2, a] = splitmix32(a);
    [this.s3] = splitmix32(a);
    // xoshiro is undefined on an all-zero state. splitmix32 practically never
    // produces one; this costs nothing and removes the "practically".
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** A copy continuing this stream exactly, sharing nothing with it [E1-48]. */
  copy(): Rng {
    const other = new Rng(0);
    other.s0 = this.s0;
    other.s1 = this.s1;
    other.s2 = this.s2;
    other.s3 = this.s3;
    return other;
  }

  /** The next 32-bit output, `0 .. 2**32 - 1`. */
  next(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /**
   * A uniform integer in `0 .. n - 1` for `n >= 1`. Rejection-sampled rather
   * than reduced modulo, so the result is unbiased; the number of outputs it
   * consumes therefore varies, which is deterministic but not constant.
   */
  below(n: number): number {
    const limit = 0x100000000 - (0x100000000 % n);
    let r = this.next();
    while (r >= limit) r = this.next();
    return r % n;
  }
}

/**
 * Fisher-Yates, descending [E1-46]. The direction is contractual: shuffling
 * ascending with the same stream deals a different game.
 */
export function shuffleInPlace<T>(items: T[], rng: Rng): void {
  for (let i = items.length - 1; i >= 1; i--) {
    const j = rng.below(i + 1);
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
}
