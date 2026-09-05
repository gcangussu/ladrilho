import type { JSX } from '@solidjs/web';
import type { AzulJSON } from 'engine';
import { For } from 'solid-js';

/**
 * The end of a game: both final scores, the winner, and how far each player got
 * with rows, columns and colours.
 *
 * The winner comes from `game.outcome` [U3-44] — `+1` is player 0, `-1` is
 * player 1, `0` is a draw, and a draw is reported as a draw and not as somebody
 * winning.
 *
 * The counts are shown and the bonus arithmetic is not [U3-46]. Turning a count
 * into points is [0001 E1-38], and doing it here would be a second copy of the
 * rules; the shortfall against intent 0002 that this leaves is recorded in the
 * spec's *Two places this knowingly falls short* and handed to intent 0004. The
 * score delta cannot stand in for it either: on the terminal ply `endRound`
 * clamps at zero [0001 E1-28] before `finishGame` adds unclamped bonuses, so
 * the observed delta cannot be split back apart.
 */
export function GameOver(props: { game: AzulJSON; names: string[] }): JSX.Element {
  const verdict = (): string => {
    if (props.game.outcome === 0) return 'A draw.';
    return props.game.outcome === 1 ? 'Player 1 wins.' : 'Player 2 wins.';
  };
  return (
    <section class="game-over" aria-label="Final result">
      <h2>Game over</h2>
      <p class="verdict">{verdict()}</p>
      <p class="ending">
        {props.game.exhausted
          ? 'The game ended because no tiles could be dealt.'
          : 'The game ended on a completed row.'}
      </p>
      <ul class="finals">
        <For each={props.game.players} keyed={false}>
          {(player, p) => (
            <li>
              Player {p + 1}: {player().score} points, {player().completedRows} completed rows,{' '}
              {player().completedCols} completed columns, {player().completedColors} completed
              colours
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
