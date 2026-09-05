/**
 * Taking a turn: what is offered, what it does, and what a keyboard can reach.
 *
 * Every control is found by accessible role and name [U3-68] — which is what
 * turns [U3-54] from an aspiration into an assertion, because a test that can
 * only find a control the way a screen reader would fails when the labelling
 * does.
 *
 * The interface is mounted by importing it afresh at a chosen URL, the same
 * route `game.test.ts` uses: `src/game.ts` deals on import [U3-16], so a fresh
 * import is a reload, and the seed comes from the production path rather than a
 * test-only entry point.
 */

import { render, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { CENTER, FLOOR, NUM_COLORS, NUM_FACTORIES, NUM_ROWS, decodeAction, encodeAction } from 'engine';
import type { AzulJSON } from 'engine';
import { flush } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pickName, picksIn } from '../src/components/Displays.jsx';
import { floorLineName } from '../src/components/FloorLine.jsx';
import { patternLineName } from '../src/components/PatternLines.jsx';

type Screen = ReturnType<typeof render>;

/** Mount the interface on a fresh game, and hand back the state module too. */
async function mount(search = '?seed=42'): Promise<{
  screen: Screen;
  game: () => AzulJSON;
}> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  const { App } = await import('../src/components/App.jsx');
  const { view } = await import('../src/game.js');
  return { screen: render(() => <App />), game: () => view().game };
}

/** Every source pool, paired with the source number the action encoding uses. */
function pools(game: AzulJSON): { pool: number[]; source: number }[] {
  return [
    ...game.factories.map((pool, source) => ({ pool, source })),
    { pool: game.center, source: CENTER },
  ];
}

/** The `(source, colour)` pairs at least one legal action mentions [U3-61]. */
function legalPairs(game: AzulJSON): Set<string> {
  const open = new Set<string>();
  for (const action of game.legalActions) {
    const [source, color] = decodeAction(action);
    open.add(`${source},${color}`);
  }
  return open;
}

function pickButton(screen: Screen, game: AzulJSON, source: number, color: number): HTMLElement {
  const pool = source === CENTER ? game.center : game.factories[source];
  return screen.getByRole('button', {
    name: pickName({ source, color, count: pool[color] }, game.colorNames),
  });
}

function destButton(screen: Screen, game: AzulJSON, dest: number): HTMLElement {
  const p = game.currentPlayer;
  const name =
    dest === FLOOR
      ? floorLineName(
          game.players[p].floor.reduce((a, b) => a + b, 0) + (game.players[p].floorMarker ? 1 : 0),
          game.players[p].floorPenalty,
        )
      : patternLineName(game.players[p].patternLines[dest], dest, game.colorNames);
  return screen.getByRole('button', { name });
}

const available = (control: HTMLElement): boolean =>
  control.getAttribute('aria-disabled') === 'false';

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});

describe('what is offered', () => {
  it('[U3-32] shows the five factory displays and the centre pool', async () => {
    const { screen, game } = await mount();
    expect(screen.getByRole('group', { name: 'Factory displays' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Centre pool' })).toBeInTheDocument();
    expect(game().factories).toHaveLength(NUM_FACTORIES);
  });

  it('[U3-79] renders one control per pool that actually holds that colour, no more', async () => {
    const { screen, game } = await mount();
    const expected = pools(game()).flatMap(({ pool, source }) => picksIn(pool, source));
    const controls = [
      ...within(screen.getByRole('group', { name: 'Factory displays' })).queryAllByRole('button'),
      ...within(screen.getByRole('group', { name: 'Centre pool' })).queryAllByRole('button'),
    ];
    expect(controls).toHaveLength(expected.length);
    // At the opening every tile is on a factory, so the centre offers nothing —
    // which is [U3-79] working: presence follows the pool, not the colour count.
    expect(within(screen.getByRole('group', { name: 'Centre pool' })).queryAllByRole('button'))
      .toHaveLength(0);
    for (const pick of expected) {
      expect(pickButton(screen, game(), pick.source, pick.color)).toBeInTheDocument();
    }
  });

  it('[U3-79] renders all six destinations for the player to move', async () => {
    const { screen } = await mount();
    const group = screen.getByRole('group', { name: /pattern lines and floor$/ });
    expect(within(group).getAllByRole('button')).toHaveLength(NUM_ROWS + 1);
  });

  it('[U3-23] [U3-48] [U3-61] exactly the pairs some legal action mentions are available', async () => {
    const { screen, game } = await mount();
    const open = legalPairs(game());
    let checked = 0;
    for (const { pool, source } of pools(game())) {
      for (let color = 0; color < NUM_COLORS; color++) {
        if (pool[color] === 0) continue;
        const control = pickButton(screen, game(), source, color);
        expect(available(control), `${source},${color}`).toBe(open.has(`${source},${color}`));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('[U3-24] [U3-62] no destination is available until a pair is chosen', async () => {
    const { screen, game } = await mount();
    for (const dest of [...Array(NUM_ROWS).keys(), FLOOR]) {
      expect(available(destButton(screen, game(), dest))).toBe(false);
    }
  });

  it('[U3-19] [U3-24] [U3-48] [U3-62] with a selection, exactly the legal destinations are available', async () => {
    const { screen, game } = await mount();
    const [source, color] = decodeAction(game().legalActions[0]);
    await user.click(pickButton(screen, game(), source, color));
    flush();

    const legal = new Set(game().legalActions);
    for (const dest of [...Array(NUM_ROWS).keys(), FLOOR]) {
      expect(available(destButton(screen, game(), dest)), `dest ${dest}`).toBe(
        legal.has(encodeAction(source, color, dest)),
      );
    }
    // Never empty: the floor is always available while tiles are [0001 E1-12].
    expect(available(destButton(screen, game(), FLOOR))).toBe(true);
  });
});

describe('taking a turn', () => {
  it('[U3-22] [U3-25] choosing a pair then a destination advances the game', async () => {
    const { screen, game } = await mount();
    const before = game();
    const [source, color, dest] = decodeAction(before.legalActions[0]);

    await user.click(pickButton(screen, before, source, color));
    flush();
    expect(game().tilesLeft, 'a selection is not a move').toBe(before.tilesLeft);

    await user.click(destButton(screen, game(), dest));
    flush();
    expect(game().currentPlayer).not.toBe(before.currentPlayer);
  });

  it('[U3-27] clearing a selection does not change the game', async () => {
    const { screen, game } = await mount();
    const before = game();
    const [source, color] = decodeAction(before.legalActions[0]);
    const control = pickButton(screen, before, source, color);

    await user.click(control);
    flush();
    expect(control).toHaveAttribute('aria-pressed', 'true');

    // [U3-26]: the same pair again clears the selection.
    await user.click(control);
    flush();
    expect(control).toHaveAttribute('aria-pressed', 'false');
    expect(game()).toEqual(before);
  });

  it('[U3-26] Escape clears the selection', async () => {
    const { screen, game } = await mount();
    const [source, color] = decodeAction(game().legalActions[0]);
    const control = pickButton(screen, game(), source, color);
    await user.click(control);
    flush();
    await user.keyboard('{Escape}');
    flush();
    expect(control).toHaveAttribute('aria-pressed', 'false');
    expect(available(destButton(screen, game(), FLOOR))).toBe(false);
  });

  it('[U3-26] a different available pair replaces the selection', async () => {
    const { screen, game } = await mount();
    const pairs = [...legalPairs(game())].map((k) => k.split(',').map(Number));
    const [first, second] = pairs;
    const a = pickButton(screen, game(), first[0], first[1]);
    const b = pickButton(screen, game(), second[0], second[1]);

    await user.click(a);
    flush();
    await user.click(b);
    flush();
    expect(a).toHaveAttribute('aria-pressed', 'false');
    expect(b).toHaveAttribute('aria-pressed', 'true');
  });

  it('[U3-28] [U3-64] no selection survives a ply', async () => {
    const { screen, game } = await mount();
    const [source, color, dest] = decodeAction(game().legalActions[0]);
    const control = pickButton(screen, game(), source, color);
    await user.click(control);
    flush();
    await user.click(destButton(screen, game(), dest));
    flush();
    for (const d of [...Array(NUM_ROWS).keys(), FLOOR]) {
      expect(available(destButton(screen, game(), d)), `dest ${d}`).toBe(false);
    }
  });

  it('[U3-29] [U3-55] an unavailable control is present, focusable, and does nothing', async () => {
    const { screen, game } = await mount();
    const before = game();
    // A destination with no selection active is unavailable but still there.
    const control = destButton(screen, before, FLOOR);
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(control).not.toBeDisabled();

    control.focus();
    expect(control).toHaveFocus();

    await user.click(control);
    flush();
    expect(game()).toEqual(before);
  });
});

describe('nothing illegal is reachable', () => {
  it('[U3-19] every available control encodes an action the engine calls legal', async () => {
    const { screen, game } = await mount();
    const legal = new Set(game().legalActions);

    // Sources first: an available pair must be mentioned by some legal action.
    for (const { pool, source } of pools(game())) {
      for (let color = 0; color < NUM_COLORS; color++) {
        if (pool[color] === 0) continue;
        if (!available(pickButton(screen, game(), source, color))) continue;
        const reachable = [...Array(NUM_ROWS).keys(), FLOOR].map((d) =>
          encodeAction(source, color, d),
        );
        expect(reachable.some((a) => legal.has(a)), `${source},${color}`).toBe(true);
      }
    }

    // Then destinations, under every selection a player could make.
    for (const key of legalPairs(game())) {
      const [source, color] = key.split(',').map(Number);
      await user.click(pickButton(screen, game(), source, color));
      flush();
      for (const dest of [...Array(NUM_ROWS).keys(), FLOOR]) {
        if (!available(destButton(screen, game(), dest))) continue;
        expect(legal.has(encodeAction(source, color, dest)), `${key},${dest}`).toBe(true);
      }
      await user.keyboard('{Escape}');
      flush();
    }
  });
});

describe('the keyboard', () => {
  it('[U3-53] each group is a single tab stop with one roving tabindex', async () => {
    const { screen } = await mount();
    for (const label of ['Factory displays', /pattern lines and floor$/]) {
      const group = screen.getByRole('group', { name: label });
      const controls = within(group).getAllByRole('button');
      expect(controls.filter((c) => c.getAttribute('tabindex') === '0'), String(label))
        .toHaveLength(1);
      expect(controls.filter((c) => c.getAttribute('tabindex') === '-1')).toHaveLength(
        controls.length - 1,
      );
    }
  });

  it('[U3-52] [U3-53] arrow keys move within a group and take focus along', async () => {
    const { screen } = await mount();
    const controls = within(
      screen.getByRole('group', { name: 'Factory displays' }),
    ).getAllByRole('button');
    controls[0].focus();
    await user.keyboard('{ArrowRight}');
    flush();
    expect(controls[1]).toHaveFocus();
    expect(controls[1]).toHaveAttribute('tabindex', '0');
    expect(controls[0]).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{ArrowLeft}');
    flush();
    expect(controls[0]).toHaveFocus();
  });

  it('[U3-57] focus is not lost across a ply', async () => {
    const { screen, game } = await mount();
    const before = game();
    const [source, color, dest] = decodeAction(before.legalActions[0]);

    await user.click(pickButton(screen, before, source, color));
    flush();
    const control = destButton(screen, game(), dest);
    control.focus();
    expect(control).toHaveFocus();

    await user.keyboard('{Enter}');
    flush();

    // The destinations group has moved to the other player's board, so the
    // control that had focus is gone; focus lands on a surviving control in the
    // same group rather than on the document body.
    const landed = document.activeElement as HTMLElement;
    expect(landed).not.toBe(document.body);
    expect(landed.closest('[data-group]')?.getAttribute('data-group')).toBe('destinations');
  });

  it('[U3-52] a whole turn can be taken from the keyboard alone', async () => {
    const { screen, game } = await mount();
    const before = game();
    const [source, color, dest] = decodeAction(before.legalActions[0]);

    pickButton(screen, before, source, color).focus();
    await user.keyboard('{Enter}');
    flush();
    destButton(screen, game(), dest).focus();
    await user.keyboard('{Enter}');
    flush();

    expect(game().currentPlayer).not.toBe(before.currentPlayer);
  });
});

describe('the live region', () => {
  it('[U3-56] announces the turn passing to the other player', async () => {
    const { screen, game } = await mount();
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Player 1 to move.');

    const [source, color, dest] = decodeAction(game().legalActions[0]);
    await user.click(pickButton(screen, game(), source, color));
    flush();
    await user.click(destButton(screen, game(), dest));
    flush();
    expect(region).toHaveTextContent('Player 2 to move.');
  });
});
