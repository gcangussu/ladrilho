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
  /** [0006 W6-52]: the same seats and a fresh deal, at once. */
  onRematch?: () => void;
  /** [0006 W6-52], [U3-104]: the same seats and this deal, at once. */
  onReplay?: () => void;
  /** [0006 W6-52]: the new-game sheet. */
  onChangeSeats?: (event: MouseEvent) => void;
}): JSX.Element {
  const verdict = (): string => {
    if (props.game.outcome === 0) return 'A draw.';
    return props.game.outcome === 1 ? 'Player 1 wins.' : 'Player 2 wins.';
  };
  /**
   * The three counts, from the record where there is one.
   *
   * One fact, one source. Taking the counts from `AzulJSON` while taking the
   * points beside them from the record would put two answers to the same
   * question on one line, and they would silently disagree the moment anything
   * published a record from a different position than the one on screen.
   */
  const counts = (p: number): { rows: number; cols: number; colors: number } => {
    const bonuses = props.bonuses;
    const player = props.game.players[p];
    return bonuses === null
      ? { rows: player.completedRows, cols: player.completedCols, colors: player.completedColors }
      : { rows: bonuses[p].rows, cols: bonuses[p].cols, colors: bonuses[p].colors };
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
              Player {p + 1}: {player().score} points, {counts(p).rows} completed rows,{' '}
              {counts(p).cols} completed columns, {counts(p).colors} completed colours
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
      <Show when={props.onRematch}>
        <div class="game-over-actions">
          <button type="button" class="deal" onClick={() => props.onRematch?.()}>
            Rematch
          </button>
          <button type="button" class="tool outline" onClick={() => props.onReplay?.()}>
            Replay this deal
          </button>
          <button type="button" class="tool outline" onClick={(event) => props.onChangeSeats?.(event)}>
            Change seats
          </button>
        </div>
      </Show>
    </section>
  );
}
