/**
 * The new-game sheet [W6-49] through [W6-53], and the deal by number of
 * [U3-104]: the seating gathered in one place and dealt together.
 *
 * Mounted as `opponent.test` mounts, with a seam that never answers, so a
 * computer seat never moves under the test.
 */

import { fireEvent, render, within } from '@solidjs/testing-library';
import { flush } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { choiceNames, choices, choose, commit, deal, editSeat, openSheet } from './sheet-helpers.js';

type State = typeof import('../src/game.js');
type Screen = ReturnType<typeof render>;

async function mount(search = '?seed=42&seating=human-human'): Promise<{ screen: Screen; state: State }> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  const state = await import('../src/game.js');
  state.useThinker({ think: () => new Promise(() => {}), terminate: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
  const { App } = await import('../src/components/App.jsx');
  const screen = render(() => <App />);
  flush();
  return { screen, state };
}

/** Wait for the microtask the sheet moves focus in. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe('the sheet [W6-49]', () => {
  // Seen red, on a copy, with the sheet rendered whether open or not: its
  // controls were in the document with the sheet closed.
  it('[W6-49] [W6-53] is not in the document until the new-game control opens it', async () => {
    const { screen } = await mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryAllByRole('radio')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Deal' })).toBeNull();

    const sheet = openSheet(screen);
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    // The page beneath is inert while it is open.
    expect(screen.getByRole('region', { name: 'Player 1', hidden: true }).closest('[inert]')).not.toBeNull();
    await settle();
    expect(sheet.contains(document.activeElement), 'focus did not move into the sheet').toBe(true);
  });

  // Seen red, on a copy, with choosing a level dealing at once: the first
  // radio dealt a game.
  it('[W6-49] [W6-53] stages every choice, and Close, Escape or a press outside deals nothing', async () => {
    const { screen, state } = await mount('?seed=42&seating=human-sharp');
    const before = state.view();

    let sheet = openSheet(screen);
    editSeat(sheet, 1);
    choose(sheet, 'master');
    commit(within(sheet).getByRole('spinbutton') as HTMLInputElement, '500');
    commit(within(sheet).getByLabelText('Deal number') as HTMLInputElement, '7');
    expect(state.view(), 'a staged choice reached the game').toBe(before);

    within(sheet).getByRole('button', { name: 'Close' }).click();
    flush();
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state.view()).toBe(before);
    expect(document.activeElement, 'focus did not return to the new-game control').toBe(
      screen.getByRole('button', { name: 'New game' }),
    );

    // Opened again it starts from the game as it is, not from what was discarded.
    sheet = openSheet(screen);
    editSeat(sheet, 1);
    expect(choices(sheet).find((r) => r.checked)?.value).toBe('sharp');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state.view()).toBe(before);

    // And a press outside it, on the dimmed page — but not one inside it.
    sheet = openSheet(screen);
    sheet.click();
    flush();
    expect(screen.queryByRole('dialog'), 'a press inside the sheet closed it').not.toBeNull();
    (sheet.parentElement as HTMLElement).click();
    flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state.view()).toBe(before);
  });

  // Seen red, on a copy, with Deal dealing twice: two calls to `newGame`.
  it('[W6-49] [W6-53] deals once, carrying every staged choice', async () => {
    const { screen, state } = await mount('?seed=42&seating=human-human');
    // The engine the freshly imported state module sees, not this file's copy.
    const engine = await import('engine');
    const deals = vi.spyOn(engine, 'newGame');
    const sheet = openSheet(screen);
    editSeat(sheet, 0);
    choose(sheet, 'easy');
    editSeat(sheet, 1);
    choose(sheet, 'master');
    commit(within(sheet).getByRole('spinbutton') as HTMLInputElement, '2500');
    commit(within(sheet).getByLabelText('Deal number') as HTMLInputElement, '12345');
    deal(sheet);

    expect(deals).toHaveBeenCalledTimes(1);
    expect(state.view().seating).toEqual({ players: ['easy', 'master'], simulations: [10_000, 2500] });
    expect(state.view().seed).toBe(12345);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('[W6-49] deals with the seating unchanged, as a rematch', async () => {
    const { screen, state } = await mount('?seed=42&seating=human-steady');
    const before = state.view();
    deal(openSheet(screen));
    expect(state.view().seed).not.toBe(before.seed);
    expect(state.view().seating).toEqual(before.seating);
  });
});

describe('seats and the swap [W6-50]', () => {
  // Seen red, on a copy, with the swap exchanging the levels and not the
  // settings: the master went to seat 1 and its 300 stayed behind.
  it('[W6-50] [W6-53] swaps who sits where, each seat taking its own setting', async () => {
    const { screen, state } = await mount('?seed=42&seating=master-human&p1Simulations=300');
    const sheet = openSheet(screen);
    const cards = within(sheet).getAllByRole('button', { pressed: false }).concat(
      within(sheet).getAllByRole('button', { pressed: true }),
    );
    expect(cards.map((c) => c.textContent).filter((t) => /Player/.test(t ?? '')).sort()).toEqual([
      '1Player 1Master · opens the game',
      '2Player 2A person',
    ]);

    within(sheet).getByRole('button', { name: 'Swap seats' }).click();
    flush();
    expect(within(sheet).getByRole('button', { name: /^Player 1/ })).toHaveTextContent('A person · opens the game');
    expect(within(sheet).getByRole('button', { name: /^Player 2/ })).toHaveTextContent('Master');

    deal(sheet);
    expect(state.view().seating).toEqual({ players: [null, 'master'], simulations: [10_000, 300] });
  });

  it('[W6-50] says which seat is being edited, and edits that one', async () => {
    const { screen } = await mount('?seed=42&seating=human-sharp');
    const sheet = openSheet(screen);
    expect(within(sheet).getByRole('group', { name: 'Player 1 is' })).toBeInTheDocument();
    editSeat(sheet, 1);
    expect(within(sheet).getByRole('button', { name: /^Player 2/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sheet).getByRole('group', { name: 'Player 2 is' })).toBeInTheDocument();
    expect(choices(sheet).find((r) => r.checked)?.value).toBe('sharp');
  });
});

describe('the choices [W6-51]', () => {
  it('[W6-51] names each choice and says how it is built, in the order of [W6-1]', async () => {
    const { screen } = await mount();
    const sheet = openSheet(screen);
    const lines = choices(sheet).map((r) => r.closest('label')!.textContent);
    const offered = choices(sheet).map((r) => r.value);
    const table: Record<string, string> = {
      human: 'A personPass the device between turns',
      easy: 'GentleLooks only at its own move',
      steady: 'SteadyLooks at your reply, and its answer to it',
      sharp: 'RuthlessLooks as far ahead as it can, and times the round’s end',
      expert: 'ExpertA published player, learned rather than written',
      master: 'MasterTaught itself by playing itself',
    };
    expect(lines).toEqual(offered.map((value) => table[value]));
    expect(offered[0]).toBe('human');
    expect(offered.at(-1)).toBe('master');
    // Never a number, and never a ranking in words [W6-1], [W6-24].
    for (const line of lines) expect(line).not.toMatch(/\d|strong|weak|best|hard|easiest/i);
    expect(choiceNames(sheet)[0]).toBe('A person');
  });
});

describe("the master's setting in the sheet [W6-45]", () => {
  // Seen red, on a copy, with the slider's handler staging `STOPS[0]` whatever
  // it was moved to.
  it('[W6-45] [W6-53] moves the slider and the number together', async () => {
    const { screen } = await mount('?seed=42&seating=master-human');
    const sheet = openSheet(screen);
    const slider = within(sheet).getByRole('slider') as HTMLInputElement;
    const number = within(sheet).getByRole('spinbutton') as HTMLInputElement;
    expect(slider).toHaveAttribute('aria-valuetext', '10,000 simulations');
    expect(number.value).toBe('10000');

    // The slider's stops are a 1-2-5 ladder; one step up from the default.
    fireEvent.input(slider, { target: { value: String(Number(slider.value) + 1) } });
    flush();
    expect(number.value).toBe('20000');
    expect(slider).toHaveAttribute('aria-valuetext', '20,000 simulations');

    commit(number, '12345');
    expect(slider).toHaveAttribute('aria-valuetext', '12,345 simulations');
  });
});

describe('a deal by number [U3-104]', () => {
  // Seen red, on a copy, with the sheet's check replaced by `Number(raw)`:
  // "12.5" dealt seed 12.5 and "1e3" dealt 1000.
  it('[U3-104] [U3-13] deals a typed number, and refuses anything the URL would refuse', async () => {
    const { screen, state } = await mount('?seed=42&seating=human-human');
    const sheet = openSheet(screen);
    const field = within(sheet).getByLabelText('Deal number') as HTMLInputElement;
    for (const bad of ['abc', '4294967296', '-1', '12.5', '1e3', ' 7x']) {
      fireEvent.input(field, { target: { value: bad } });
      deal(sheet);
      expect(state.view().seed, bad).toBe(42);
      expect(screen.getByRole('dialog', { name: 'New game' }), bad).toBeInTheDocument();
      expect(within(sheet).getByRole('status').textContent, bad).toContain('0 to 4,294,967,295');
    }
    fireEvent.input(field, { target: { value: '4294967295' } });
    deal(sheet);
    expect(state.view().seed).toBe(4294967295);
  });

  it('[U3-104] [U3-47] deals a fresh seed when the number is left empty', async () => {
    const { screen, state } = await mount('?seed=42&seating=human-human');
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint32Array)[0] = 777;
      return array;
    });
    deal(openSheet(screen));
    expect(state.view().seed).toBe(777);
  });
});

describe('the end of a game [W6-52]', () => {
  async function ended(search: string): Promise<{ screen: Screen; state: State }> {
    const mounted = await mount(search);
    for (let ply = 0; ply < 400 && !mounted.state.view().game.isTerminal; ply++) {
      mounted.state.submit(mounted.state.view().game.legalActions[0]);
      flush();
    }
    expect(mounted.state.view().game.isTerminal, 'the game never ended').toBe(true);
    return mounted;
  }

  // Seen red, on a copy, with Replay wired to `startNewGame`: a fresh seed.
  it('[W6-52] [W6-53] offers a rematch, the same deal again, and the seats', async () => {
    const { screen, state } = await ended('?seed=42&seating=human-human');
    const result = screen.getByRole('region', { name: 'Final result' });

    within(result).getByRole('button', { name: 'Replay this deal' }).click();
    flush();
    expect(state.view().seed).toBe(42);
    expect(state.view().game.isTerminal).toBe(false);
    expect(state.view().game.round).toBe(0);

    const again = await ended('?seed=42&seating=human-easy');
    within(again.screen.getByRole('region', { name: 'Final result' }))
      .getByRole('button', { name: 'Rematch' }).click();
    flush();
    expect(again.state.view().seed).not.toBe(42);
    expect(again.state.view().seating.players).toEqual([null, 'easy']);

    const third = await ended('?seed=42&seating=human-human');
    within(third.screen.getByRole('region', { name: 'Final result' }))
      .getByRole('button', { name: 'Change seats' }).click();
    flush();
    expect(third.screen.getByRole('dialog', { name: 'New game' })).toBeInTheDocument();
  });
});
