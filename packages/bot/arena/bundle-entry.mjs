/**
 * What the corpus generator bundles: the engine surface it drives games with,
 * plus the arena's reference search. A separate entry point because
 * `src/index.ts` deliberately does not export the search [0004 B4-62].
 */
export { apply, legalActions, newGame, toJSON } from 'engine';
export { referenceValues } from './audit.js';
export { tier } from './chooser.js';
