/**
 * The expert of *0008 — Expert opponent*: a port of a published AlphaZero-style
 * Azul player, running on our engine.
 *
 * Kept apart from `bot` on purpose (intent 0006). Nothing here imports it, and
 * nothing in it changes to make room for this.
 */

export { EXPERT } from './constants.js';
export { fromTheirAction, toTheirAction } from './actions.js';
export { encodeBoard } from './board.js';
