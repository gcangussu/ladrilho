import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the package [A8-1], [A8-48]', () => {
  it('[A8-1] declares engine as its one runtime dependency, from the workspace', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies)).toEqual(['engine']);
    expect(manifest.dependencies['engine']).toMatch(/^workspace:/);
    // `bot` is allowed as a devDependency only: the gate and the tests may use
    // it, `src/` may not ([A8-43] checks the imports).
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain('ui');
  });

  it('[A8-48] ships the original licence verbatim', () => {
    const file = join(ROOT, 'LICENSE.alpha-zero-general');
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file);
    expect(text.toString('utf8')).toMatch(/^MIT License\n\nCopyright \(c\) 2018 Surag Nair\n/);
    // The sha256 of upstream's LICENSE at the pinned commit.
    expect(createHash('sha256').update(text).digest('hex')).toBe(
      '032f110f14ced6c9199c4f1650baa30be60982d883184c1310c7455493e3e5eb',
    );
  });
});
