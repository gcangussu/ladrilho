/**
 * The simulations setting's constants ([0012 T12-15], [T12-16], [T12-37]):
 * what the interface needs on its main thread, without the payload. Nothing
 * here may import `./index.ts` or the payload, directly or transitively.
 */

/** The configurations a seat may pick, and the range a seat's own number may take. */
export interface MasterSimulations {
  /** Every move under a second on the machine of record ([T12-25]). */
  readonly quick: number;
  /** The climb's default ([T12-37]). */
  readonly default: number;
  /** Over the budget, and shown to beat the default; absent when the climb named none. */
  readonly deep?: number;
  readonly min: number;
  readonly max: number;
}

export const MASTER_SIMULATIONS: MasterSimulations = Object.freeze({ quick: 5_000, default: 10_000, min: 100, max: 200_000 });

/** An integer in `[min, max]`. */
export function validSimulations(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= MASTER_SIMULATIONS.min && (n as number) <= MASTER_SIMULATIONS.max;
}

/** A configuration as the interface offers it ([T12-37]). */
export interface MasterPreset {
  name: 'Quick' | 'Balanced' | 'Deep';
  simulations: number;
}

/** The configurations, quickest first: `deep` only when the climb named one. */
export const MASTER_PRESETS: readonly MasterPreset[] = Object.freeze([
  { name: 'Quick', simulations: MASTER_SIMULATIONS.quick },
  { name: 'Balanced', simulations: MASTER_SIMULATIONS.default },
  ...(MASTER_SIMULATIONS.deep === undefined ? [] : [{ name: 'Deep' as const, simulations: MASTER_SIMULATIONS.deep }]),
]);
