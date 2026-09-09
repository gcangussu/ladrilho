import type { Rng } from './rng.js';

export type Color = 0 | 1 | 2 | 3 | 4;
export type Player = 0 | 1;

/**
 * The bag shuffle seam [E1-61]. Reorders `bag` **in place** and returns
 * nothing; `index` is the state's `shufflesUsed` at the moment of the call, so
 * a replaying harness can read a recorded order by index rather than keeping a
 * cursor of its own.
 */
export type Shuffle = (bag: Color[], index: number) => void;

/**
 * The data model [E1-3]..[E1-5]. These fields, in this order, are exactly what
 * `toCanonical` emits [E1-62] — {@link AzulState} adds the engine's working
 * state on top, so declaring membership here is what keeps a snapshot from
 * silently losing a field when the model grows.
 */
export interface CanonicalState {
  /** `[5][5]` tile counts per colour per display. */
  factories: number[][];
  /** `[5]` tile counts per colour. */
  center: number[];
  markerInCenter: boolean;
  /** Shuffled draw order; tiles are taken from the **end** [E1-32]. */
  bag: Color[];
  /** `[5]` discard counts per colour. */
  lid: number[];
  /** `[2][25]` 0/1, row-major [E1-2]. */
  walls: number[][];
  /** `[2][5]` colour of each pattern line, `-1` when empty [E1-4]. */
  plColor: number[][];
  /** `[2][5]` tiles held per pattern line; row `r` has capacity `r + 1`. */
  plCount: number[][];
  /** `[2][5]` tile counts per colour on the floor line [E1-3]. */
  floor: number[][];
  /** `[2]` does this player hold the first-player marker. */
  floorMarker: boolean[];
  scores: number[];
  currentPlayer: Player;
  /** Marker holder; starts the current round. */
  firstPlayer: Player;
  /** 0-based count of round *transitions* [E1-35]. */
  roundIndex: number;
  /** Tiles on factories + centre; the round ends at 0 [E1-41]. */
  tilesLeft: number;
  /** Shuffles consumed so far; the index the next shuffle is given [E1-61]. */
  shufflesUsed: number;
  isTerminal: boolean;
  /** Game stopped because no tiles could be dealt [E1-37]. */
  exhausted: boolean;
}

/**
 * A whole game position: the data model plus the engine's own working state.
 * Mutable by design — the bot clones a position per search node, and a
 * persistent structure would cost more than it saves. Callers that want
 * immutability clone first.
 *
 * The two fields below the model are deliberately absent from a snapshot
 * [E1-62] and untouched by `recount` [E1-5].
 */
export interface AzulState extends CanonicalState {
  /** The seeded generator. Duplicated by `clone` [E1-48]. */
  rng: Rng;
  /** Injected shuffle, or `null` to use the seeded default [E1-61]. */
  shuffle: Shuffle | null;
}

/** One player's board in {@link AzulJSON}. */
export interface AzulJSONPlayer {
  score: number;
  /** 5 rows of 5 cells, 0/1. */
  wall: number[][];
  patternLines: { capacity: number; color: number; count: number }[];
  floor: number[];
  floorMarker: boolean;
  floorPenalty: number;
  completedRows: number;
  completedCols: number;
  completedColors: number;
}

/**
 * The lossy view for the UI [E1-52]. Plain structurally-cloneable data, and
 * the bag reported as counts — its order is hidden information.
 */
export interface AzulJSON {
  round: number;
  currentPlayer: Player;
  firstPlayer: Player;
  factories: number[][];
  center: number[];
  markerInCenter: boolean;
  /** Per-colour **counts**, never the order [E1-52], [E1-55]. */
  bag: number[];
  lid: number[];
  tilesLeft: number;
  scores: number[];
  isTerminal: boolean;
  exhausted: boolean;
  outcome: number | null;
  legalActions: number[];
  colorNames: string[];
  players: AzulJSONPlayer[];
}

/**
 * What one tile earned when it was placed [S7-9], [S7-10], [S7-11].
 *
 * The colour is deliberately absent: the wall's colour pattern is fixed
 * [E1-1], so `wallColorAt(row, col)` answers it, and a second copy of a
 * derivable field is what [S7-21] forbids.
 */
export interface Placement {
  /** Pattern-line row, `0..4`; also the wall row [E1-22]. */
  row: number;
  /** Wall column, `0..4` [E1-1]. */
  col: number;
  /** Horizontal run through the new tile, itself included [E1-24]. */
  h: number;
  /** Vertical run through the new tile, itself included. */
  v: number;
  /** What was charged: `placementValue(wall, row, col)` [E1-68], [S7-10]. */
  points: number;
}

/**
 * What the floor line cost, by slot [E1-26], [E1-27].
 *
 * `occupied` beside `rungs` is not a derived pair: `occupied > rungs.length` is
 * exactly [E1-27], the rule that slots past the seventh cost nothing.
 */
export interface FloorCharge {
  /** `floorOccupied` at the moment of charging. MAY exceed `FLOOR_SLOTS`. */
  occupied: number;
  /** The rungs charged: the first `min(occupied, FLOOR_SLOTS)` of `FLOOR_PENALTIES` [S7-16]. */
  rungs: readonly number[];
  /** Did this player hold the marker. Captured before [E1-30] clears it [S7-14]. */
  markerHeld: boolean;
  /** The (non-positive) number charged: `CUM_PENALTY[min(FLOOR_SLOTS, occupied)]` [S7-15]. */
  penalty: number;
}

/** One player's round [S7-17], [S7-18]. */
export interface PlayerRound {
  /** In resolution order, rows `0..4` [E1-22], [E1-25]. */
  placements: readonly Placement[];
  /** The accumulator's value: what wall-tiling charged. */
  tiling: number;
  floor: FloorCharge;
  scoreBefore: number;
  /** The score after the clamp of [E1-28], before any bonus. */
  scoreAfterRound: number;
  /** `>= 0`; what the clamp did not take [S7-17]. */
  forgiven: number;
}

/** One player's end-of-game bonuses [E1-38]. Present only on the terminal ply [S7-19]. */
export interface PlayerBonuses {
  rows: number;
  cols: number;
  colors: number;
  rowPoints: number;
  colPoints: number;
  colorPoints: number;
  /** `rowPoints + colPoints + colorPoints`, charged unclamped. */
  total: number;
  /** Equal to this player's `scoreAfterRound` [S7-26]. */
  scoreBefore: number;
  /** The final score. Nothing is added after this [S7-22]. */
  scoreAfter: number;
}

/**
 * One round resolution [S7-1]: what `endRound` charged, per player.
 *
 * An event, not a position. It is no part of a snapshot [E1-62], the engine
 * retains none [S7-7], and it shares no mutable container with the state it
 * came from, so a caller may keep one indefinitely [S7-8].
 */
export interface RoundScoring {
  /** The index of the round that just ended, captured on entry [S7-13]. */
  round: number;
  /** By seat, `[player 0, player 1]`. */
  players: readonly [PlayerRound, PlayerRound];
  /** Non-`null` if and only if the game ended on this ply [S7-20]. */
  bonuses: readonly [PlayerBonuses, PlayerBonuses] | null;
}
