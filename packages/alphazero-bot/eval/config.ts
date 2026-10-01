/**
 * A run's settings, `runs/<name>/config.json` ([Z11-25]). The crate reads the
 * search's share of it ([Z11-60]); the trainer reads the rest.
 */

import { randomInt } from 'node:crypto';

export interface RunConfig {
  width: number;
  blocks: number;
  seed: number;
  /** Unset (`null`) until the latency lane has measured it ([Z11-58]). */
  playSimulations: number | null;
  selfPlaySimulations: number;
  milestoneSimulations: number;
  cpuct: number;
  fpu: number;
  alpha: number;
  epsilon: number;
  tempPlies: number;
  tau: number;
  gamesPerGeneration: number;
  window: number;
  stepsPerGeneration: number;
  batch: number;
  boundaryWeight: number;
  optimiser: 'sgd';
  momentum: number;
  learningRate: number;
  weightDecay: number;
  milestoneEvery: number;
  threads: number;
  torchThreads: number;
  maxGenerationMinutes: number;
  /**
   * [Z11-65]: `displays` trains on each drawn sample under a random
   * permutation of the five displays. Absent means `none`: run `first`'s
   * config predates it.
   */
  augment?: 'none' | 'displays';
  /**
   * [Z11-67]: the weights of the final margin's and the final walls' losses
   * beside the policy's and the value's. Absent is 0, which is off.
   */
  auxMarginWeight?: number;
  auxWallsWeight?: number;
  /** [Z11-66]: the run and generation this run's checkpoint 0 was taken from. */
  from?: RunOrigin;
}

export interface RunOrigin {
  run: string;
  generation: number;
  checkpointSha256: string;
  /** The parent's generations whose samples start this run's window, oldest first. */
  windowGenerations: number[];
  /** The run whose latency record `playSimulations` came from ([Z11-57]). */
  latencyRun: string;
  /** The settings changed from the parent's, each with both values. Absent in run `second`'s. */
  changes?: Record<string, { parent: number; run: number }>;
}

/** *Starting values*: the first run's settings, with a fresh random seed. */
export function startingConfig(): RunConfig {
  return {
    width: 256,
    blocks: 4,
    // Below 2^48, so it is exact in every language that reads it.
    seed: randomInt(0, 2 ** 48 - 1),
    playSimulations: null,
    selfPlaySimulations: 200,
    milestoneSimulations: 800,
    cpuct: 1.25,
    fpu: 0.25,
    alpha: 0.3,
    epsilon: 0.25,
    tempPlies: 10,
    tau: 1,
    gamesPerGeneration: 500,
    window: 20,
    stepsPerGeneration: 1000,
    batch: 512,
    boundaryWeight: 1,
    optimiser: 'sgd',
    momentum: 0.9,
    learningRate: 0.02,
    weightDecay: 1e-4,
    milestoneEvery: 10,
    threads: 8,
    torchThreads: 4,
    maxGenerationMinutes: 30,
  };
}
