import type { JSX } from '@solidjs/web';
import { type PlayerBonuses, type PlayerRound, type RoundScoring, wallColorAt } from 'engine';
import { For, Show } from 'solid-js';
import { Tile } from './Tile.jsx';

/**
 * How the last round was scored [U3-82], [U3-84].
 *
 * Every number here comes out of the engine's `RoundScoring` and out of nothing
 * else: no arithmetic on the record's fields, no diff of two positions, no
 * second source. That is [U3-84], and it is what closes the *scoring
 * legibility* shortfall 0003 recorded against intent 0002 — the points exist
 * only inside round resolution, so the interface can show what each tile earned
 * only because the engine now reports it ([0007 S7-1]).
 *
 * The tiles are not attributed a share of the floor penalty and never can be:
 * the floor is a per-colour count and a marker flag ([0001 E1-3]), so there is
 * no order to attribute by. It is shown as the ladder of rungs the round
 * charged, with the marker called out [U3-85], [0007 S7-16].
 *
 * `wallColorAt` is stateless and takes no state, so a component may call it
 * [U3-4] — which is why the record carries no colour ([0007 S7-21]).
 */

/** A signed number, so `+7` reads as a gain and `-3` as a loss [U3-43]. */
function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/**
 * One tile's line: where it landed, the runs through it, and what it earned.
 *
 * Said twice, deliberately: in full for assistive technology, and in one short
 * line on screen — the tile itself, its row, and its runs as "3 across · 2
 * down" — so five placements fit under a board without the card scrolling.
 * Both forms read the same three fields of the record and nothing else [U3-84].
 */
function PlacementLine(props: {
  placement: PlayerRound['placements'][number];
  names: string[];
}): JSX.Element {
  const p = (): PlayerRound['placements'][number] => props.placement;
  const color = (): number => wallColorAt(p().row, p().col);
  return (
    <li class="placement">
      <span class="sr-only">
        <span class="placement-where">
          Row {p().row + 1}, column {p().col + 1}, {props.names[color()]}
        </span>{' '}
        <span class="placement-runs">
          <Show
            when={p().h > 1 || p().v > 1}
            fallback={<span class="placement-alone">on its own</span>}
          >
            <Show when={p().h > 1}>
              <span class="run">row run of {p().h}</span>
            </Show>
            <Show when={p().h > 1 && p().v > 1}>{' and '}</Show>
            <Show when={p().v > 1}>
              <span class="run">column run of {p().v}</span>
            </Show>
          </Show>
        </span>
      </span>
      <span class="placement-terse" aria-hidden="true">
        <Tile color={color()} names={props.names} />
        <span class="placement-row">row {p().row + 1}</span>
        <span class="placement-shape">
          <Show when={p().h > 1 || p().v > 1} fallback="alone">
            <Show when={p().h > 1}>{p().h} across</Show>
            <Show when={p().h > 1 && p().v > 1}>{' · '}</Show>
            <Show when={p().v > 1}>{p().v} down</Show>
          </Show>
        </span>
      </span>
      <span class="placement-points">{signed(p().points)}</span>
    </li>
  );
}

/** The floor ladder: one rung per slot charged, the marker called out [U3-85]. */
function FloorCharge(props: { round: PlayerRound }): JSX.Element {
  const floor = (): PlayerRound['floor'] => props.round.floor;
  return (
    <div class="scoring-floor">
      <p class="scoring-floor-line sr-only">
        Floor line: {floor().occupied} slots, {floor().rungs.length} of them charged
        <Show when={floor().markerHeld}>{', the first-player marker among them'}</Show>
        {/* Both numbers are the record's own. Their difference is not shown,
            because subtracting them here would be [0001 E1-27] restated in the
            interface — the record carries the pair precisely so it need not be
            [0007 S7-16]. */}
        <Show when={floor().rungs.length < floor().occupied}>
          {' — the rest are past the last slot and cost nothing'}
        </Show>
      </p>
      <div class="scoring-floor-ladder">
        <span class="scoring-floor-label" aria-hidden="true">
          Floor
        </span>
        <ul class="rungs" aria-label="floor penalty by slot">
          <For each={[...floor().rungs]} keyed={false}>
            {(rung, slot) => (
              <li class="rung">
                <span class="sr-only">Slot {slot + 1}: </span>
                {rung()}
              </li>
            )}
          </For>
        </ul>
        <Show when={floor().rungs.length === 0}>
          <span class="scoring-floor-none" aria-hidden="true">
            nothing charged
          </span>
        </Show>
        <Show when={floor().markerHeld}>
          <span class="tile marker" aria-hidden="true">
            <span class="glyph">1</span>
          </span>
        </Show>
      </div>
    </div>
  );
}

/** One player's round: what the wall earned, what the floor cost, and the total. */
function PlayerRoundSummary(props: {
  name: string;
  round: number;
  record: PlayerRound;
  bonuses: PlayerBonuses | null;
  names: string[];
}): JSX.Element {
  return (
    <section class="scoring-player" aria-label={`${props.name} scoring`}>
      <h3>
        {props.name} <span class="scoring-round">round {props.round + 1}</span>
      </h3>
      <Show
        when={props.record.placements.length > 0}
        fallback={<p class="no-placements">No pattern line was complete, so nothing was placed.</p>}
      >
        <ul class="placements" aria-label={`${props.name} tiles placed`}>
          <For each={[...props.record.placements]} keyed={false}>
            {(placement) => <PlacementLine placement={placement()} names={props.names} />}
          </For>
        </ul>
      </Show>
      <FloorCharge round={props.record} />

      {/* The round's three totals on one line, each the record's own figure:
          what the wall earned, what the floor cost, and the score it came to. */}
      <div class="scoring-totals">
        <p class="scoring-tiling">Tiles placed {signed(props.record.tiling)}</p>
        <p class="scoring-penalty">Floor penalty {props.record.floor.penalty}</p>
        <p class="scoring-round-total">
          Score {props.record.scoreBefore} to {props.record.scoreAfterRound}
          <Show when={props.record.forgiven > 0}>
            {' '}
            <span title="A round never carries a debt forward">
              ({props.record.forgiven} forgiven
              <span class="sr-only"> — a round never carries a debt forward</span>)
            </span>
          </Show>
        </p>
      </div>

      <Show when={props.bonuses}>
        {(bonus) => (
          <div class="scoring-bonuses">
            <h4>End-of-game bonuses</h4>
            <ul class="bonus-lines">
              <li>
                {bonus().rows} completed rows: {signed(bonus().rowPoints)}
              </li>
              <li>
                {bonus().cols} completed columns: {signed(bonus().colPoints)}
              </li>
              <li>
                {bonus().colors} completed colours: {signed(bonus().colorPoints)}
              </li>
            </ul>
            <p class="bonus-total">
              Bonuses {signed(bonus().total)}, final score {bonus().scoreBefore} to{' '}
              {bonus().scoreAfter}
            </p>
          </div>
        )}
      </Show>
    </section>
  );
}

/**
 * The panel itself. Sticky: it shows the most recent round for as long as that
 * is the most recent round, and is replaced only by a later one [U3-82].
 */
export function Scoring(props: {
  scoring: RoundScoring;
  names: string[];
  playerNames: string[];
  /** Present while the workings are shown as a sheet [U3-102]. */
  onClose?: (() => void) | undefined;
}): JSX.Element {
  return (
    <section class="scoring" aria-label="How the last round scored">
      <h2>Round {props.scoring.round + 1} scoring</h2>
      <Show when={props.onClose}>
        {(close) => (
          <button type="button" class="tool close" onClick={() => close()()}>
            Close
          </button>
        )}
      </Show>
      <div class="scoring-players">
        <For each={[...props.scoring.players]} keyed={false}>
          {(round, p) => (
            <PlayerRoundSummary
              name={props.playerNames[p]}
              round={props.scoring.round}
              record={round()}
              bonuses={props.scoring.bonuses === null ? null : props.scoring.bonuses[p]}
              names={props.names}
            />
          )}
        </For>
      </div>
    </section>
  );
}
