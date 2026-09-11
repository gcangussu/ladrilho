/**
 * `exp`, and the two functions built on it, from IEEE-754 basic operations
 * alone [A8-49].
 *
 * A port of fdlibm's `__ieee754_exp` (`e_exp.c`), the algorithm `Math.exp` was
 * historically an alias for. It is here because ECMA-262 marks `Math.exp`
 * *implementation-approximated*: V8, SpiderMonkey and JavaScriptCore may
 * disagree in the last bit, and they have moved between implementations over
 * time. One differing bit can flip a near-tie in visit counts, the tree carries
 * the flip through the rest of the game, and [A8-27]'s "on any machine" quietly
 * stops holding. `Math.sqrt` and `Math.fround` are exact by specification and
 * are used freely.
 *
 * fdlibm tests the exponent through the high word of the double. A high-word
 * comparison `hx >= H` is the same as `|x| >= d` where `d` is the double whose
 * words are `(H, 0)`, so each test below is written as that comparison against
 * a constant, and `exp.test.ts` asserts every constant's bit pattern.
 */

/** `|x| >= this` is fdlibm's `hx >= 0x40862E42`: the overflow/underflow gate. */
const HUGE_GATE = 709.7822265625;
/** `|x| >= this` is `hx > 0x3fd62e42`: half ln2, where reduction starts. */
const HALF_LN2 = 0.3465735912322998;
/** `|x| < this` is `hx < 0x3FF0A2B2`: 1.5 ln2, below which `k` is ±1. */
const THREE_HALVES_LN2 = 1.0397205352783203;
/** `|x| < this` is `hx < 0x3e300000`: 2^-28, below which `exp(x) = 1 + x`. */
const TINY = 3.725290298461914e-9;

const O_THRESHOLD = 709.782712893384;
const U_THRESHOLD = -745.1332191019411;
const TWOM1000 = 9.332636185032189e-302;

const LN2_HI = 0.6931471803691238;
const LN2_LO = 1.9082149292705877e-10;
const INVLN2 = 1.4426950408889634;

const P1 = 0.16666666666666602;
const P2 = -0.0027777777777015593;
const P3 = 0.00006613756321437934;
const P4 = -0.0000016533902205465252;
const P5 = 4.1381367970572385e-8;

/**
 * `2^k` exactly, for `-1074 <= k <= 1023`, by squaring.
 *
 * Every power of two in that range is a double, and every product here is a
 * product of powers of two, so nothing rounds. This replaces fdlibm's trick of
 * adding `k` to the result's exponent field, which would need a typed array —
 * module-level state [A8-3] — or a bit-level detour through one.
 */
function pow2(k: number): number {
  let result = 1;
  let base = k >= 0 ? 2 : 0.5;
  let n = k >= 0 ? k : -k;
  while (n > 0) {
    if ((n & 1) === 1) result *= base;
    base *= base;
    n >>= 1;
  }
  return result;
}

/** `e^x`, as fdlibm computes it. */
export function exp(x: number): number {
  if (Number.isNaN(x)) return x;
  const ax = x < 0 ? -x : x;
  if (ax >= HUGE_GATE) {
    if (!Number.isFinite(x)) return x > 0 ? x : 0;
    if (x > O_THRESHOLD) return Infinity; // fdlibm's `huge * huge`
    if (x < U_THRESHOLD) return 0; // fdlibm's `twom1000 * twom1000`
  }

  // Argument reduction: x = k·ln2 + r, with r in [-0.5 ln2, 0.5 ln2].
  let k = 0;
  let hi = 0;
  let lo = 0;
  let r = x;
  if (ax >= HALF_LN2) {
    if (ax < THREE_HALVES_LN2) {
      const sign = x < 0 ? -1 : 1;
      hi = x - sign * LN2_HI;
      lo = sign * LN2_LO;
      k = sign;
    } else {
      k = Math.trunc(INVLN2 * x + (x < 0 ? -0.5 : 0.5));
      hi = x - k * LN2_HI; // exact: k·LN2_HI is representable here
      lo = k * LN2_LO;
    }
    r = hi - lo;
  } else if (ax < TINY) {
    return 1 + x;
  }

  const t = r * r;
  const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((r * c) / (c - 2) - r);
  const y = 1 - ((lo - (r * c) / (2 - c)) - hi);
  if (k >= -1021) {
    // `y * 2^k`, one rounding, as adding k to y's exponent would be. At the
    // very top of the range 2^k is not a double, but 2·2^(k-1) reaches it and
    // `y < 1` there, so the doubling cannot overflow on its own.
    return k === 1024 ? y * 2 * pow2(1023) : y * pow2(k);
  }
  // Subnormal result: scale in two exact steps, exactly as fdlibm does, so the
  // single rounding happens in the same place.
  return y * pow2(k + 1000) * TWOM1000;
}

/**
 * `tanh(x)`, as `(1 - e^-2x) / (1 + e^-2x)` on the positive half and odd
 * around zero. The network's value head ends in it.
 */
export function tanh(x: number): number {
  // `Object.is` because `-0 < 0` is false, and `tanh(-0)` is `-0`.
  if (x < 0 || Object.is(x, -0)) return -tanh(-x);
  if (Number.isNaN(x)) return x;
  const e = exp(-2 * x);
  return (1 - e) / (1 + e);
}

/**
 * Softmax over `logits`, in place, as the original's `exp` of a log-softmax.
 *
 * The maximum is subtracted first, which is what the log-softmax does for its
 * own stability and what keeps a masked `-1e8` from becoming `exp` of a number
 * so negative it underflows unevenly.
 */
export function softmaxInPlace(logits: Float64Array): void {
  let max = -Infinity;
  for (const value of logits) {
    if (value > max) max = value;
  }
  let total = 0;
  for (let i = 0; i < logits.length; i++) {
    const e = exp(logits[i] - max);
    logits[i] = e;
    total += e;
  }
  for (let i = 0; i < logits.length; i++) logits[i] /= total;
}
