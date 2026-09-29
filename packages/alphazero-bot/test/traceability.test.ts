/**
 * Traceability [Z11-49]: every requirement of *0011 — AlphaZero training* is
 * cited by a test — Rust, TypeScript or Python — by identifier, or listed with
 * a reason in the spec's *Traceability exemptions* table.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import { checkTraceability } from './support/traceability.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, '..');

describe('traceability against spec 0011', () => {
  checkTraceability({
    specFile: join(PACKAGE, '..', '..', 'spec', '0011-alphazero-training.md'),
    prefix: 'Z11',
    ownRequirement: 'Z11-49',
    sourceDirs: [HERE, join(PACKAGE, 'tests'), join(PACKAGE, 'train', 'tests')],
    minimumRequirements: 60,
  });
});
