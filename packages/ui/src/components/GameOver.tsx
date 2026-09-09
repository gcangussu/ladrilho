import type { JSX } from '@solidjs/web';
import type { AzulJSON, PlayerBonuses } from 'engine';
import { For, Show } from 'solid-js';

/**
 * The end of a game: both final scores, the winner, and how far each player got
 * with rows, columns and colours.
 *
 * The winner comes from `game.outcome` [U3-44] — `+1` is player 0, `-1` is
 * player 1, `0` is a draw, and a draw is reported as a draw and not as somebody
 * winning.
 *
 * The counts are shown, and what each count *earned* is shown beside it —
 * itemised from the record's bonus half and not computed here [U3-46].
 * Turning a count into points is [0001 E1-38], and doing it here would be a
 * second copy of the rules; the engine now hands both halves over
 * ([0007 S7-19], [0007 S7-22]), which is what closes the shortfall this
 * component used to record. The score delta still cannot stand in for it: on
 * the terminal ply `endRound` clamps at zero [0001 E1-28] before `finishGame`
 * adds unclamped bonuses, so the observed delta cannot be split back apart —
 * the split comes from the record or from nowhere.
 *
 * `bonuses` is null when there is no record to hand — a posed view, or a game
 * whose ending this client did not play — and the counts are then shown alone,
 * exactly as they were before.
 */
export function GameOver(props: {
  game: AzulJSON;
  names: string[];
  /** `scoring.bonuses`, by seat [U3-46], [0007 S7-19]. */
  bonuses: readonly [PlayerBonuses, PlayerBonuses] | null;
}): JSX.Element {
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
              <Show when={props.bonuses}>
                {(bonuses) => (
                  <span class="bonus-breakdown">
                    {' — bonuses: rows '}
                    {bonuses()[p].rowPoints}, columns {bonuses()[p].colPoints}, colours{' '}
                    {bonuses()[p].colorPoints}, total {bonuses()[p].total}
                  </span>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
