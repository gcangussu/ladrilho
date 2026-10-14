import type { JSX } from '@solidjs/web';
import type { Player } from 'engine';
import { Show } from 'solid-js';
import type { Estimate as EstimateModel } from '../game.js';
import type { Level } from '../opponent.js';
import { levelName } from './Seating.jsx';

/** What one board says of the estimate: its own side, and whose it is [W6-58]. */
export interface EstimateWords {
  value: string;
  by: string;
  /** The same side, as a board shown small has room for it [W6-58]. */
  short: string;
}

function points(n: number): string {
  return n === 1 ? '1 point' : `${n} points`;
}

/**
 * Seat `seat`'s side of the estimate, in words [W6-58]. Reads the seat's own
 * entry and negates nothing [W6-55]: the state module already put each seat's
 * side where that seat's board looks.
 */
export function estimateWords(
  estimate: EstimateModel,
  seat: Player,
  players: readonly [Level | null, Level | null],
): EstimateWords {
  let value: string;
  let short: string;
  if (estimate.kind === 'chance') {
    value = `${estimate.chance[seat]}% to win`;
    short = `${estimate.chance[seat]}%`;
  } else {
    const lead = estimate.lead[seat];
    if (estimate.decided !== null) {
      const won = estimate.decided === seat;
      const what = won ? 'A win' : 'A loss';
      value = lead === 0 ? `${what} on the tie-break` : `${what} by ${points(Math.abs(lead))}`;
      short = won ? 'win' : 'loss';
    } else {
      value = lead > 0 ? `Ahead by ${points(lead)}` : lead < 0 ? `Behind by ${points(-lead)}` : 'Even';
      short = lead > 0 ? `+${lead}` : lead < 0 ? `−${-lead}` : 'even';
    }
  }
  // Two computers: say which, or two masters read alike.
  const both = players[0] !== null && players[1] !== null;
  const name = levelName(estimate.level);
  const who = both ? `Player ${estimate.by + 1}’s ${name}` : name;
  return { value, by: `as ${who} saw it on its move`, short };
}

/**
 * The estimate beside a board's score [W6-58]. Plain text, read with the board
 * as the score is — no live region, no announcement [W6-59] — and no control,
 * so a shown board may carry it [0003 U3-91].
 *
 * Rendered from the deal on in any game with a computer, empty until the
 * computer has moved, so that its arriving never resizes the board [W6-60].
 *
 * A board shown small has room beside its score for the short form alone, so
 * there the full words stay its text for a screen reader and the short form
 * is drawn for the eye; the stylesheet chooses, the text is always both.
 */
export function EstimateLine(props: { words: EstimateWords | null }): JSX.Element {
  return (
    <p class="estimate">
      <Show when={props.words}>
        {(words) => (
          <>
            <span class="estimate-value">{words().value}</span>{' '}
            <span class="estimate-by">{words().by}</span>
            <span class="estimate-short" aria-hidden="true">
              {words().short}
            </span>
          </>
        )}
      </Show>
    </p>
  );
}
