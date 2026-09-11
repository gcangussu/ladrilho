/**
 * The original's settings, as spec 0008's constants table records them.
 *
 * Read from the checkpoint's stored arguments and from `pit.py`, not chosen:
 * this package plays the way the original plays, and these are what that
 * means. The fixture generator of [A8-34] records the same values from the
 * original itself.
 */

/** The settings `pit.py` plays the checkpoint with. */
export const EXPERT = Object.freeze({
  /** Checkpoint `numMCTSSims`. */
  simulations: 100,
  /** Checkpoint `cpuct`. */
  cpuct: 0.5,
  /** Checkpoint `fpu`: first-play urgency, subtracted from a node's `Qs`. */
  fpu: 0.05,
  /** Checkpoint `forced_playouts`. */
  forcedPlayouts: true,
  /** `MCTS.py`'s `k`, the forced-playout coefficient. */
  k: 0.5,
  /** `magic_seeds[0]`: the checkpoint's `universes` is 1. */
  universeSeed: 31416,
  /** `check_end_game`'s value of a draw, for both seats. */
  drawValue: 0.01,
} as const);

/** `MCTS.py`'s `EPS`, inside the square root of an unvisited action's score. */
export const EPS = 1e-8;

/** `select_tiles_from_bag`'s multiplier in the universe draw [A8-22]. */
export const DRAW_MULTIPLIER = 4594591;
