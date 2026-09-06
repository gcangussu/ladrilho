/**
 * A deterministic two-player Azul rules engine. See `spec/0001-engine-core.md`;
 * every exported name here is pinned by a numbered requirement there.
 *
 * The package has no runtime dependencies and touches neither the DOM, the
 * filesystem, timers, nor the network [E1-50], so it runs unchanged in a
 * browser, in a worker, and under Vitest in Node.
 */

export type {
  AzulJSON,
  AzulJSONPlayer,
  AzulState,
  CanonicalState,
  Color,
  Player,
  Shuffle,
} from './types.js';

export {
  ACTION_SPACE,
  CENTER,
  COLOR_BONUS,
  COLOR_NAMES,
  COL_BONUS,
  CUM_PENALTY,
  FACTORY_SIZE,
  FLOOR,
  FLOOR_PENALTIES,
  FLOOR_SLOTS,
  NUM_COLORS,
  NUM_FACTORIES,
  NUM_ROWS,
  NUM_TILES,
  ROW_BONUS,
  TILES_PER_COLOR,
  wallCol,
  wallColorAt,
} from './constants.js';

export { Rng } from './rng.js';
export { clone, newGame } from './state.js';
export { decodeAction, encodeAction, isLegal, legalActions } from './actions.js';
export { apply } from './apply.js';
export {
  completedColors,
  completedCols,
  completedRows,
  floorOccupied,
  floorPenalty,
  outcome,
  recount,
  tileCensus,
} from './inspect.js';
export { fromCanonical, toCanonical } from './canonical.js';
export { fromJSON, toJSON } from './json.js';
export {
  placementValue,
  wallCompletedColors,
  wallCompletedCols,
  wallCompletedRows,
} from './score.js';
export { renderText } from './render.js';
export {
  ENCODED_SIZE,
  OFF_BAG,
  OFF_CENTER,
  OFF_CENTER_TOTAL,
  OFF_FACTORIES,
  OFF_FACTORY_FLAGS,
  OFF_I_START,
  OFF_LID,
  OFF_MARKER_CENTER,
  OFF_MY_FLOOR,
  OFF_MY_LINES,
  OFF_MY_SETS,
  OFF_MY_WALL,
  OFF_OP_FLOOR,
  OFF_OP_LINES,
  OFF_OP_SETS,
  OFF_OP_WALL,
  OFF_ROUND,
  OFF_SCORES,
  OFF_TILES_LEFT,
  encode,
  encodeFor,
} from './observe.js';
