/** Types for the lanes' and the suite's imports of `checkpoints.mjs` ([0011 Z11-103]). */
export interface Manifest {
  repository: string;
  release: string;
  checkpoints: Record<string, { sha256: string; bytes: number }>;
}
export function manifestPath(packageDir?: string): string;
export function checkpointPath(key: string, packageDir?: string): string;
export function assetName(key: string): string;
export function keyOf(run: string, generation: number): string;
export function readManifest(packageDir?: string): Manifest;
export function writeManifest(manifest: Manifest, packageDir?: string): void;
export function recordCheckpoint(run: string, generation: number, packageDir?: string): boolean;
export function neededKeys(packageDir?: string): string[];
export function namedKeys(args: readonly string[], recorded: Readonly<Record<string, unknown>>): string[];
export function assetUrl(manifest: Manifest, key: string): string;
export function fetchCheckpoints(keys: readonly string[], options?: { packageDir?: string; url?: (key: string) => string }): Promise<string[]>;
export function checkpointsOnDisk(packageDir?: string): string[];
