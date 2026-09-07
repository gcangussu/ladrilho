/**
 * Traceability [B4-59]: every requirement in *0004 — Computer opponent* is
 * cited by a test or excused in writing.
 *
 * The scanner is shared with [M5-30] — see `support/traceability.ts` for what
 * the four checks are and why the third is the one that rots silently.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import { checkTraceability } from './support/traceability.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('traceability against spec 0004', () => {
  checkTraceability({
    specFile: join(HERE, '..', '..', '..', 'spec', '0004-computer-opponent.md'),
    prefix: 'B4',
    ownRequirement: 'B4-59',
    // `arena/` implements 0005 and cites 0004 requirements in passing; both are
    // legitimate citations, so both directories count.
    sourceDirs: [HERE, join(HERE, '..', 'ladder')],
    minimumRequirements: 50,
  });
});
