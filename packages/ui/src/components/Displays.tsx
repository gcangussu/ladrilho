import type { JSX } from '@solidjs/web';
import type { AzulJSON } from 'engine';
import { CENTER, NUM_COLORS } from 'engine';
import { Repeat, Show } from 'solid-js';
import { RovingGroup } from './RovingGroup.jsx';
import { Tile } from './Tile.jsx';

/** A `(source, colour)` group a player could pick: the first half of a turn [U3-22]. */
export interface Pick {
  source: number;
  color: number;
  count: number;
}

/**
 * The rendered universe of source controls [U3-79]: one control per
 * `(source, colour)` group whose pool actually holds a tile of that colour.
 *
 * Presence is decided by the pool; availability is decided by `legalActions`
 * and nothing else [U3-48]. Keeping those two apart is the whole point — a
 * display holding no red gets no red control, and a display holding red that
 * cannot lawfully be taken gets one that is present, focusable and inert
 * [U3-29].
 */
export function picksIn(pool: number[], source: number): Pick[] {
  const picks: Pick[] = [];
  for (let color = 0; color < NUM_COLORS; color++) {
    if (pool[color] > 0) picks.push({ source, color, count: pool[color] });
  }
  return picks;
}

/** What a pick is, said in game terms rather than as an index [U3-54]. */
export function pickName(pick: Pick, names: string[]): string {
  const tiles = `${pick.count} ${names[pick.color]} tile${pick.count === 1 ? '' : 's'}`;
  return pick.source === CENTER
    ? `${tiles}, centre pool`
    : `${tiles}, factory ${pick.source + 1}`;
}

function PickButton(props: {
  pick: Pick;
  names: string[];
  available: boolean;
  selected: boolean;
  tabIndex: number;
  onChoose: (pick: Pick) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-roving="true"
      class={['pick', { selected: props.selected }]}
      aria-label={pickName(props.pick, props.names)}
      aria-pressed={props.selected ? 'true' : 'false'}
      // Present, focusable and inert rather than `disabled`, which would take it
      // out of the tab order and out of assistive-technology navigation [U3-29].
      aria-disabled={props.available ? 'false' : 'true'}
      tabindex={props.tabIndex}
      onClick={() => props.onChoose(props.pick)}
    >
      <Repeat count={props.pick.count}>
        {() => <Tile color={props.pick.color} names={props.names} />}
      </Repeat>
    </button>
  );
}

/** The five factory displays and the centre pool, as two groups [U3-53]. */
export function Displays(props: {
  game: AzulJSON;
  names: string[];
  selection: Pick | null;
  available: (source: number, color: number) => boolean;
  onChoose: (pick: Pick) => void;
}): JSX.Element {
  const isSelected = (pick: Pick): boolean =>
    props.selection?.source === pick.source && props.selection?.color === pick.color;

  const factoryPicks = (): Pick[] =>
    props.game.factories.flatMap((pool, source) => picksIn(pool, source));

  return (
    <div class="displays">
      <RovingGroup label="Factory displays" group="factories" items={factoryPicks()}>
        {(pick, _index, tabIndex) => (
          <PickButton
            pick={pick()}
            names={props.names}
            available={props.available(pick().source, pick().color)}
            selected={isSelected(pick())}
            tabIndex={tabIndex()}
            onChoose={props.onChoose}
          />
        )}
      </RovingGroup>

      <div class="centre">
        <RovingGroup
          label="Centre pool"
          group="centre"
          items={picksIn(props.game.center, CENTER)}
        >
          {(pick, _index, tabIndex) => (
            <PickButton
              pick={pick()}
              names={props.names}
              available={props.available(pick().source, pick().color)}
              selected={isSelected(pick())}
              tabIndex={tabIndex()}
              onChoose={props.onChoose}
            />
          )}
        </RovingGroup>
        <Show when={props.game.markerInCenter}>
          <p class="centre-marker">
            <span class="tile marker">
              <span class="glyph" aria-hidden="true">
                1
              </span>
            </span>{' '}
            The first-player marker is in the centre.
          </p>
        </Show>
      </div>
    </div>
  );
}
