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

/**
 * How much of a factory plate's two-column grid a loose control takes [U3-106]:
 * a group of two or three is a row of its own, four is the whole plate, and a
 * tile alone is one cell — unless it is the only one on its plate, beside a
 * group of three, when it takes the other row and sits in the middle of it.
 * Presentational only, like the floor's order [U3-38]: it decides where a
 * control is drawn, never which controls there are or what they are called.
 */
type Span = 'cell' | 'row' | 'plate';

function spanOf(pick: Pick, picks: Pick[]): Span {
  if (pick.count >= 4) return 'plate';
  if (pick.count >= 2) return 'row';
  return picks.filter((other) => other.count === 1).length === 1 ? 'row' : 'cell';
}

function PickButton(props: {
  pick: Pick;
  names: string[];
  available: boolean;
  selected: boolean;
  tabIndex: number;
  onChoose: (pick: Pick) => void;
  /** Every tile of the group, and no numeral — the wide table [U3-106]. */
  loose: boolean;
  span: Span;
}): JSX.Element {
  return (
    <button
      type="button"
      data-roving="true"
      data-span={props.loose ? props.span : undefined}
      class={['pick', { selected: props.selected, loose: props.loose }]}
      aria-label={pickName(props.pick, props.names)}
      aria-pressed={props.selected ? 'true' : 'false'}
      // Present, focusable and inert rather than `disabled`, which would take it
      // out of the tab order and out of assistive-technology navigation [U3-29].
      aria-disabled={props.available ? 'false' : 'true'}
      tabindex={props.tabIndex}
      onClick={() => props.onChoose(props.pick)}
    >
      <Show
        when={props.loose}
        fallback={
          <>
            {/* One tile and a count rather than a row of identical tiles
                [U3-97]: a pick is always every tile of its colour, so it is
                drawn as one stack. */}
            <Tile color={props.pick.color} names={props.names} />
            <Show when={props.pick.count > 1}>
              <span class="count" aria-hidden="true">
                {props.pick.count}
              </span>
            </Show>
          </>
        }
      >
        {/* Where there is room, every tile, side by side inside the one
            control, so pressing any of them takes them all [U3-106], [U3-107].
            The name above says the count in words [U3-108]. */}
        <Repeat count={props.pick.count}>
          {() => <Tile color={props.pick.color} names={props.names} />}
        </Repeat>
      </Show>
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
  loose: boolean;
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
          loose={props.loose}
          span={spanOf(pick(), props.picks)}
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
  /** What the plate shows on screen, where it is shorter than its name [U3-81]. */
  caption?: string;
  group?: boolean;
  picks: Pick[];
  names: string[];
  available: (source: number, color: number) => boolean;
  selected: (pick: Pick) => boolean;
  tabIndex: (index: number) => number;
  onChoose: (pick: Pick) => void;
  loose: boolean;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <div
      class="display"
      role={props.group ? 'group' : undefined}
      aria-label={props.group ? props.name : undefined}
    >
      <span class="display-name" aria-hidden="true">
        {props.caption ?? props.name}
      </span>
      <div class="display-tiles">
        <Picks
          picks={props.picks}
          names={props.names}
          available={props.available}
          selected={props.selected}
          tabIndex={props.tabIndex}
          onChoose={props.onChoose}
          loose={props.loose}
        />
        <Show when={props.picks.length === 0}>
          <span class="display-empty">empty</span>
        </Show>
        {props.children}
      </div>
    </div>
  );
}

/**
 * The five factory displays and the centre pool, as two groups [U3-53].
 *
 * `loose` is the arrangement's to say, not this component's to measure [U3-110]:
 * on the wide table every tile is drawn [U3-106], elsewhere one tile and a
 * count [U3-97]. Nothing else differs — the same controls, names and roving
 * order either way [U3-108].
 */
export function Displays(props: {
  game: AzulJSON;
  names: string[];
  selection: Pick | null;
  available: (source: number, color: number) => boolean;
  onChoose: (pick: Pick) => void;
  loose?: boolean;
}): JSX.Element {
  const loose = (): boolean => props.loose ?? false;
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
                caption={String(factory().source + 1)}
                group
                picks={factory().picks}
                names={props.names}
                available={props.available}
                selected={isSelected}
                tabIndex={(index) => tabIndex(factory().offset + index)}
                onChoose={props.onChoose}
                loose={loose()}
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
              loose={loose()}
            >
              <Show when={props.game.markerInCenter}>
                <span class="centre-marker">
                  <span class="tile marker">
                    <span class="glyph" aria-hidden="true">
                      1
                    </span>
                  </span>
                  <span class="sr-only">The first-player marker is in the centre.</span>
                </span>
              </Show>
            </Display>
          )}
        </RovingGroup>
      </div>
    </div>
  );
}
