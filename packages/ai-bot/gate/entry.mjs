/**
 * What the gate bundles: the arena of *0005*, unchanged, and this package's
 * sessions.
 *
 * Bundled for the reason `bot`'s own lanes give — through Vitest's module
 * runner every cross-module import is a getter call, and this lane crosses
 * into the search on every node of every ply of four hundred games.
 */

export { match, wilsonLowerBound, tier, WIDE_SEEDS } from 'bot/arena';
export { expertChooser, mayWriteBaseline, seedLimit } from './chooser.js';
