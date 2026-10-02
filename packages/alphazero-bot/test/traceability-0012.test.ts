/**
 * Traceability [T12-31]: every requirement of *0012 — Master opponent* is
 * cited by a test of this package — Rust or TypeScript — by identifier, or
 * listed with a reason in the spec's *Traceability exemptions* table. The
 * interface's requirements are 0006's, under the numbers they take there, and
 * `packages/ui` traces them.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import { checkTraceability } from './support/traceability.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, '..');

describe('traceability against spec 0012', () => {
  checkTraceability({
    specFile: join(PACKAGE, '..', '..', 'spec', '0012-master-opponent.md'),
    prefix: 'T12',
    ownRequirement: 'T12-31',
    sourceDirs: [HERE, join(PACKAGE, 'web', 'tests')],
    minimumRequirements: 25,
  });
});
