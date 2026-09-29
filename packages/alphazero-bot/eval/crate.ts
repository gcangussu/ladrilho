/** The crate's binary, as the lanes run it. */

import { execFileSync, spawnSync } from 'node:child_process';
import { PACKAGE, binary } from './paths.js';

/** Builds the release binary; every cargo call is locked ([Z11-2]). */
export function buildRelease(): string {
  execFileSync('cargo', ['build', '--locked', '--release', '--quiet'], { cwd: PACKAGE, stdio: 'inherit' });
  return binary('release');
}

/** Runs one command of the binary, failing with its message on an error exit. */
export function alphazero(bin: string, args: string[], input?: Uint8Array): Buffer {
  const r = spawnSync(bin, args, { input, maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`alphazero ${args[0]} exited ${r.status}: ${r.stderr.toString().trim()}`);
  }
  return r.stdout;
}

/** Runs the trainer in its pinned environment ([Z11-5]). */
export function trainer(args: string[]): void {
  execFileSync('bash', ['train/venv.sh', '-m', 'azt.cli', ...args], { cwd: PACKAGE, stdio: 'inherit' });
}
