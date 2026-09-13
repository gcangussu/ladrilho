/**
 * Traceability [A8-45]: every requirement in *0008 — Expert opponent* is cited
 * by a test, by identifier, or listed with a reason in that spec's
 * *Traceability exemptions* table.
 *
 * The scanner is the one `packages/bot` uses, copied rather than imported:
 * `bot` is a devDependency here and its test support is not part of its
 * package surface. See `support/traceability.ts` for what the six checks are
 * and which of them rots silently.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import { checkTraceability } from './support/traceability.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('traceability against spec 0008', () => {
  checkTraceability({
    specFile: join(HERE, '..', '..', '..', 'spec', '0008-expert-opponent.md'),
    prefix: 'A8',
    ownRequirement: 'A8-45',
    sourceDirs: [HERE, join(HERE, '..', 'gate')],
    minimumRequirements: 40,
  });
});
