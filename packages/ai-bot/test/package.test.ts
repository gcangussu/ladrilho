import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifest } from './support/fixtures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the package [A8-1], [A8-48]', () => {
  it('[A8-1] declares engine as its one runtime dependency, from the workspace', () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(packageJson.dependencies)).toEqual(['engine']);
    expect(packageJson.dependencies['engine']).toMatch(/^workspace:/);
    // `bot` is allowed as a devDependency only: the gate and the tests may use
    // it, `src/` may not ([A8-43] checks the imports).
    expect(Object.keys(packageJson.devDependencies ?? {})).not.toContain('ui');
  });

  it('[A8-48] ships the original licence verbatim', () => {
    const file = join(ROOT, 'LICENSE.alpha-zero-general');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file);
    expect(text.toString('utf8')).toMatch(/^MIT License\n\nCopyright \(c\) 2018 Surag Nair\n/);
    // Against the sha256 [A8-34] recorded from the pinned checkout's own
    // LICENSE, not a constant written down twice.
    expect(createHash('sha256').update(text).digest('hex')).toBe(manifest().licenseSha256);
  });
});
