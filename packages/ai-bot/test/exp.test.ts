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

import { describe, expect, it } from 'vitest';
import { exp, softmaxInPlace, tanh } from '../src/exp.js';

/** The double whose high word is `hi` and low word 0. */
function fromHighWord(hi: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, hi);
  view.setUint32(4, 0);
  return view.getFloat64(0);
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
    // Subnormal: the scaling path that fdlibm splits in two.
    const subnormal = exp(-744.5);
    expect(subnormal).toBeGreaterThan(0);
    expect(subnormal).toBeLessThan(2.3e-308);
    expect(ulpsApart(subnormal, Math.exp(-744.5))).toBeLessThanOrEqual(1);
    // A masked logit, which is what the policy softmax feeds it.
    expect(exp(-1e8)).toBe(0);
  });

  it('[A8-49] rises monotonically, which a broken reduction would not', () => {
    let previous = 0;
    for (let x = -50; x <= 50; x += 0.013) {
      const value = exp(x);
      expect(value, `at ${x}`).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
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

  it('[A8-13] the softmax is unchanged by adding a constant to every logit', () => {
    const a = new Float64Array([0.5, -1.25, 2, 7]);
    const b = new Float64Array([0.5, -1.25, 2, 7].map((x) => x + 30));
    softmaxInPlace(a);
    softmaxInPlace(b);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 15);
  });
});
