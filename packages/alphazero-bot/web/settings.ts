/**
 * The simulations setting's constants ([0012 T12-15], [T12-16]): what the
 * interface needs on its main thread, without the payload. Nothing here may
 * import `./index.ts` or the payload, directly or transitively.
 */

/** The default, and the range a seat's setting may take. */
export const MASTER_SIMULATIONS = Object.freeze({ default: 10_000, min: 100, max: 200_000 } as const);

/** An integer in `[min, max]`. */
export function validSimulations(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= MASTER_SIMULATIONS.min && (n as number) <= MASTER_SIMULATIONS.max;
}
