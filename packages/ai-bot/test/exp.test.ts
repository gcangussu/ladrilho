/**
 * The `exp` port [A8-49].
 *
 * What these checks establish, stated exactly: that `exp` is a correct
 * exponential — within one unit in the last place of this engine's own
 * `Math.exp` across the range that matters — that it handles the boundaries
 * fdlibm handles, and that the constants standing in for fdlibm's high-word
 * comparisons have the bit patterns those comparisons mean.
 *
 * What they do **not** establish is that the port agrees bit for bit with
 * fdlibm. `Math.exp` is not evidence of that: V8's has moved to a
 * correctly-rounded implementation, so equality with it would be a claim about
 * V8, and inequality is not a bug. Nothing here can settle bit-exactness
 * against the original either — the original's inference is ONNX Runtime's
 * float32, and [A8-37]'s tolerance and [A8-39]'s 99% are the honest statements
 * about that. What [A8-49] actually buys is that this function computes the
 * same bits in every JavaScript engine, which is a property of the source (no
 * implementation-approximated call, enforced by [A8-43]) rather than of a
 * comparison.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exp, softmaxInPlace, tanh } from '../src/exp.js';

/** The double with these two 32-bit words. */
function fromWords(hi: number, lo = 0): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, hi);
  view.setUint32(4, lo);
  return view.getFloat64(0);
}

const fromHighWord = (hi: number): number => fromWords(hi);

/** `const NAME = <number>;` as written in `src/exp.ts`. */
function sourceConstants(): Map<string, number> {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'exp.ts'),
    'utf8',
  );
  const found = new Map<string, number>();
  for (const match of source.matchAll(/^const (\w+) = (-?[\d.e+-]+);$/gm)) {
    found.set(match[1], Number(match[2]));
  }
  return found;
}

/** Distance in representable doubles, for the 1-ulp claim. */
function ulpsApart(a: number, b: number): number {
  if (a === b) return 0;
  const view = new DataView(new ArrayBuffer(8));
  const order = (x: number): bigint => {
    view.setFloat64(0, x);
    const bits = view.getBigUint64(0);
    return bits >= 0x8000000000000000n ? 0x8000000000000000n - bits : bits;
  };
  const difference = order(a) - order(b);
  return Number(difference < 0n ? -difference : difference);
}

describe('exp [A8-49]', () => {
  it('[A8-49] is within one ulp of the platform exp across the range', () => {
    let worst = 0;
    let worstAt = 0;
    for (let i = -2000; i <= 2000; i++) {
      // A sweep over the arguments a softmax and a tanh actually see, plus
      // enough beyond to reach both ends of the reduction.
      for (const x of [i * 0.37, i * 0.001, i * 3.1]) {
        const ours = exp(x);
        const theirs = Math.exp(x);
        const apart = ulpsApart(ours, theirs);
        if (apart > worst) {
          worst = apart;
          worstAt = x;
        }
      }
    }
    expect(worst, `worst disagreement at x = ${worstAt}`).toBeLessThanOrEqual(1);
  });

  it('[A8-49] handles zero, the tiny range, and the signs', () => {
    expect(exp(0)).toBe(1);
    expect(exp(-0)).toBe(1);
    expect(exp(1e-300)).toBe(1);
    expect(exp(-1e-300)).toBe(1);
    // Inside `|x| < 2^-28` the answer is the branch's `1 + x` and nothing
    // else. 1e-300 cannot see that — `1 + 1e-300` is 1 — so the probe that
    // decides it is one an ulp of 1 can hold.
    //
    // The argument is chosen to decide the branch's *gate* as well: on about
    // 99.6% of that range the polynomial path below agrees with `1 + x`
    // anyway, and 1e-10 is one of those. Here the two differ by an ulp, and
    // `1 + x` is the correctly-rounded one.
    // Mutations: `return 1 + x` -> `return 1`, and `ax < TINY` -> `ax < 0`;
    // red here, and the second one red nowhere else.
    expect(exp(1.1056700000000001e-10)).toBe(1 + 1.1056700000000001e-10);
    expect(exp(-1.1056700000000001e-10)).toBe(1 - 1.1056700000000001e-10);
    expect(exp(1e-10)).toBe(1 + 1e-10);
    // Within an ulp of `Math.E`, not equal to it: fdlibm's exp is under an
    // ulp of the true value but not correctly rounded, and `Math.E` is.
    expect(ulpsApart(exp(1), Math.E)).toBeLessThanOrEqual(1);
    expect(exp(-1)).toBeCloseTo(1 / Math.E, 15);
    expect(exp(NaN)).toBeNaN();
    expect(exp(Infinity)).toBe(Infinity);
    expect(exp(-Infinity)).toBe(0);
  });

  it('[A8-49] overflows, underflows and goes subnormal where fdlibm does', () => {
    expect(exp(709.7827128933841)).toBe(Infinity);
    expect(exp(709.782712893384)).toBeLessThan(Infinity);
    expect(exp(709.782712893384)).toBeGreaterThan(1e308);
    expect(exp(-745.1332191019412)).toBe(0);
    // Subnormal: the scaling path that fdlibm splits in two. -744.5 cannot
    // tell the two arms apart — there `k` is -1074 and both are one rounding
    // of the same real — so the probe is the first `k` at which they diverge.
    // Mutation: `k >= -1021` -> `k >= -1200`; red on the second line.
    const subnormal = exp(-744.5);
    expect(subnormal).toBeGreaterThan(0);
    expect(subnormal).toBeLessThan(2.3e-308);
    expect(ulpsApart(subnormal, Math.exp(-744.5))).toBeLessThanOrEqual(1);
    expect(exp(-745)).toBe(5e-324);
    // A masked logit, which is what the policy softmax feeds it.
    expect(exp(-1e8)).toBe(0);
  });

  it('[A8-49] is decided by the gate itself far past the thresholds', () => {
    // Everything above holds with the overflow and underflow guards deleted:
    // past the threshold the scaling overflows on its own, and below it the
    // scaling underflows on its own. These do not. `pow2` reduces `k` with an
    // int32 shift, so without the gate an argument past 2^31 exits the loop
    // at once and `exp` returns something near 1 — the guard is what decides
    // these, and a check the guard's absence cannot fail is not a check.
    //
    // Mutations, each red here and green on every other assertion in the file:
    //   `ax >= HUGE_GATE` -> `ax >= Infinity`
    //   `if (x > O_THRESHOLD) return Infinity;` deleted
    //   `if (x < U_THRESHOLD) return 0;` deleted
    expect(exp(5e9)).toBe(Infinity);
    expect(exp(1e300)).toBe(Infinity);
    expect(exp(Number.MAX_VALUE)).toBe(Infinity);
    expect(exp(-5e9)).toBe(0);
    expect(exp(-1e300)).toBe(0);
    expect(exp(-Number.MAX_VALUE)).toBe(0);
  });

  it('[A8-49] rises monotonically, which a broken reduction would not', () => {
    let previous = 0;
    for (let x = -50; x <= 50; x += 0.013) {
      const value = exp(x);
      expect(value, `at ${x}`).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('[A8-49] carries every fdlibm constant to the last bit', () => {
    // `e_exp.c` writes each of these as a hex bit pattern beside its decimal.
    // A decimal is what TypeScript can hold, so what is checked is that our
    // decimal *is* that bit pattern — a truncated coefficient is a different
    // polynomial, and the sweep above cannot see the difference.
    const EXPECTED: [string, number, number][] = [
      ['LN2_HI', 0x3fe62e42, 0xfee00000],
      ['LN2_LO', 0x3dea39ef, 0x35793c76],
      ['INVLN2', 0x3ff71547, 0x652b82fe],
      ['P1', 0x3fc55555, 0x5555553e],
      ['P2', 0xbf66c16c, 0x16bebd93],
      ['P3', 0x3f11566a, 0xaf25de2c],
      ['P4', 0xbebbbd41, 0xc5d26bf1],
      ['P5', 0x3e663769, 0x72bea4d0],
      ['O_THRESHOLD', 0x40862e42, 0xfefa39ef],
      ['U_THRESHOLD', 0xc0874910, 0xd52d3051],
      ['TWOM1000', 0x01700000, 0],
      ['HUGE_GATE', 0x40862e42, 0],
      ['HALF_LN2', 0x3fd62e43, 0],
      ['THREE_HALVES_LN2', 0x3ff0a2b2, 0],
      ['TINY', 0x3e300000, 0],
    ];
    const source = sourceConstants();
    for (const [name, hi, lo] of EXPECTED) {
      expect(source.has(name), `src/exp.ts declares no ${name}`).toBe(true);
      expect(source.get(name), `${name} is not fdlibm's constant`).toBe(fromWords(hi, lo));
    }
    expect(source.size).toBeGreaterThanOrEqual(EXPECTED.length);
  });

  it('[A8-49] uses the constants fdlibm names, bit for bit', () => {
    // Each is a high-word comparison in `e_exp.c`, written here as a value.
    expect(709.7822265625).toBe(fromHighWord(0x40862e42)); // |x| >= this: the gate
    expect(0.3465735912322998).toBe(fromHighWord(0x3fd62e43)); // hx > 0x3fd62e42
    expect(1.0397205352783203).toBe(fromHighWord(0x3ff0a2b2)); // hx < 0x3FF0A2B2
    expect(3.725290298461914e-9).toBe(fromHighWord(0x3e300000)); // hx < 0x3e300000
    expect(9.332636185032189e-302).toBe(fromHighWord(0x01700000)); // twom1000
  });
});

describe('tanh and the softmax, built from exp [A8-49], [A8-13]', () => {
  it('[A8-49] tanh is odd, saturating, and within an ulp or two of the platform', () => {
    expect(tanh(0)).toBe(0);
    expect(tanh(-0)).toBe(-0);
    expect(tanh(40)).toBe(1);
    expect(tanh(-40)).toBe(-1);
    for (let x = -8; x <= 8; x += 0.017) {
      expect(tanh(-x)).toBe(-tanh(x));
      expect(Math.abs(tanh(x) - Math.tanh(x)), `at ${x}`).toBeLessThan(1e-15);
    }
  });

  it('[A8-13] the softmax sums to one and sends a masked logit to zero', () => {
    const logits = new Float64Array([1.5, -2, 0, -1e8, 3.25, -1e8]);
    softmaxInPlace(logits);
    expect(logits[3]).toBe(0);
    expect(logits[5]).toBe(0);
    expect([...logits].reduce((a, b) => a + b)).toBeCloseTo(1, 15);
    // Ratios are what a softmax is: unaffected by the shift it subtracts.
    expect(logits[4] / logits[0]).toBeCloseTo(exp(3.25 - 1.5), 12);
  });

  it('[A8-13] the softmax survives logits that would overflow exp', () => {
    // The maximum has to come off before `exp`: without it `exp(800)` is
    // Infinity, the sum is Infinity, and every probability is NaN or 0. The
    // network's logits are small today, and nothing bounds them in writing.
    const logits = new Float64Array([800, 799, -1e8, 798.5]);
    softmaxInPlace(logits);
    for (const p of logits) expect(Number.isFinite(p)).toBe(true);
    expect([...logits].reduce((a, b) => a + b)).toBeCloseTo(1, 15);
    expect(logits[0]).toBeGreaterThan(logits[1]);
    expect(logits[1] / logits[0]).toBeCloseTo(exp(-1), 12);
    expect(logits[2]).toBe(0);
  });

  it('[A8-13] the softmax is unchanged by adding a constant to every logit', () => {
    const a = new Float64Array([0.5, -1.25, 2, 7]);
    const b = new Float64Array([0.5, -1.25, 2, 7].map((x) => x + 30));
    softmaxInPlace(a);
    softmaxInPlace(b);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 15);
  });
});
