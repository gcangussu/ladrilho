/**
 * Traceability [C10-45]: every requirement of spec 0010 is cited by a test
 * under `test/` or excused in writing, by the scanner the other packages use.
 */

import { join } from 'node:path';
import { describe } from 'vitest';
import { REPO, PACKAGE } from './support/harness.js';
import { checkTraceability } from './support/traceability.js';

describe('traceability against spec 0010', () => {
  checkTraceability({
    specFile: join(REPO, 'spec', '0010-engines-cross-checked.md'),
    prefix: 'C10',
    ownRequirement: 'C10-45',
    sourceDirs: [join(PACKAGE, 'test')],
    minimumRequirements: 40,
  });
});
