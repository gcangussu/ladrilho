---
title: Engine core
author: Gabriel Cangussu
date: 2026-09-03
status: draft
intent: 0001 — Rules engine
prefix: E1
summary: >
  The two-player Azul rules engine: state layout, the 180-value action encoding,
  legality, tile routing, round resolution and scoring, game end, seeded
  determinism, and the fixed-length observation vector. How it is proven correct
  is specified separately in 0002 — Engine conformance vectors.
---

# Engine core

## Scope

Covers `packages/engine`: the complete rules of two-player Azul as a headless, deterministic
state machine, plus the observation encoding the bot consumes.

Does not cover: how correctness is verified (*0002 — Engine conformance vectors*), rendering
(*intent 0002 — Web interface*), or move evaluation of any kind (*intent 0003 — Computer
opponent*). The engine ranks nothing and prefers nothing.

This is a port of the Python engine in [RemiFabre/ludometer](https://github.com/RemiFabre/ludometer)
(`ludometer/azul/engine.py`). Where this document and that file disagree, this document is a bug
unless it says otherwise explicitly — the two places it deliberately diverges are the random
number generator ([E1-46]) and the language-level API shape.

## Definitions

| Term | Meaning |
| --- | --- |
| **Colour** | Integer `0..4` = blue, yellow, red, black, teal. |
| **Source** | Where tiles are taken from: `0..4` a factory display, `5` the centre. |
| **Destination** | Where they go: `0..4` a pattern line row, `5` the floor line. |
| **Lid** | The discard pile. Tiles return to the bag from here when it runs dry. |
| **Marker** | The first-player marker. |
| **Ply** | One `apply` call: one player taking one colour from one source. |
| **Round** | The plies from a refill until the board is empty, plus the wall-tiling that follows. |

Constants:

| Name | Value |
| --- | --- |
| `NUM_COLORS` | 5 |
| `TILES_PER_COLOR` | 20 (100 tiles total) |
| `NUM_FACTORIES` | 5 (the two-player count) |
| `FACTORY_SIZE` | 4 |
| `NUM_ROWS` | 5 (pattern line `r` has capacity `r + 1`) |
| `FLOOR_SLOTS` | 7 |
| `FLOOR_PENALTIES` | `[-1, -1, -2, -2, -2, -3, -3]` |
| `ACTION_SPACE` | 180 |
| `ENCODED_SIZE` | 182 |
| `ROW_BONUS` / `COL_BONUS` / `COLOR_BONUS` | 2 / 7 / 10 |

### Wall geometry

- **[E1-1]** The wall is the standard fixed-colour wall. Colour `c` occupies column
  `(c + r) % 5` in row `r`; equivalently the cell at row `r`, column `col` is colour
  `(col - r + 5) % 5`.
- **[E1-2]** The wall MUST be stored row-major, so cell `(r, col)` is index `r * 5 + col`.

## Data model

State is a single mutable object with an explicit `clone`. Mutation is deliberate: the bot clones
a position per search node, and a persistent structure would cost more than it saves. Callers that
want immutability clone first.

```ts
type Color = 0 | 1 | 2 | 3 | 4;
type Player = 0 | 1;

interface AzulState {
  factories: number[][];   // [5][5] tile counts per colour per display
  center: number[];        // [5] tile counts per colour
  markerInCenter: boolean;
  bag: Color[];            // shuffled draw order; tiles are taken from the end
  lid: number[];           // [5] discard counts per colour
  walls: number[][];       // [2][25] 0/1, row-major
  plColor: number[][];     // [2][5] colour of each pattern line, -1 when empty
  plCount: number[][];     // [2][5] tiles held per pattern line
  floor: number[][];       // [2][5] tile counts per colour on the floor line
  floorMarker: boolean[];  // [2] does this player hold the marker
  scores: number[];        // [2]
  currentPlayer: Player;
  firstPlayer: Player;     // marker holder; starts the current round
  roundIndex: number;      // 0-based
  tilesLeft: number;       // tiles on factories + centre; the round ends at 0
  isTerminal: boolean;
  exhausted: boolean;      // game stopped because no tiles could be dealt
}
```

- **[E1-3]** The floor line MUST be stored as counts per colour, not as an ordered list. Order
  never affects scoring, and the marker is tracked by `floorMarker`, not as a tile.
- **[E1-4]** A pattern line with `plCount[r] === 0` MUST have `plColor[r] === -1`.
- **[E1-5]** Implementations MAY keep derived caches (tile totals, per-colour placement masks)
  as long as [E1-13] and the invariants hold, and MUST expose a `recount()` that rebuilds them
  after a caller edits state fields directly. Tests and the UI do that; the engine itself keeps
  caches current on every `apply`.

## Action encoding

- **[E1-6]** An action is the integer `source * 30 + color * 6 + destination`, with `source`
  `0..5`, `color` `0..4`, `destination` `0..5`. The space is `0..179` and MUST be dense: every
  integer in range decodes, whether or not it is legal in a given position.
- **[E1-7]** `encodeAction` and `decodeAction` MUST be exact inverses over the whole space.
- **[E1-8]** The encoding is part of the public contract — it appears in saved games, test
  vectors, and the bot's policy head. It MUST NOT change without a new spec.

## Legality

For the current player, action `(source, color, dest)` is legal exactly when all of:

- **[E1-9]** The source pool holds at least one tile of `color`.
- **[E1-10]** `dest === FLOOR`, or all three of:
  - the pattern line `dest` is not full (`plCount[dest] <= dest`);
  - it is empty, or already holds `color`;
  - the wall cell for `color` in row `dest` is empty.
- **[E1-11]** The game is not over. A terminal state MUST have no legal actions.
- **[E1-12]** Taking to the floor is legal whenever [E1-9] holds, so a player with tiles
  available always has at least one legal action — the engine never deadlocks and never needs to
  pass. Forced-to-floor is an ordinary move the caller must choose, not something the engine does
  on the player's behalf.
- **[E1-13]** `legalActions()` MUST return exactly the set of actions for which `isLegal()` is
  true, with no duplicates. Order is unspecified but MUST be deterministic for a given state;
  callers that need a canonical order sort.

## Applying a move

`apply(action)` performs the whole ply, including any round or game transition it triggers.

- **[E1-14]** An action that is out of range or illegal MUST throw, MUST NOT mutate the state,
  and MUST be validated before anything is taken. A half-applied state is a defect, not an
  outcome.
- **[E1-15]** All tiles of `color` are removed from the source pool.
- **[E1-16]** When the source is a factory display, every remaining tile on that display moves to
  the centre.
- **[E1-17]** When the source is the centre and the marker is still there, the marker moves to
  the current player's floor line (`markerInCenter` false, `floorMarker[p]` true). Later takes
  from the centre in the same round move no marker.
- **[E1-18]** With destination a pattern line: the line's colour is set, it fills to at most
  `dest + 1` tiles, and the surplus overflows to the floor line.
- **[E1-19]** With destination the floor, every taken tile overflows.
- **[E1-20]** Overflow fills the floor line up to `FLOOR_SLOTS` occupied slots — counting the
  marker as one occupied slot — and any tile beyond that goes straight to the lid.
- **[E1-21]** `tilesLeft` decreases by the number of tiles taken. If it is still positive, the
  turn passes to the other player; if it reaches zero, round resolution ([E1-22] onwards) runs
  immediately as part of the same `apply`.

## Round resolution

Runs for both players, player 0 first, when the board empties.

### Wall-tiling and scoring

- **[E1-22]** Pattern lines are resolved in row order `0..4`. A line MUST be resolved only when
  full (`plCount[r] === r + 1`); a partial line is left untouched for the next round.
- **[E1-23]** Resolving a line places one tile on that row's wall cell for the line's colour, and
  sends the other `r` tiles to the lid. The line is emptied (`plCount = 0`, `plColor = -1`).
- **[E1-24]** Placing a tile scores: let `h` be the length of the horizontal run through the new
  tile and `v` the vertical run, each counting the new tile itself. If `h > 1` or `v > 1`, score
  `(h > 1 ? h : 0) + (v > 1 ? v : 0)`; otherwise score 1.
- **[E1-25]** Tiles placed earlier in the same resolution are visible to later ones, so a lower
  row can score against a tile that row 0 just placed. Row order is therefore load-bearing.

### Floor penalties

- **[E1-26]** Occupied floor slots are the sum of the floor's per-colour counts plus 1 if the
  player holds the marker.
- **[E1-27]** The penalty is the sum of `FLOOR_PENALTIES` over the first `min(occupied, 7)`
  slots. Slots beyond the seventh cost nothing.
- **[E1-28]** The round's score change is the tiling gain plus the (negative) penalty, and a
  player's score MUST be clamped at 0 after applying it. Clamping happens per round, not per
  tile, and never carries a debt forward.
- **[E1-29]** All floor tiles then move to the lid.

### Marker and next round

- **[E1-30]** After scoring, whichever player holds the marker gives it up
  (`floorMarker` false, `markerInCenter` true) and becomes `firstPlayer` and `currentPlayer` for
  the next round.
- **[E1-31]** If neither player took from the centre all round — possible when every display is
  monochrome — the marker never left the centre, and the next round starts with the player who
  did *not* make the last move, preserving alternation.

### Refill

- **[E1-32]** Refill deals `FACTORY_SIZE` tiles to each display in order `0..4`, drawing from the
  end of the bag.
- **[E1-33]** When the bag empties mid-deal, all lid tiles move to the bag, the lid is emptied,
  and the bag is shuffled ([E1-46]). Dealing then continues.
- **[E1-34]** When bag *and* lid are both empty, dealing stops early and the remaining displays
  stay short. This is a legal position, not an error.
- **[E1-35]** `roundIndex` increments once per refill.

## Game end

- **[E1-36]** After a round resolves, the game ends if either player has at least one complete
  wall row. The check runs after tiling and before the next refill.
- **[E1-37]** The game also ends if a refill deals nothing at all (bag and lid both empty). Such
  a state MUST set `exhausted` so callers can tell it apart from an ordinary finish.
- **[E1-38]** On ending, each player scores `2` per complete row, `7` per complete column, and
  `10` per colour placed all five times, added to the running score. End bonuses are NOT clamped
  by [E1-28] — clamping applies to round scoring only.
- **[E1-39]** `outcome()` returns `+1` if player 0 wins, `-1` if player 1 wins, `0` for a draw,
  and `null` while the game is unfinished. Ties on score are broken by the number of complete
  rows; still tied is a draw.

## Invariants

Assertable after every ply, and checked by the property tests in *0002*.

- **[E1-40]** **Conservation.** Counting the bag, lid, centre, every display, both floor lines,
  both sets of pattern lines, and both walls yields exactly 20 tiles of each colour, always.
- **[E1-41]** `tilesLeft` equals the sum of all display and centre counts.
- **[E1-42]** The marker is in exactly one place: the centre, or one player's floor.
- **[E1-43]** No pattern line exceeds its capacity, holds two colours, or holds a colour already
  on that row of the wall.
- **[E1-44]** No wall cell is set twice, and each colour appears at most once per row and per
  column.
- **[E1-45]** Scores are never negative.

## Determinism

- **[E1-46]** The only randomness is bag shuffling. The engine MUST take a seed and MUST use its
  own PRNG — not `Math.random` — so a game replays identically on any platform and any JS engine.
  Default: a 32-bit `xoshiro128**` stream seeded through `splitmix32`, shuffled with Fisher-Yates
  descending (`for i = n-1 down to 1: swap(a[i], a[rng.below(i+1)])`). The algorithm and the
  shuffle direction are part of the contract: change either and every recorded game changes.
- **[E1-47]** The generator MUST be consumed only by the shuffles in `newGame` and [E1-33].
  Nothing else may draw from it, or the same seed stops meaning the same game.
- **[E1-48]** `clone()` MUST duplicate every mutable container and the generator's internal
  state, so a clone continues the parent's stream exactly and neither can affect the other.
- **[E1-49]** The port does NOT reproduce ludometer's tile order for a given numeric seed —
  Python's Mersenne Twister is a different generator. Conformance is therefore replay-based, not
  seed-based; see *0002 — Engine conformance vectors*.
- **[E1-61]** `newGame` MUST accept an optional shuffle function in place of the seeded default,
  called with the bag before every deal. This is the seam the conformance harness uses to replay
  a recorded bag order ([V2-6]); it is the only supported way to influence the engine's
  randomness, and production callers pass a seed.

## Interfaces

```ts
// construction
type Shuffle = (bag: Color[]) => void;                // in place; see [E1-61]
function newGame(seed: number, shuffle?: Shuffle): AzulState;
function clone(s: AzulState): AzulState;

// actions
function encodeAction(source: number, color: Color, dest: number): number;
function decodeAction(action: number): [source: number, color: Color, dest: number];
function legalActions(s: AzulState): number[];
function isLegal(s: AzulState, action: number): boolean;
function apply(s: AzulState, action: number): void;   // mutates; throws on illegal

// inspection
function outcome(s: AzulState): 1 | 0 | -1 | null;
function floorPenalty(s: AzulState, p: Player): number;
function completedRows(s: AzulState, p: Player): number;
function completedCols(s: AzulState, p: Player): number;
function completedColors(s: AzulState, p: Player): number;
function tileCensus(s: AzulState): number[];          // always [20,20,20,20,20]
function recount(s: AzulState): void;

// serialisation and display
function toJSON(s: AzulState): AzulJSON;              // plain data for the UI
function renderText(s: AzulState): string;            // debugging aid
function encode(s: AzulState): Float32Array;          // length ENCODED_SIZE
```

- **[E1-50]** The package MUST have no runtime dependencies and MUST NOT touch the DOM, the
  filesystem, timers, or the network — it has to run unchanged in a browser, in a worker, and
  under Vitest in Node.
- **[E1-51]** Every function above MUST be pure with respect to everything except the state
  passed in. `apply` and `recount` mutate their argument; nothing else mutates anything.
- **[E1-52]** `toJSON` MUST return structurally-cloneable plain data (no class instances, no
  functions) so a state can cross a worker boundary.

## Observation encoding

`encode()` produces a fixed-length `Float32Array` from the **current player's** point of view:
"me" is `currentPlayer`, "them" is the other player. The bot depends on this layout; it is a
contract, not an implementation detail.

| Range | Length | Contents |
| --- | --- | --- |
| `[0, 25)` | 25 | My wall, row-major, 0/1 |
| `[25, 50)` | 25 | Their wall |
| `[50, 80)` | 30 | My pattern lines: 5 rows × (5 colour one-hot, then `count / (r + 1)`) |
| `[80, 110)` | 30 | Their pattern lines, same layout |
| `[110, 117)` | 7 | My floor: 5 colour counts `/7`, occupied slots `/7`, marker flag |
| `[117, 124)` | 7 | Their floor, same layout |
| `[124, 126)` | 2 | Scores `/100` — mine, theirs |
| `[126, 151)` | 25 | Factory displays: 5 × 5 colour counts `/4` |
| `[151, 156)` | 5 | Per-display non-empty flag |
| `[156, 161)` | 5 | Centre colour counts `/10` |
| `[161, 162)` | 1 | Centre total `/20` |
| `[162, 163)` | 1 | Marker still in the centre, 0/1 |
| `[163, 168)` | 5 | Bag colour counts `/20` |
| `[168, 173)` | 5 | Lid colour counts `/20` |
| `[173, 174)` | 1 | Tiles left on the board this round `/20` |
| `[174, 175)` | 1 | I start the next round, 0/1 |
| `[175, 176)` | 1 | `min(roundIndex, 10) / 10` |
| `[176, 179)` | 3 | My complete rows `/5`, columns `/5`, colours `/5` |
| `[179, 182)` | 3 | Theirs, same three |

- **[E1-53]** `ENCODED_SIZE` is 182. Offsets MUST be exported as named constants rather than
  written as literals at call sites.
- **[E1-54]** An empty pattern line contributes all zeros — no colour bit, zero fill.
- **[E1-55]** Bag and lid *counts* are public information in Azul and are encoded; the bag's
  *order* is not encoded and MUST NOT be.
- **[E1-56]** Every value MUST stay within `[0, 1]` for any reachable state, including the
  clamped floor and round fields.
- **[E1-57]** Changing this layout requires a new spec: it invalidates every trained model.

## Performance

The bot explores many thousands of positions per move, in a browser, on the same thread as the
UI unless a worker is used. Targets on a modern laptop, single-threaded, measured by the
benchmark suite:

- **[E1-58]** `legalActions` + `apply` SHOULD sustain at least 200 000 plies per second.
- **[E1-59]** `clone` SHOULD cost no more than ~1 µs, and MUST NOT allocate more than the state
  it copies.
- **[E1-60]** `legalActions` SHOULD build its result from precomputed tables rather than
  scanning all 180 actions. The reference implementation keeps a 5-bit "open rows" mask per
  colour per player, updated on placement and rebuilt at round end, and indexes a table of
  ready-made action lists.

These are budgets, not correctness gates: a regression here is a bug to file, not a failing
build.

## Verification

Specified in *0002 — Engine conformance vectors*. In summary: replay recorded ludometer games
ply by ply and compare full state at every step, plus handcrafted edge positions, plus property
tests for the invariants in [E1-40] to [E1-45] on every ply of randomly played games.

## Open questions

- **History.** The engine keeps only the current position. Does undo belong here as a move
  stack, in the UI as replay-from-start, or nowhere? *(Intent 0001 asks the same question; the
  answer decides whether `apply` returns an undo record.)*
- **Storage.** Plain `number[]` arrays follow the reference implementation and clone cheaply at
  this size. Would flat `Uint8Array` state measurably beat them under [E1-58], and is it worth
  the loss of readability?
- **Error style.** `apply` throws on an illegal action ([E1-14]). Should there also be a
  non-throwing `tryApply` for hot paths that would rather branch than catch?

## References

- Intent [0001 — Rules engine](../intent/0001-rules-engine.md)
- Spec [0002 — Engine conformance vectors](0002-engine-conformance-vectors.md)
- Reference implementation: [`ludometer/azul/engine.py`](https://github.com/RemiFabre/ludometer/blob/main/ludometer/azul/engine.py)
