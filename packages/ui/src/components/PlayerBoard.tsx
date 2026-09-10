import type { JSX } from '@solidjs/web';
import type { AzulJSONPlayer } from 'engine';
import { Show } from 'solid-js';
import { Destinations } from './Destinations.jsx';
import { FloorLine } from './FloorLine.jsx';
import { PatternLines } from './PatternLines.jsx';
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
 * a terminal board is that same configuration, `destinations` being null for
 * both, which is why [U3-86] needs only two cases and not three.
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
}): JSX.Element {
  return (
    <section
      class={['player-board', { 'to-move': props.toMove }]}
      aria-label={props.name}
      aria-current={props.toMove ? 'true' : undefined}
    >
      <header class="player-header">
        <h2>{props.name}</h2>
        <p class="score">
          Score {props.player.score}
          <Show when={props.scoreDelta !== null}>
            <span class="score-delta"> ({signed(props.scoreDelta as number)} this round)</span>
          </Show>
        </p>
        <p class="turn-marker">{props.toMove ? 'To move' : 'Waiting'}</p>
      </header>

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
          names={props.names}
          label={`${props.name} wall`}
        />
      </div>

      <p class="completed">
        Completed: {props.player.completedRows} rows, {props.player.completedCols} columns,{' '}
        {props.player.completedColors} colours
      </p>
    </section>
  );
}
