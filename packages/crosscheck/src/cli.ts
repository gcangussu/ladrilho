/**
 * The command line: `check` and `replay` on the real TypeScript engine and the
 * release-built checker. Everything else is `main.ts`, which the suite drives
 * with a debug checker and, for [C10-38], a mutated engine.
 */

import * as engine from 'engine';
import { checkerPath } from './checker.js';
import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2), { engine, checker: checkerPath('release') });
