/**
 * Traceability [G13-53]: every requirement of *0013 — Master against grzhx's
 * AlphaZero* is cited by a test of this package — the cache-free suite under
 * `test/`, `test:grzhx` under `grzhx/test/`, or the crate's Rust tests — by
 * identifier, or listed with a reason in the spec's *Traceability exemptions*
 * table. A requirement cited only under `grzhx/test/` is held by a script the
 * root suite does not run; the spec's table of which check holds which says so.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import { checkTraceability } from './support/traceability.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, '..');

describe('traceability against spec 0013', () => {
  checkTraceability({
    specFile: join(PACKAGE, '..', '..', 'spec', '0013-master-against-grzhx.md'),
    prefix: 'G13',
    ownRequirement: 'G13-53',
    sourceDirs: [HERE, join(PACKAGE, 'grzhx', 'test'), join(PACKAGE, 'tests')],
    minimumRequirements: 50,
  });
});
