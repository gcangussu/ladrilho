/**
 * Traceability [M5-30]: every requirement in *0005 — Opponent strength* is
 * cited by a test or excused in writing.
 *
 * Scans `ladder/` as well as `test/`, because the gating lane is where the
 * ladder thresholds [M5-13] are actually asserted — a scanner that read only
 * the fast suite would report every measured requirement as an orphan and
 * invite an exemption row for each, which is exactly the rot [M5-30] exists to
 * prevent.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import { checkTraceability } from './support/traceability.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('traceability against spec 0005', () => {
  checkTraceability({
    specFile: join(HERE, '..', '..', '..', 'spec', '0005-opponent-strength.md'),
    prefix: 'M5',
    ownRequirement: 'M5-30',
    sourceDirs: [HERE, join(HERE, '..', 'ladder')],
    minimumRequirements: 25,
  });
});
