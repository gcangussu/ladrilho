/**
 * The table on a wide screen [U3-105] through [U3-110]: what is in the
 * document, per arrangement. Where it lands is the browser lane's ([U3-73]).
 *
 * jsdom measures nothing, so the interface it mounts is always `wide` [U3-95].
 * The displays and the status bar therefore take the arrangement from their
 * caller [U3-110], and the other arrangement is posed by rendering them
 * directly with it. Elements are located by accessible role and visible text
 * [U3-68]; the one exception is `.count` and `.tile`, which are what is drawn
 * inside a control whose accessible name hides its content.
 */

import { render, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { CENTER, decodeAction } from 'engine';
import type { AzulJSON } from 'engine';
import { flush } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Displays, pickName, picksIn, type Pick } from '../src/components/Displays.jsx';
import { Status } from '../src/components/Status.jsx';
import { openingGame } from './fixtures.js';

const CAPTION = 'Tiles in the bag and in the lid, by colour';

/** A game whose centre holds something, so the centre's controls are drawn too. */
function withCentre(): AzulJSON {
  const game = openingGame(42);
  return { ...game, center: [3, 0, 1, 2, 0], markerInCenter: true };
}

function displays(game: AzulJSON, loose: boolean, selection: Pick | null = null) {
  return render(() => (
    <Displays
      game={game}
      names={game.colorNames}
      selection={selection}
      available={() => true}
      onChoose={() => {}}
      loose={loose}
    />
  ));
}

/** Every pick the table offers, factories then centre, in the order of [U3-79]. */
function allPicks(game: AzulJSON): Pick[] {
  return [
    ...game.factories.flatMap((pool, source) => picksIn(pool, source)),
    ...picksIn(game.center, CENTER),
  ];
}

/** What a screen reader and a keyboard meet, group by group, in roving order. */
function controls(root: HTMLElement): string[] {
  return ['Factory displays', 'Centre pool'].flatMap((group) =>
    within(within(root).getByRole('group', { name: group }))
      .getAllByRole('button')
      .map((b) => `${group}: ${b.getAttribute('aria-label')} tab=${b.tabIndex} ` +
        `disabled=${b.getAttribute('aria-disabled')} pressed=${b.getAttribute('aria-pressed')}`),
  );
}

describe('every tile drawn on the wide table [U3-106]', () => {
  // Seen red, on a copy, with the loose tiles split across the control's edge
  // — the first inside the button, the rest rendered after it: every group of
  // two or more held one tile.
  it('[U3-106] [U3-110] draws each group as that many tiles inside its one control, and no numeral', () => {
    const game = withCentre();
    const screen = displays(game, true);
    const names = game.colorNames;
    let multiples = 0;
    for (const pick of allPicks(game)) {
      const control = screen.getByRole('button', { name: pickName(pick, names) });
      const tiles = control.querySelectorAll('.tile');
      expect(tiles, pickName(pick, names)).toHaveLength(pick.count);
      // Each of them this group's colour, said in words as well [U3-36].
      expect(within(control).getAllByText(names[pick.color])).toHaveLength(pick.count);
      expect(control.querySelector('.count'), `${pickName(pick, names)} carries a numeral`).toBeNull();
      expect(control.textContent).not.toMatch(/\d/);
      if (pick.count > 1) multiples++;
    }
    expect(multiples, 'the table held no group of more than one tile').toBeGreaterThan(1);
    // No tile of a pick is drawn anywhere but inside its control: the tiles in
    // the two groups are exactly the tiles the picks hold, and the marker.
    const drawn = ['Factory displays', 'Centre pool'].map(
      (group) => screen.getByRole('group', { name: group }).querySelectorAll('.tile').length,
    );
    const held = (source: (p: Pick) => boolean): number =>
      allPicks(game).filter(source).reduce((n, p) => n + p.count, 0);
    expect(drawn).toEqual([held((p) => p.source !== CENTER), held((p) => p.source === CENTER) + 1]);
  });

  // Seen red, on a copy, with `Displays` ignoring `loose` and drawing loosely
  // always: every group of two or more held that many tiles and no numeral.
  it('[U3-97] [U3-110] [U3-108] draws one tile and a numeral elsewhere, as it always did', () => {
    const game = withCentre();
    const screen = displays(game, false);
    for (const pick of allPicks(game)) {
      const control = screen.getByRole('button', { name: pickName(pick, game.colorNames) });
      expect(control.querySelectorAll('.tile')).toHaveLength(1);
      expect(control.querySelectorAll('.count')).toHaveLength(pick.count > 1 ? 1 : 0);
      // Nothing of the wide drawing leaks into the other arrangements' markup.
      expect(control).not.toHaveClass('loose');
      expect(control).not.toHaveAttribute('data-span');
    }
  });

  it('[U3-108] [U3-53] [U3-54] offers the same controls, names, availability and roving order in both', () => {
    const game = withCentre();
    const available = (source: number, color: number): boolean => (source + color) % 2 === 0;
    const posed = (loose: boolean): string[] => {
      const { container, unmount } = render(() => (
        <Displays
          game={game}
          names={game.colorNames}
          selection={null}
          available={available}
          onChoose={() => {}}
          loose={loose}
        />
      ));
      const out = controls(container);
      unmount();
      return out;
    };
    const wide = posed(true);
    expect(wide).toHaveLength(allPicks(game).length);
    expect(wide).toEqual(posed(false));
  });

  it('[U3-106] lays a group of three as a row and four as the whole plate, and a lone tile beside three across', () => {
    const game = openingGame(42);
    const posed: AzulJSON = {
      ...game,
      factories: [
        [4, 0, 0, 0, 0],
        [3, 1, 0, 0, 0],
        [2, 2, 0, 0, 0],
        [1, 2, 1, 0, 0],
        [1, 1, 1, 1, 0],
      ],
    };
    const screen = displays(posed, true);
    const spans = posed.factories.map((pool, source) =>
      picksIn(pool, source).map(
        (pick) => screen.getByRole('button', { name: pickName(pick, posed.colorNames) }).dataset['span'],
      ),
    );
    expect(spans).toEqual([
      ['plate'],
      ['row', 'row'],
      ['row', 'row'],
      ['cell', 'row', 'cell'],
      ['cell', 'cell', 'cell', 'cell'],
    ]);
  });
});

describe('a group selected as one [U3-107]', () => {
  let user: ReturnType<typeof userEvent.setup>;
  beforeEach(() => {
    user = userEvent.setup();
  });

  // Through the measured interface, which jsdom always measures `wide`.
  async function mount() {
    history.replaceState({}, '', '/?seed=42&seating=human-human');
    vi.resetModules();
    const { App } = await import('../src/components/App.jsx');
    const game = await import('../src/game.js');
    return { screen: render(() => <App />), game };
  }

  it('[U3-107] [U3-26] selects the whole group from any of its tiles, marks every tile, and clears from another', async () => {
    const { screen, game } = await mount();
    const now = game.view().game;
    const action = now.legalActions.find((a) => {
      const [source, color] = decodeAction(a);
      return source !== CENTER && now.factories[source][color] > 1;
    })!;
    const [source, color] = decodeAction(action);
    const pick = picksIn(now.factories[source], source).find((p) => p.color === color)!;
    const control = screen.getByRole('button', { name: pickName(pick, now.colorNames) });
    const tiles = [...control.querySelectorAll<HTMLElement>('.tile')];
    expect(tiles).toHaveLength(pick.count);

    // The last tile, not the first: any of them is the control.
    await user.click(tiles[tiles.length - 1]);
    flush();
    expect(control).toHaveAttribute('aria-pressed', 'true');
    expect(control).toHaveClass('selected');
    // Every tile drawn in it is shown selected — the stylesheet marks
    // `.pick.selected .tile`, so every tile has to be inside the marked control.
    expect(control.querySelectorAll('.tile')).toHaveLength(pick.count);
    expect(screen.container.querySelectorAll('.pick.selected .tile')).toHaveLength(pick.count);
    expect(screen.getByRole('region', { name: 'Player 1' })).toHaveTextContent('Holding');

    await user.click(tiles[0]);
    flush();
    expect(control).toHaveAttribute('aria-pressed', 'false');
    expect(screen.container.querySelectorAll('.pick.selected')).toHaveLength(0);
  });
});

describe('the bag and the lid [U3-105]', () => {
  it('[U3-105] [U3-110] keeps the counts in view on the wide table, once, with nothing to open', async () => {
    history.replaceState({}, '', '/?seed=42&seating=human-human');
    vi.resetModules();
    const { App } = await import('../src/components/App.jsx');
    const screen = render(() => <App />);
    const tables = screen.getAllByRole('table', { name: CAPTION });
    expect(tables, 'the counts are not in the document exactly once').toHaveLength(1);
    expect(tables[0].closest('details'), 'the counts are behind a disclosure').toBeNull();
    expect(tables[0].closest('header'), 'the counts are in the top bar').toBeNull();
    // Nor is there a disclosure for them left in the top bar.
    const status = screen.getByRole('region', { name: 'Game status' });
    expect(within(status).queryByText('Bag')).toBeNull();
    expect(screen.container.querySelector('.topbar details')).toBeNull();
    // The same table: columns by their headers, a row per colour.
    expect(within(tables[0]).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Colour', 'Bag', 'Lid',
    ]);
    expect(within(tables[0]).getAllByRole('row')).toHaveLength(6);
  });

  // `bag` is passed explicitly here, both ways. Its default is held by
  // `board.test`'s [U3-34], which renders the status bar without it: seen red,
  // on a copy, with the default flipped to false.
  it('[U3-96] [U3-105] [U3-110] keeps them behind the top bar’s closed disclosure elsewhere', () => {
    const game = openingGame(42);
    const screen = render(() => (
      <Status game={game} seed={42} names={game.colorNames} thinking={null} bag={true} />
    ));
    const tables = screen.getAllByRole('table', { name: CAPTION });
    expect(tables).toHaveLength(1);
    const disclosure = tables[0].closest('details');
    expect(disclosure, 'the counts are not behind a disclosure').not.toBeNull();
    expect(disclosure!.open).toBe(false);
    expect(disclosure!.querySelector('summary')?.textContent).toBe('Bag');
    expect(disclosure!.closest('[aria-label="Game status"]')).not.toBeNull();

    // And the wide table's status bar carries none.
    const wide = render(() => (
      <Status game={game} seed={42} names={game.colorNames} thinking={null} bag={false} />
    ));
    expect(within(wide.container).queryByRole('table')).toBeNull();
    expect(wide.container.querySelector('details')).toBeNull();
  });
});
