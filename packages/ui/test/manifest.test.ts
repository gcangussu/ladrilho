/**
 * [U3-74]: `dependencies` is an allowlist, not a judgement — `engine` plus the
 * Solid v2 runtime and nothing else, so [U3-7]'s "engine is the only dependency
 * that carries any knowledge of the rules" cannot be widened by accident.
 * Widening it is a spec change.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** `engine` and `bot` [U3-7] plus the Solid v2 runtime [U3-10]. */
const ALLOWED = ['@solidjs/web', 'bot', 'engine', 'solid-js'];

describe('package manifest', () => {
  it('[U3-74] declares exactly engine, bot and the Solid v2 runtime as dependencies', () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(ALLOWED);
  });

  it('[U3-74] [U3-10] pins the Solid runtime to v2', () => {
    for (const pkg of ['solid-js', '@solidjs/web']) {
      expect(manifest.dependencies[pkg], pkg).toMatch(/^\D*2\./);
    }
  });

  it('[U3-74] depends on engine and bot through the workspace, not registry copies [U3-7]', () => {
    expect(manifest.dependencies['engine']).toMatch(/^workspace:/);
    expect(manifest.dependencies['bot']).toMatch(/^workspace:/);
  });

  it('[U3-74] [U3-11] declares a vitest range that resolves to 5', () => {
    expect(manifest.devDependencies['vitest']).toMatch(/^\^?5\./);
  });
});
