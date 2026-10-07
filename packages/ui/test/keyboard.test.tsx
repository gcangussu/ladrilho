/**
 * A complete game driven by the keyboard alone [U3-71].
 *
 * No control is ever focused programmatically and none is ever clicked: focus
 * enters a group with Tab and moves inside it with the arrow keys [U3-53],
 * which is the only way this test can reach anything. A control that the
 * roving tabindex cannot reach is a control this game cannot play, so the test
 * simply does not finish.
 *
 * The live region is read after every ply, and each of [U3-56]'s three events —
 * the turn passing, a round scoring, the game ending — is asserted to have been
 * announced.
 */

import { fireEvent, render } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { CENTER, FLOOR, Rng, apply, decodeAction, encodeAction, newGame, toJSON } from 'engine';
import type { AzulJSON, AzulState } from 'engine';
import { flush } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { pickName } from '../src/components/Displays.jsx';
import { floorLineName } from '../src/components/FloorLine.jsx';
import { patternLineName } from '../src/components/PatternLines.jsx';

const GAME_SEED = 4242;
const CHOICE_SEED = 31415;
const PLY_LIMIT = 400;
/** Bounded so a group that is not a single tab stop hangs the test visibly. */
const TAB_LIMIT = 12;
const ARROW_LIMIT = 60;

const focused = (): HTMLElement => document.activeElement as HTMLElement;
const label = (): string => focused()?.getAttribute('aria-label') ?? '';
const groupOf = (el: HTMLElement): string =>
  el.closest<HTMLElement>('[data-group]')?.dataset['group'] ?? '';

describe('[U3-71] a whole game from the keyboard', () => {
  it('[U3-52] [U3-53] [U3-56] reaches a terminal position, announcing as it goes', async () => {
    const user = userEvent.setup();
    history.replaceState({}, '', `/?seed=${GAME_SEED}&seating=human-human`);
    vi.resetModules();
    const { App } = await import('../src/components/App.jsx');
    const screen = render(() => <App />);

    // The oracle: the same deal, driven by the engine alone.
    const state: AzulState = newGame(GAME_SEED);
    const rng = new Rng(CHOICE_SEED);
    const said: string[] = [];
    const region = screen.getByRole('status');

    /** Tab until focus is inside `group`, and say how many stops it took. */
    async function tabInto(group: string): Promise<number> {
      for (let stops = 1; stops <= TAB_LIMIT; stops++) {
        await user.tab();
        if (groupOf(focused()) === group) return stops;
      }
      throw new Error(`${group} was not reachable within ${TAB_LIMIT} tab stops`);
    }

    /** Arrow along the roving tabindex until the named control has focus. */
    function arrowTo(name: string): void {
      for (let steps = 0; steps <= ARROW_LIMIT; steps++) {
        if (label() === name) return;
        fireEvent.keyDown(focused(), { key: 'ArrowRight' });
      }
      throw new Error(`${JSON.stringify(name)} was not reachable with the arrow keys`);
    }

    function activate(): void {
      // Enter on a focused button is a click, which is what a keyboard player
      // does; jsdom does not synthesise it, so the click is dispatched here on
      // the element the arrow keys left focus on — never on one this test chose.
      fireEvent.keyDown(focused(), { key: 'Enter' });
      focused().click();
      flush();
    }

    let ply = 0;
    for (; ply < PLY_LIMIT && !state.isTerminal; ply++) {
      const game: AzulJSON = toJSON(state);
      const action = game.legalActions[rng.next() % game.legalActions.length];
      const [source, color, dest] = decodeAction(action);
      const fromCentre = source === CENTER;
      const count = (fromCentre ? game.center : game.factories[source])[color];

      await tabInto(fromCentre ? 'centre' : 'factories');
      arrowTo(pickName({ source, color, count }, game.colorNames));
      activate();

      const p = game.currentPlayer;
      const destName =
        dest === FLOOR
          ? floorLineName(occupiedOf(state, p), game.players[p].floorPenalty)
          : patternLineName(game.players[p].patternLines[dest], dest, game.colorNames);
      await tabInto('destinations');
      arrowTo(destName);
      activate();

      apply(state, encodeAction(source, color, dest));
      said.push(region.textContent ?? '');
    }

    expect(state.isTerminal, `the game never ended within ${PLY_LIMIT} plies`).toBe(true);

    // [U3-56]: the turn passing, a round scoring, and the end of the game.
    expect(said.filter((s) => s.includes('Player 1 to move.')).length).toBeGreaterThan(0);
    expect(said.filter((s) => s.includes('Player 2 to move.')).length).toBeGreaterThan(0);
    expect(said.filter((s) => /Round \d+ scored\./.test(s)).length).toBeGreaterThan(0);
    expect(said[said.length - 1]).toMatch(/Game over\./);
    // Headroom, not a fix. A whole game driven through the DOM one keypress at
    // a time is the slowest test in the package — about 9 seconds of work — so
    // the default 20 s left barely 2.3x, and on a machine running anything else
    // it times out. That is contention rather than a defect, but a per-test
    // wall-clock limit with that little room reports contention as failure, and
    // a failing test is read as a broken one.
  }, 60_000);
});

/** `floorOccupied` for the oracle state, which is the engine's own arithmetic. */
function occupiedOf(state: AzulState, p: number): number {
  return state.floor[p].reduce((a, b) => a + b, 0) + (state.floorMarker[p] ? 1 : 0);
}
