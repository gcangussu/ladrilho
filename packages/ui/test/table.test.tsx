/**
 * The table [U3-96] through [U3-102]: the parts of intent 0011 that are about
 * what is in the document rather than where it lands on the screen. Where it
 * lands is the browser lane's ([U3-73]).
 *
 * Elements are located by accessible role and visible text [U3-68], and the
 * interface is mounted by importing it afresh at a chosen URL, as `turn.test`
 * does.
 */

import { render, within } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { CENTER, FLOOR, NUM_ROWS, decodeAction, wallColorAt } from 'engine';
import type { AzulJSON } from 'engine';
import { flush } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { factoryName, pickName, picksIn } from '../src/components/Displays.jsx';
import { lastMoveText } from '../src/components/PlayerBoard.jsx';

type Screen = ReturnType<typeof render>;
type Game = typeof import('../src/game.js');

async function mount(search = '?seed=42&seating=human-human'): Promise<{ screen: Screen; game: Game }> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  const { App } = await import('../src/components/App.jsx');
  const game = await import('../src/game.js');
  return { screen: render(() => <App />), game };
}

const now = (game: Game): AzulJSON => game.view().game;

/** The control for a legal pick, by its accessible name [U3-54]. */
function pickOf(screen: Screen, game: AzulJSON, action: number): HTMLElement {
  const [source, color] = decodeAction(action);
  const pool = source === CENTER ? game.center : game.factories[source];
  const pick = picksIn([...pool], source).find((p) => p.color === color)!;
  return screen.getByRole('button', { name: pickName(pick, game.colorNames) });
}

/** A legal action whose source holds more than one tile of its colour. */
function aMultiple(game: AzulJSON): number {
  return game.legalActions.find((action) => {
    const [source, color] = decodeAction(action);
    return source !== CENTER && game.factories[source][color] > 1;
  })!;
}

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});

describe('settings out of the play area [U3-96]', () => {
  it('[U3-96] keeps the seats in the new-game sheet and the bag behind a closed disclosure', async () => {
    const { screen } = await mount();
    // No seat control in the page until the sheet is opened, and none in the
    // play area ever [0006 W6-49].
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(screen.queryAllByRole('combobox')).toEqual([]);
    const opener = screen.getByRole('button', { name: 'New game' });
    expect(opener.closest('header'), 'the new-game control is not in the top bar').not.toBeNull();
    opener.click();
    flush();
    const sheet = screen.getByRole('dialog', { name: 'New game' });
    expect(within(sheet).getAllByRole('radio').length).toBeGreaterThan(1);

    const status = screen.getByRole('region', { name: 'Game status' });
    const bag = within(status).getByRole('table').closest('details');
    expect(bag, 'the bag counts are not behind a disclosure').not.toBeNull();
    expect(bag!.open).toBe(false);
  });
});

describe('a pick drawn as the one thing it is [U3-97]', () => {
  // Seen red, on a copy, with the pick drawn as `<Repeat count>` tiles again:
  // the colour name appeared three times inside one control.
  it('[U3-97] draws one tile and the count, never a row of tiles', async () => {
    const { screen, game } = await mount();
    const names = now(game).colorNames;
    let multiples = 0;
    for (let source = 0; source < now(game).factories.length; source++) {
      for (const pick of picksIn(now(game).factories[source], source)) {
        const control = screen.getByRole('button', { name: pickName(pick, names) });
        expect(within(control).getAllByText(names[pick.color]), pickName(pick, names)).toHaveLength(1);
        if (pick.count > 1) {
          multiples++;
          expect(within(control).getByText(String(pick.count))).toBeInTheDocument();
        } else {
          expect(control.textContent).not.toMatch(/\d/);
        }
      }
    }
    expect(multiples, 'the deal held no pick of more than one tile').toBeGreaterThan(0);
  });
});

describe("the board's strip [U3-99]", () => {
  it('[U3-99] says what a turn asks for, and then what is held and from where', async () => {
    const { screen, game } = await mount();
    const board = screen.getByRole('region', { name: 'Player 1' });
    expect(board).toHaveTextContent('Take one colour from a factory or the centre.');
    expect(within(board).queryByRole('button', { name: /put back/i })).toBeNull();

    const action = aMultiple(now(game));
    const [source, color] = decodeAction(action);
    await user.click(pickOf(screen, now(game), action));
    flush();

    expect(board).toHaveTextContent('Holding');
    expect(board).toHaveTextContent(`from ${factoryName(source).toLowerCase()}`);
    // The tiles in hand, one per tile, each naming its colour.
    const strip = within(board).getByText('Holding').parentElement!;
    expect(within(strip).getAllByText(now(game).colorNames[color])).toHaveLength(
      now(game).factories[source][color],
    );
    // And not on the other board.
    expect(screen.getByRole('region', { name: 'Player 2' })).not.toHaveTextContent('Holding');
  });

  // Seen red, on a copy, with `onPutBack` wired to nothing: the selection and
  // the strip both survived the press.
  it('[U3-99] [U3-26] [U3-27] puts the tiles back without touching the game', async () => {
    const { screen, game } = await mount();
    const before = JSON.stringify(now(game));
    const action = aMultiple(now(game));
    const pick = pickOf(screen, now(game), action);
    await user.click(pick);
    flush();
    expect(pick).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /put back/i }));
    flush();
    expect(pick).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('region', { name: 'Player 1' })).not.toHaveTextContent('Holding');
    expect(JSON.stringify(now(game))).toBe(before);
  });
});

describe('rows by number [U3-100]', () => {
  // Seen red, on a copy, with the digit's `- 1` dropped: key 1 chose line 2.
  it('[U3-100] places on the line its number names, and does nothing for one that cannot take it',
    async () => {
      const { screen, game } = await mount();
      const opening = now(game);
      const action = aMultiple(opening);
      const [source, color] = decodeAction(action);
      const offered = (dest: number): boolean =>
        opening.legalActions.some((a) => {
          const [s, c, d] = decodeAction(a);
          return s === source && c === color && d === dest;
        });

      await user.click(pickOf(screen, opening, action));
      flush();

      // A key past the last line names no row, and does nothing. (Every line is
      // open at the opening; the next test poses one that is not.)
      await user.keyboard(String(NUM_ROWS + 1));
      flush();
      expect(now(game), 'a key with no line behind it played a move').toBe(opening);

      const row = [...Array(NUM_ROWS).keys()].reverse().find(offered)!;
      await user.keyboard(String(row + 1));
      flush();
      const after = now(game);
      expect(after.players[0].patternLines[row].count, `line ${row + 1}`).toBeGreaterThan(0);
      expect(after.players[0].patternLines[row].color).toBe(color);
    });

  it('[U3-100] [U3-29] ignores a row key for a line the engine does not offer', async () => {
    const { screen, game } = await mount();
    // Fill line 1 with something, so a different colour cannot go there.
    const first = now(game).legalActions.find((a) => decodeAction(a)[2] === 0)!;
    await user.click(pickOf(screen, now(game), first));
    flush();
    await user.keyboard('1');
    flush();
    // Player 2's move, anywhere but line 1.
    const second = now(game).legalActions.find((a) => decodeAction(a)[2] === FLOOR)!;
    await user.click(pickOf(screen, now(game), second));
    flush();
    await user.keyboard('f');
    flush();
    expect(now(game).players[1].floor.some((n) => n > 0) || now(game).players[1].floorMarker).toBe(true);

    // Player 1 again, with a colour line 1 cannot take.
    const held = now(game).players[0].patternLines[0].color;
    const other = now(game).legalActions.find((a) => decodeAction(a)[1] !== held)!;
    const legalOnLine1 = now(game).legalActions.some((a) => {
      const [s, c, d] = decodeAction(a);
      const [os, oc] = decodeAction(other);
      return s === os && c === oc && d === 0;
    });
    expect(legalOnLine1, 'the posed move could go on line 1 after all').toBe(false);
    const before = now(game);
    await user.click(pickOf(screen, before, other));
    flush();
    await user.keyboard('1');
    flush();
    expect(now(game), 'a key for an unavailable line played a move').toBe(before);
  });
});

describe('the last move [U3-101]', () => {
  it('[U3-101] records each seat’s move, shows it on that seat’s board, and a deal clears it',
    async () => {
      const { screen, game } = await mount();
      expect(game.view().lastMoves).toEqual([null, null]);
      const action = now(game).legalActions[0];
      await user.click(pickOf(screen, now(game), action));
      flush();
      const [, , dest] = decodeAction(action);
      await user.click(
        within(screen.getByRole('region', { name: 'Player 1' })).getAllByRole('button')
          .filter((b) => b.getAttribute('aria-disabled') === 'false')
          .find((b) => (dest === FLOOR
            ? /^floor line/.test(b.getAttribute('aria-label') ?? '')
            : (b.getAttribute('aria-label') ?? '').startsWith(`pattern line ${dest + 1},`)))!,
      );
      flush();

      expect(game.view().lastMoves).toEqual([action, null]);
      const text = lastMoveText(action, now(game).colorNames);
      expect(screen.getByRole('region', { name: 'Player 1' })).toHaveTextContent('Last move');
      expect(screen.getByRole('region', { name: 'Player 1' })).toHaveTextContent(text);
      expect(screen.getByRole('region', { name: 'Player 2' })).not.toHaveTextContent('Last move');

      game.startNewGame();
      flush();
      expect(game.view().lastMoves).toEqual([null, null]);
      expect(screen.getByRole('region', { name: 'Player 1' })).not.toHaveTextContent('Last move');
    });

  it('[U3-101] says the move in game terms, from the engine’s decoding', () => {
    const names = ['blue', 'yellow', 'red', 'black', 'teal'];
    // Factory 4, red, pattern line 3 — and the centre, teal, the floor.
    const fromFactory = (() => {
      for (let a = 0; ; a++) {
        const [s, c, d] = decodeAction(a);
        if (s === 3 && c === 2 && d === 2) return a;
      }
    })();
    const fromCentre = (() => {
      for (let a = 0; ; a++) {
        const [s, c, d] = decodeAction(a);
        if (s === CENTER && c === 4 && d === FLOOR) return a;
      }
    })();
    expect(lastMoveText(fromFactory, names)).toBe('red from factory 4 to pattern line 3');
    expect(lastMoveText(fromCentre, names)).toBe('teal from the centre to the floor line');
  });
});

describe('points on the tiles that earned them [U3-102]', () => {
  // Seen red, on a copy, with `points={earned(r, col)}` dropped from the wall.
  it('[U3-102] badges each placed cell with what the record says it earned', async () => {
    const { screen, game } = await mount();
    for (let ply = 0; ply < 400 && game.view().scoring === null; ply++) {
      game.submit(now(game).legalActions[0]);
      flush();
    }
    const scoring = game.view().scoring!;
    expect(scoring, 'no round scored').not.toBeNull();

    for (const p of [0, 1] as const) {
      const wall = screen.getByRole('group', { name: `Player ${p + 1} wall` });
      const badges = within(wall).queryAllByText(/^\+\d+$/).map((b) => b.textContent);
      expect(badges, `Player ${p + 1}`).toEqual(
        scoring.players[p].placements.map((placement) => `+${placement.points}`),
      );
      // Each on its own cell: the colour that cell belongs to.
      for (const placement of scoring.players[p].placements) {
        const name = now(game).colorNames[wallColorAt(placement.row, placement.col)];
        // "red", or "red, just placed" on the ply that placed it [U3-43].
        const cell = within(wall).getAllByText(new RegExp(`^${name}(, just placed)?$`))
          .map((n) => n.parentElement!)
          .find((c) => within(c).queryByText(`+${placement.points}`) !== null);
        expect(cell, `${name} at ${placement.row},${placement.col}`).toBeDefined();
      }
    }

    // A ply later the transition is over, and the badges are not: they last as
    // long as the record does [U3-82].
    game.submit(now(game).legalActions[0]);
    flush();
    expect(game.view().transition).toBeNull();
    const still = within(screen.getByRole('group', { name: 'Player 1 wall' })).queryAllByText(/^\+\d+$/);
    expect(still).toHaveLength(scoring.players[0].placements.length);
  });
});
