import type { JSX } from '@solidjs/web';
import type { RoundScoring } from 'engine';
import { For, Show } from 'solid-js';
import type { Estimate, PlyRecord } from '../game.js';
import type { Choice, ExpertChoice, Level, MasterChoice, Seating } from '../opponent.js';
import { estimateWords } from './Estimate.jsx';
import { EstimateGraph } from './Graph.jsx';
import { lastMoveText } from './PlayerBoard.jsx';
import { levelName } from './Seating.jsx';

/**
 * The game's record, for intent 0014: [0006 W6-67] onward.
 *
 * Everything here is read from `history`, which the state module publishes,
 * and nothing is computed anew [W6-69]: a row is a record's own fields in
 * words. This is the one place the rest of a reply's report reaches the screen
 * [W6-24], [W6-80] — and it reaches it through `history`, never `lastChoice`
 * [W6-25].
 */

/** A count, grouped by thousands in English: `10,000` [W6-76]. */
function count(n: number): string {
  return n.toLocaleString('en');
}

/**
 * A tier's raw value, from the mover's side [W6-76]: whole as itself, any
 * other to one decimal, signed, and no sign on a value shown as zero.
 */
export function valueText(value: number): string {
  const whole = Number.isInteger(value);
  const shown = Math.abs(value).toLocaleString('en', {
    minimumFractionDigits: whole ? 0 : 1,
    maximumFractionDigits: whole ? 0 : 1,
  });
  if (/^0(\.0)?$/.test(shown)) return shown;
  return `${value > 0 ? '+' : '−'}${shown}`;
}

/** What a reply reported besides its action, by the level that made it [W6-76]. */
export function searchWords(choice: Choice | ExpertChoice | MasterChoice, level: Level): string {
  if (level === 'master') return `${count((choice as MasterChoice).simulations)} simulations`;
  if (level === 'expert') {
    const c = choice as ExpertChoice;
    return `${count(c.simulations)} simulations, ${count(c.rootVisits)} root visits`;
  }
  const c = choice as Choice;
  let words = `value ${valueText(c.value)} points, depth ${count(c.depth)}, ${count(c.nodes)} nodes`;
  if (c.complete) words += ', complete';
  if (c.curtailed) words += ', curtailed';
  return words;
}

/**
 * Both seats' sides, Player 1's first [W6-75]: a chance by its short value, a
 * lead in the board's full words. The boards' own function, so the two cannot
 * word one estimate two ways.
 */
export function estimateCell(estimate: Estimate, players: readonly [Level | null, Level | null]): string {
  const sides = ([0, 1] as const).map((seat) => {
    const words = estimateWords(estimate, seat, players);
    return estimate.kind === 'chance' ? words.short : words.value;
  });
  return sides.join(' / ');
}

/** `+12`, `−3`, `0`: a bonus total as the record states it. */
function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}

/**
 * The round row [W6-78]: each seat's figures from its own entry of the record,
 * and nothing added, subtracted or compared [0003 U3-84].
 */
export function roundWords(scoring: RoundScoring): string {
  const parts = ([0, 1] as const).map((seat) => {
    const player = scoring.players[seat];
    let part = `Player ${seat + 1}: ${player.scoreBefore} to ${player.scoreAfterRound}`;
    const bonus = scoring.bonuses?.[seat];
    if (bonus) part += `, bonuses ${signed(bonus.total)}, final ${bonus.scoreAfter}`;
    return part;
  });
  return `Round ${scoring.round + 1} scored: ${parts.join('; ')}`;
}

/** Who held a seat: `Player 1 (Person)`, `Player 2 (master)` [W6-74]. */
function who(record: PlyRecord): string {
  return `Player ${record.seat + 1} (${record.level === null ? 'Person' : levelName(record.level)})`;
}

const HEADERS = ['Ply', 'Round', 'Player', 'Move', 'Estimate', 'Search'] as const;

/**
 * The dialog [W6-71]: modelled on the new-game sheet, rendered only while
 * open, the graph above the log. No live region and no status: a row added
 * while it is open is read when it is reached [W6-79].
 */
export function RecordSheet(props: {
  history: readonly PlyRecord[];
  seating: Seating;
  names: string[];
  onClose: () => void;
}): JSX.Element {
  return (
    <div
      class="sheet-scrim"
      // A press on the dimmed page outside it closes it [W6-71].
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section class="sheet record" role="dialog" aria-modal="true" aria-labelledby="record-title">
        <header class="sheet-head">
          <h2 id="record-title">Game record</h2>
          <button
            type="button"
            class="tool close"
            ref={(el: HTMLButtonElement) => queueMicrotask(() => el.focus())}
            onClick={() => props.onClose()}
          >
            Close
          </button>
        </header>

        {/* The heading row stays put; only this scrolls, either way, so Close
            is in view at every scroll position [W6-71]. Focusable, so the
            keyboard can scroll it too. */}
        <div class="record-body" tabindex="0" role="region" aria-label="Record contents">
          <EstimateGraph history={props.history} seating={props.seating} />

          <Show when={props.history.length > 0} fallback={<p class="record-empty">No moves yet</p>}>
            <table class="record-log">
              <caption>Every move of this game</caption>
              <thead>
                <tr>
                  <For each={HEADERS}>{(header) => <th scope="col">{header}</th>}</For>
                </tr>
              </thead>
              <tbody>
                <For each={props.history}>
                  {(record) => (
                    <>
                      <tr>
                        <th scope="row">{record.ply}</th>
                        <td>{record.round + 1}</td>
                        <td>{who(record)}</td>
                        <td>{lastMoveText(record.action, props.names)}</td>
                        <td>{record.estimate === null ? '' : estimateCell(record.estimate, props.seating.players)}</td>
                        <td>
                          {record.choice === null || record.level === null
                            ? ''
                            : searchWords(record.choice, record.level)}
                        </td>
                      </tr>
                      <Show when={record.scoring}>
                        {(scoring) => (
                          <tr class="record-round">
                            <td colspan={HEADERS.length}>{roundWords(scoring())}</td>
                          </tr>
                        )}
                      </Show>
                    </>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </section>
    </div>
  );
}
