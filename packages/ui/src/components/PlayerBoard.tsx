import type { JSX } from '@solidjs/web';
import type { AzulJSONPlayer, Placement } from 'engine';
import { CENTER, FLOOR, NUM_COLORS, NUM_ROWS, decodeAction } from 'engine';
import { Repeat, Show } from 'solid-js';
import { Destinations } from './Destinations.jsx';
import { type Pick, factoryName } from './Displays.jsx';
import { FloorLine } from './FloorLine.jsx';
import { PatternLines } from './PatternLines.jsx';
import { Tile } from './Tile.jsx';
import { Wall } from './Wall.jsx';

/** How a destination control answers and what it does when chosen [U3-24], [U3-25]. */
export interface DestinationApi {
  available: (dest: number) => boolean;
  onChoose: (dest: number) => void;
}

/** A signed delta, so `+7` reads as a gain and `-3` as a loss [U3-43]. */
function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** Where a pick came from, in the words a board uses for it. */
function sourceName(source: number): string {
  return source === CENTER ? 'the centre' : factoryName(source).toLowerCase();
}

/**
 * A seat's last move, in game terms [U3-101]: the colour, where it came from,
 * and where it went. Decoded with the engine's `decodeAction` [U3-51]; the
 * count is not part of an action, so it is not claimed.
 */
export function lastMoveText(action: number, names: string[]): string {
  const [source, color, dest] = decodeAction(action);
  const where = dest === FLOOR ? 'the floor line' : `pattern line ${dest + 1}`;
  return `${names[color]} from ${sourceName(source)} to ${where}`;
}

/**
 * The strip under a board's header [U3-99]: what this seat is holding, or what
 * it did last, or — on the board of a person to move — what a turn asks for.
 *
 * Always there and always one height, so a selection changes what it says and
 * never how much room the board takes. Put back is the selection's own way out,
 * beside the selection, as well as Escape [U3-26]; it is not a move control
 * ([U3-79]) and it never touches the game [U3-27].
 */
function Hand(props: {
  holding: Pick | null;
  onPutBack: () => void;
  lastMove: number | null;
  toMove: boolean;
  names: string[];
}): JSX.Element {
  return (
    <div class={['hand', { holding: props.holding !== null }]}>
      <Show
        when={props.holding}
        fallback={
          <Show
            when={props.lastMove !== null}
            fallback={
              <p class="hand-text">
                {props.toMove
                  ? 'Take one colour from a factory or the centre.'
                  : 'No move yet this game.'}
              </p>
            }
          >
            <p class="hand-text">
              <span class="hand-label">Last move</span>{' '}
              <Tile color={decodeAction(props.lastMove as number)[1]} names={props.names} />{' '}
              <span>{lastMoveText(props.lastMove as number, props.names)}</span>
            </p>
          </Show>
        }
      >
        {(picked) => (
          <>
            <p class="hand-text">
              <span class="hand-label">Holding</span>{' '}
              <span class="hand-tiles">
                <Repeat count={picked().count}>
                  {() => <Tile color={picked().color} names={props.names} />}
                </Repeat>
              </span>{' '}
              <span>from {sourceName(picked().source)}</span>
            </p>
            <button type="button" class="put-back" onClick={() => props.onPutBack()}>
              Put back <kbd>Esc</kbd>
            </button>
          </>
        )}
      </Show>
    </div>
  );
}

/** Five pips, `done` of them filled: a count the engine gave, drawn [U3-35]. */
function Pips(props: { done: number; of: number }): JSX.Element {
  return (
    <span class="pips" aria-hidden="true">
      <Repeat count={props.of}>{(i) => <i class={{ on: i < props.done }} />}</Repeat>
    </span>
  );
}

/**
 * One player's board: score, wall, pattern lines, floor line, and how far they
 * are from finishing a row, a column or a colour [U3-35] — all four numbers
 * read off the engine's own view, none of them counted here.
 *
 * Whose turn it is is said in words and marked with `aria-current`, never by
 * colour alone [U3-33].
 *
 * The six destination controls of [U3-79] live on the board of the player to
 * move, and only there: `dest` is a destination on the mover's own board
 * [0001 E1-6], so a second set under the opponent would be six controls that
 * can never be legal. The waiting player's lines are shown, not offered — and
 * so are a terminal board's, which is why [U3-86] has two configurations and
 * never three: the shown one is every board that is not the mover's.
 *
 * What must not differ between the two is the room they take: the board grew
 * when the turn arrived and shrank when it left, and every ply moved the page
 * under a player who was still reading it. `PatternRow` and `FloorRow` are one
 * component each for that reason, and [U3-91] is the tripwire — the rows take a
 * nullable control, so a shown board that starts emitting buttons is one edit
 * away and would break [U3-61] and [U3-57] rather than anything visible here.
 */
export function PlayerBoard(props: {
  name: string;
  player: AzulJSONPlayer;
  /** From the view model's `floorOccupied[p]` [U3-4]. */
  floorOccupied: number;
  /** `transition.newlyPlaced[p]`, or `null` on a ply that was not a transition. */
  placed: number[] | null;
  /** `transition.scoreDelta[p]`, or `null` [U3-43]. */
  scoreDelta: number | null;
  toMove: boolean;
  names: string[];
  /** Non-null on the board of the player to move. */
  destinations: DestinationApi | null;
  /** Who sits here, in words: a person, or which computer [W6-1]. */
  seatLabel?: string;
  /** The seat's number, drawn as its badge. */
  seat?: number;
  /** A search is in flight for this seat [W6-19]. */
  thinking?: boolean;
  /** The selection, on the board it is about to be placed on [U3-99]. */
  holding?: Pick | null;
  onPutBack?: () => void;
  /** This seat's last action this game [U3-101]. */
  lastMove?: number | null;
  /** The last round's placements for this seat, from the record [U3-102]. */
  placements?: readonly Placement[] | null;
  /** How the arrangement shows this board, where it shows one small [U3-103]. */
  role?: 'dock' | 'mini' | null;
}): JSX.Element {
  return (
    <section
      class={[
        'player-board',
        `seat-${props.seat ?? 0}`,
        {
          'to-move': props.toMove,
          offered: props.destinations !== null,
          dock: props.role === 'dock',
          mini: props.role === 'mini',
        },
      ]}
      aria-label={props.name}
      aria-current={props.toMove ? 'true' : undefined}
    >
      <header class="player-header">
        <span class="avatar" aria-hidden="true">
          {(props.seat ?? 0) + 1}
        </span>
        <div class="who">
          <h2>{props.name}</h2>
          <Show when={props.seatLabel}>
            <p class="seat-kind">{props.seatLabel}</p>
          </Show>
        </div>
        <p class="turn-marker">
          {props.toMove ? 'To move' : 'Waiting'}
          <Show when={props.thinking}>
            <span class="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </Show>
        </p>
        <p class="score">
          <span class="score-label">Score</span> <span class="score-num">{props.player.score}</span>
          <Show when={props.scoreDelta !== null}>
            <span class="score-delta"> ({signed(props.scoreDelta as number)} this round)</span>
          </Show>
        </p>
      </header>

      <Hand
        holding={props.holding ?? null}
        onPutBack={() => props.onPutBack?.()}
        lastMove={props.lastMove ?? null}
        toMove={props.toMove}
        names={props.names}
      />

      {/* The lines before the wall, in the document as on the screen [U3-90]:
          side by side where there is room they are the left column [U3-88], and
          the six controls of [U3-79] are in them. */}
      <div class="board-play">
        <Show
          when={props.destinations}
          fallback={
            <div class="lines">
              <PatternLines
                lines={props.player.patternLines}
                names={props.names}
                label={`${props.name} pattern lines`}
              />
              <FloorLine
                floor={props.player.floor}
                marker={props.player.floorMarker}
                occupied={props.floorOccupied}
                penalty={props.player.floorPenalty}
                names={props.names}
                label={`${props.name} floor line`}
              />
            </div>
          }
        >
          {(api) => (
            <Destinations
              player={props.player}
              floorOccupied={props.floorOccupied}
              names={props.names}
              label={`${props.name} pattern lines and floor`}
              available={(dest) => api().available(dest)}
              onChoose={(dest) => api().onChoose(dest)}
            />
          )}
        </Show>

        <Wall
          wall={props.player.wall}
          placed={props.placed}
          placements={props.placements ?? null}
          names={props.names}
          label={`${props.name} wall`}
        />
      </div>

      <div class="completed">
        <p class="sr-only">
          Completed: {props.player.completedRows} rows, {props.player.completedCols} columns,{' '}
          {props.player.completedColors} colours
        </p>
        <span class="progress">
          Rows <Pips done={props.player.completedRows} of={NUM_ROWS} />
        </span>
        <span class="progress">
          Columns <Pips done={props.player.completedCols} of={NUM_COLORS} />
        </span>
        <span class="progress">
          Colours <Pips done={props.player.completedColors} of={NUM_COLORS} />
        </span>
      </div>
    </section>
  );
}
