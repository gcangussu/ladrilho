import type { JSX } from '@solidjs/web';
import type { AzulJSON } from 'engine';
import { CENTER, NUM_COLORS } from 'engine';
import { For, Repeat, Show, createMemo } from 'solid-js';
import { RovingGroup } from './RovingGroup.jsx';
import { Tile } from './Tile.jsx';

/** A `(source, colour)` group a player could pick: the first half of a turn [U3-22]. */
export interface Pick {
  source: number;
  color: number;
  count: number;
}

/**
 * One factory display, with the picks its pool offers [U3-81], and where those
 * picks sit in the roving order of the group that holds all five [U3-53].
 *
 * Module-private, both of it: `offset` is a fact about this file's rendering
 * and means nothing outside it, and a shape exported for no caller is a shape
 * someone else will grow a use for.
 */
interface FactoryDisplay {
  source: number;
  picks: Pick[];
  offset: number;
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

/**
 * The displays, in order, each carrying its own picks [U3-81].
 *
 * The list is every factory the engine dealt, not every factory still holding
 * something: a display that has been taken from keeps its place and its number
 * for the rest of the round, so the plate a player is looking at does not move
 * under them mid-round.
 *
 * `offset` is the running count of picks before this display, which is the
 * position its first control occupies in the group's single roving order.
 */
function factoryDisplays(factories: number[][]): FactoryDisplay[] {
  const displays: FactoryDisplay[] = [];
  let offset = 0;
  for (let source = 0; source < factories.length; source++) {
    const picks = picksIn(factories[source], source);
    displays.push({ source, picks, offset });
    offset += picks.length;
  }
  return displays;
}

/** How a display is named, in game terms rather than as an index [U3-54]. */
export function factoryName(source: number): string {
  return `Factory ${source + 1}`;
}

/** What a pick is, said in game terms rather than as an index [U3-54]. */
export function pickName(pick: Pick, names: string[]): string {
  const tiles = `${pick.count} ${names[pick.color]} tile${pick.count === 1 ? '' : 's'}`;
  return pick.source === CENTER
    ? `${tiles}, centre pool`
    : `${tiles}, ${factoryName(pick.source).toLowerCase()}`;
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

/**
 * The controls of one display, numbered from its group's roving order.
 *
 * `<For keyed={false}>` hands its callback an accessor in Solid v2, and it is
 * read here inside the JSX rather than in the callback body: a read outside a
 * tracking scope freezes the value at what it was when the control was first
 * built, and only a multi-ply test notices.
 */
function Picks(props: {
  picks: Pick[];
  names: string[];
  available: (source: number, color: number) => boolean;
  selected: (pick: Pick) => boolean;
  /** Where a pick sits in the roving order, given its position in this run. */
  tabIndex: (index: number) => number;
  onChoose: (pick: Pick) => void;
}): JSX.Element {
  return (
    <For each={props.picks} keyed={false}>
      {(pick, index) => (
        <PickButton
          pick={pick()}
          names={props.names}
          available={props.available(pick().source, pick().color)}
          selected={props.selected(pick())}
          tabIndex={props.tabIndex(index)}
          onChoose={props.onChoose}
        />
      )}
    </For>
  );
}

/**
 * One display: its name, and the controls for the tiles it holds [U3-81].
 *
 * A display that holds nothing keeps its plate and its name, so the ones still
 * holding tiles do not shuffle along into the gap it left mid-round.
 *
 * `group` makes the plate a group of its own under its name, which the factory
 * plates are: their enclosing group is all five displays at once, so without it
 * which display a control belongs to would be legible only from the control's
 * own name. The centre pool does not ask for one — its enclosing group is
 * already named for it, and a second group of the same name inside the first
 * says nothing and is one more thing to navigate past.
 */
function Display(props: {
  name: string;
  group?: boolean;
  picks: Pick[];
  names: string[];
  available: (source: number, color: number) => boolean;
  selected: (pick: Pick) => boolean;
  tabIndex: (index: number) => number;
  onChoose: (pick: Pick) => void;
}): JSX.Element {
  return (
    <div
      class="display"
      role={props.group ? 'group' : undefined}
      aria-label={props.group ? props.name : undefined}
    >
      <span class="display-name" aria-hidden="true">
        {props.name}
      </span>
      <div class="display-tiles">
        <Picks
          picks={props.picks}
          names={props.names}
          available={props.available}
          selected={props.selected}
          tabIndex={props.tabIndex}
          onChoose={props.onChoose}
        />
        <Show when={props.picks.length === 0}>
          <span class="display-empty">empty</span>
        </Show>
      </div>
    </div>
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

  // Memoised, because `count` is read once per control per update pass and
  // every read would otherwise walk all five pools again.
  const factories = createMemo(() => factoryDisplays(props.game.factories));
  const factoryPicks = (): number =>
    factories().reduce((total, factory) => total + factory.picks.length, 0);

  const centrePicks = (): Pick[] => picksIn(props.game.center, CENTER);

  return (
    <div class="displays">
      {/*
        One tab stop for all five displays [U3-53], divided into a plate apiece
        so that where a control sits says which display it came from, and not
        only the name a screen reader reads out [U3-81].
      */}
      <RovingGroup label="Factory displays" group="factories" count={factoryPicks()}>
        {(tabIndex) => (
          <For each={factories()} keyed={false}>
            {(factory) => (
              <Display
                name={factoryName(factory().source)}
                group
                picks={factory().picks}
                names={props.names}
                available={props.available}
                selected={isSelected}
                tabIndex={(index) => tabIndex(factory().offset + index)}
                onChoose={props.onChoose}
              />
            )}
          </For>
        )}
      </RovingGroup>

      <div class="centre">
        <RovingGroup label="Centre pool" group="centre" count={centrePicks().length}>
          {(tabIndex) => (
            <Display
              name="Centre"
              picks={centrePicks()}
              names={props.names}
              available={props.available}
              selected={isSelected}
              tabIndex={tabIndex}
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
