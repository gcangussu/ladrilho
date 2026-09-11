/**
 * What the corpus exporter bundles: the engine it drives games with, and
 * `bot`'s move chooser to play some of them.
 *
 * Bundled rather than imported directly for the reason `bot`'s own lanes give:
 * through Vitest's module runner every cross-module import is a getter call,
 * and a corpus of whole games at `sharp`'s budget crosses into the search on
 * every node of every ply.
 */

export { Rng, apply, legalActions, newGame, toJSON } from 'engine';
export { chooseMove } from 'bot';
