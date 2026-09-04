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
