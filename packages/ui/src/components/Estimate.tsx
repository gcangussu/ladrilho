import type { JSX } from '@solidjs/web';
import type { Player } from 'engine';
import { Show } from 'solid-js';
import type { Estimate as EstimateModel } from '../game.js';
import type { Level } from '../opponent.js';
import { levelName } from './Seating.jsx';

/** What one board says of the estimate: its own side, and whose it is [W6-58]. */
export interface EstimateWords {
  /** The seat's side in full: `62% to win`, `Behind by 4 points`. */
  value: string;
  /** Whose and when, in full: `as master saw it on its move`. */
  by: string;
  /** The seat's side, short: `62%`, `−4 pt`, `even`, `win`, `loss`. */
  short: string;
  /** Whose, short: `master`, or `P2 master` when both seats are computers. */
  name: string;
}

/**
 * A signed whole number: `+7`, `−3` with U+2212, `0`. One form for every
 * signed number a component writes — a round's score change [0003 U3-43], a
 * bonus total in the record, a lead axis's labels.
 */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}

/**
 * Whose estimate, by [W6-58]'s rule: the level's word, prefixed `Player N’s`
 * when both seats are computers, so two `master`s are told apart.
 */
export function estimatorName(
  by: Player,
  level: Level,
  players: readonly [Level | null, Level | null],
): string {
  const both = players[0] !== null && players[1] !== null;
  return both ? `Player ${by + 1}’s ${levelName(level)}` : levelName(level);
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
      // `pt`, so a lead is never read as the round's score change, which the
      // header shows as a bare signed number [0003 U3-43].
      short = lead > 0 ? `+${lead} pt` : lead < 0 ? `−${-lead} pt` : 'even';
    }
  }
  // Two computers: say which, or two masters read alike.
  const both = players[0] !== null && players[1] !== null;
  const level = levelName(estimate.level);
  return {
    value,
    by: `as ${estimatorName(estimate.by, estimate.level, players)} saw it on its move`,
    short,
    name: both ? `P${estimate.by + 1} ${level}` : level,
  };
}

/**
 * The estimate beside a board's score [W6-58]. Plain text, read with the board
 * as the score is — no live region, no announcement [W6-59] — and no control,
 * so a shown board may carry it [0003 U3-91].
 *
 * Its text is always the full sentence. Where the row has no room for it — a
 * docked board — the stylesheet draws a compact form instead, hidden from
 * assistive technology, and keeps the sentence out of sight but read. A board
 * shown small draws nothing of it: its row is its player's name.
 *
 * Rendered from the deal on in any game with a computer, empty until the
 * computer has moved, so that its arriving never resizes a wide or docked
 * board [W6-60].
 */
export function EstimateLine(props: { words: EstimateWords | null }): JSX.Element {
  return (
    <p class="estimate">
      <span class="estimate-full">
        <Show when={props.words}>
          {(words) => (
            <>
              <span class="estimate-value">{words().value}</span>{' '}
              <span class="estimate-by">{words().by}</span>
            </>
          )}
        </Show>
      </span>
      <span class="estimate-compact" aria-hidden="true">
        <Show when={props.words}>
          {(words) => (
            <>
              <span class="estimate-short">{words().short}</span>
              <span class="estimate-name">{words().name}</span>
            </>
          )}
        </Show>
      </span>
    </p>
  );
}
