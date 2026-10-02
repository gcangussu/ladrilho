/** Types for the suite's import of `web.mjs`'s check ([0012 T12-7]). */
export function shippedMilestone(
  shipped: { run: string; generation: number; checkpointSha256: string; paritySha256: string },
  packageDir?: string,
): { checkpoint: Uint8Array; parity: Uint8Array; cpuct: number; fpu: number };
