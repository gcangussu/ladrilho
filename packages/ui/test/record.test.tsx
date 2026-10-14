/**
 * The game's record: *0006 — Opponent in the interface*, [W6-67] onward, for
 * intent 0014 — The game's record, for the curious.
 *
 * `history` rides on every publish and takes each reply from the turn loop, so
 * as with the estimate most of this file is about the seam: which publish
 * appends, which must not, and whether the transition of [0003 U3-42] and the
 * focus rule of [0003 U3-57] still hold with something else on the same
 * `setView`. The rest reads the rendered dialog the way a screen reader does.
 *
 * The list of what must be asserted is [W6-83]'s; the invariants run again in
 * [W6-29]'s property test. Mutation records are in the spec, under [W6-84].
 */

import { render, within } from '@solidjs/testing-library';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoundScoring } from 'engine';
import { flush } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlyRecord } from '../src/game.js';
import type { Choice, ExpertChoice, FromWorker, MasterChoice, Thinker, ToWorker } from '../src/opponent.js';
import { holdsRecordInvariants } from './record-helpers.js';

type StateModule = typeof import('../src/game.js');
type AnyChoice = Choice | ExpertChoice | MasterChoice;

/** A seam that answers only when told to, with the choice it is told. */
function scriptedThinker(): {
  seam: Thinker;
  pending: ToWorker[];
  answer(index: number, choice?: Partial<AnyChoice>): Promise<AnyChoice>;
  fail(index: number): void;
} {
  const pending: ToWorker[] = [];
  const resolvers: ((reply: FromWorker) => void)[] = [];
  return {
    seam: {
      think(request) {
        pending.push(request);
        return new Promise<FromWorker>((resolve) => resolvers.push(resolve));
      },
      terminate() {},
    },
    pending,
    async answer(index, overrides = {}) {
      const request = pending[index];
      const action = request.position.legalActions[0];
      // Each level's own reply shape, every field distinct so a dropped or
      // swapped one shows.
      const base: AnyChoice =
        request.tier === 'master'
          ? { action, value: 0.24, simulations: request.simulations }
          : request.tier === 'expert'
            ? { action, value: -0.5, simulations: 800, rootVisits: 412 }
            : { action, value: 3.24, depth: 4, nodes: 12_345, complete: true, curtailed: false };
      const choice = { ...base, ...overrides } as AnyChoice;
      resolvers[index]({ generation: request.generation, ok: true, choice });
      await Promise.resolve();
      await Promise.resolve();
      flush();
      return choice;
    },
    fail(index) {
      resolvers[index]({ generation: pending[index].generation, ok: false, message: 'no move' });
    },
  };
}
type Harness = ReturnType<typeof scriptedThinker>;

async function load(search: string): Promise<{ state: StateModule; harness: Harness }> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  const state = (await import('../src/game.js')) as StateModule;
  const harness = scriptedThinker();
  state.useThinker(harness.seam);
  await new Promise((resolve) => setTimeout(resolve, 0));
  flush();
  return { state, harness };
}

async function mount(search: string): Promise<{
  screen: ReturnType<typeof render>;
  state: StateModule;
  harness: Harness;
}> {
  const { state, harness } = await load(search);
  const { App } = await import('../src/components/App.jsx');
  const screen = render(() => <App />);
  flush();
  return { screen, state, harness };
}

function personPlays(state: StateModule): void {
  state.submit(state.view().game.legalActions[0]);
  flush();
}

/** A failed reply, whose throw is the turn loop's and is caught here [W6-15]. */
async function failQuietly(harness: Harness, index: number): Promise<void> {
  const capture = (): void => {};
  process.on('unhandledRejection', capture);
  try {
    harness.fail(index);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off('unhandledRejection', capture);
  }
  flush();
}

/** Open the record from the top bar, let focus land, and hand back the dialog. */
async function openRecord(screen: ReturnType<typeof render>): Promise<HTMLElement> {
  screen.getByRole('button', { name: 'Record' }).click();
  flush();
  await Promise.resolve();
  return screen.getByRole('dialog', { name: 'Game record' });
}

/**
 * The log, by its caption [W6-79]: the dialog holds a second table, the
 * graph's data, and only the name tells them apart.
 */
const LOG = 'Every move of this game';
function logOf(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByRole('table', { name: LOG });
}

/** The log's body rows as their cells' text. */
function rows(dialog: HTMLElement): string[][] {
  const table = logOf(dialog);
  return [...table.querySelectorAll('tbody tr')].map((tr) =>
    [...tr.querySelectorAll('th, td')].map((cell) => (cell.textContent ?? '').trim()),
  );
}

beforeEach(() => {
  vi.resetModules();
});

/**
 * A module for a pure function. Importing the record's components evaluates
 * a fresh state module, whose opening ask would reach for a real `Worker` if
 * the URL left over from the last test seats a computer first.
 */
async function pure<T>(load: () => Promise<T>): Promise<T> {
  history.replaceState({}, '', '/?seed=42&seating=human-human');
  return load();
}

describe('the record in the view model [W6-67], [W6-68]', () => {
  it('[W6-67] [W6-68] appends one record per ply, on a fresh array, from both seats and each kind of reply', async () => {
    // Seat 0 a tier, seat 1 the master: both seats, two kinds.
    const { state, harness } = await load('?seed=42&seating=easy-master');
    // Empty at the deal, and through the first `thinking` publish.
    expect(state.view().thinking).toEqual({ seat: 0 });
    expect(state.view().history).toEqual([]);

    const round = state.view().game.round;
    const first = await harness.answer(0, { value: 3.24 });
    const one = state.view().history;
    expect(one).toHaveLength(1);
    expect(one[0]).toEqual({
      ply: 1,
      round,
      seat: 0,
      action: first.action,
      level: 'easy',
      choice: first,
      estimate: state.estimateOf(3.24, 0, 'easy'),
      scoring: null,
    });
    // As it crossed the seam: the reply's own object, nothing added or dropped.
    expect(one[0].choice).toBe(first);

    const second = await harness.answer(1, { value: 0.24 });
    const two = state.view().history;
    expect(two).not.toBe(one);
    expect(one, 'a view model published earlier changed what it said').toHaveLength(1);
    expect(two[0]).toBe(one[0]);
    expect(two[1]).toMatchObject({ ply: 2, seat: 1, level: 'master', action: second.action, choice: second });
    expect(two[1].estimate).toEqual({ kind: 'chance', by: 1, level: 'master', chance: [38, 62] });
    holdsRecordInvariants(state, state.view(), 2);
  });

  it('[W6-68] records an expert reply whole, and nothing on a person\'s ply', async () => {
    const { state, harness } = await load('?seed=42&seating=human-human');
    // The expert is not offered while its gate withdraws it ([0008 A8-33]),
    // so it is seated directly: what is under test is the record of its reply.
    state.startWithSeating({ players: [null, 'expert'] });
    flush();
    personPlays(state);
    expect(state.view().history[0]).toMatchObject({ ply: 1, seat: 0, level: null, choice: null, estimate: null });
    const reply = await harness.answer(0);
    const record = state.view().history[1];
    expect(record.choice).toEqual({ action: reply.action, value: -0.5, simulations: 800, rootVisits: 412 });
    expect(record.estimate).toEqual({ kind: 'chance', by: 1, level: 'expert', chance: [75, 25] });
    // The person's next ply does not inherit the reply.
    personPlays(state);
    expect(state.view().history[2]).toMatchObject({ seat: 0, choice: null, estimate: null });
    holdsRecordInvariants(state, state.view(), 3);
  });

  it('[W6-67] is unchanged by a failed reply and by a stale one', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-human');
    await harness.answer(0);
    personPlays(state);
    const before = state.view().history;
    expect(before).toHaveLength(2);
    await failQuietly(harness, 1);
    expect(state.view().history).toBe(before);

    // A deal while a request is out: its late reply records nothing [W6-16].
    state.startNewGame();
    flush();
    expect(harness.pending).toHaveLength(3);
    state.startNewGame();
    flush();
    expect(harness.pending).toHaveLength(4);
    await harness.answer(2);
    expect(state.view().history, 'a stale reply was recorded').toEqual([]);
    await harness.answer(3);
    expect(state.view().history).toHaveLength(1);
  });

  it('[W6-67] is cleared by every kind of deal', async () => {
    const { state, harness } = await load('?seed=42&seating=easy-human');
    const deals: [string, () => void][] = [
      ['a new game', () => state.startNewGame()],
      ['a seating change', () => state.startWithSeating({ players: ['easy', null] })],
      ['a numbered deal', () => state.startWithSeating({ players: ['easy', null] }, 7)],
      ['a replay', () => state.replayDeal()],
    ];
    for (const [what, dealIt] of deals) {
      await harness.answer(harness.pending.length - 1);
      expect(state.view().history, `before ${what}`).toHaveLength(1);
      dealIt();
      flush();
      expect(state.view().history, `after ${what}`).toEqual([]);
    }
  });

  it('[W6-81] is the same, row for row, when the same game is played again', async () => {
    const play = async (): Promise<readonly PlyRecord[]> => {
      const { state, harness } = await load('?seed=9&seating=human-steady');
      let answered = 0;
      for (let plies = 0; plies < 60 && !state.view().game.isTerminal; plies++) {
        if (state.view().thinking !== null) await harness.answer(answered++, { value: plies / 3 });
        else personPlays(state);
      }
      return state.view().history;
    };
    const first = await play();
    const second = await play();
    expect(first.length).toBeGreaterThan(40);
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
  });
});

/**
 * A whole game against a tier with the record open throughout: the record
 * grows on the publish that carries each ply and on no other, the round
 * transition still publishes ([0003 U3-42]), one request per computer ply and
 * none for the record ([W6-69]), and a ply arriving under the open dialog
 * moves no focus ([W6-71]).
 */
describe('a whole game with the record open', () => {
  it('[W6-67] [W6-69] [W6-70] [W6-71] [W6-79] [W6-82] grows by one record per ply, transitions still published, focus kept', async () => {
    const { screen, state, harness } = await mount('?seed=42&seating=human-easy');
    const control = screen.getByRole('button', { name: 'Record' });
    const dialog = await openRecord(screen);
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    expect(within(dialog).getByText('No moves yet')).toBeTruthy();
    const { announcement } = await import('../src/components/Announcer.jsx');
    const live = screen.container.querySelector('[role="status"][aria-live]') as HTMLElement;

    let answered = 0;
    let plies = 0;
    const transitions = { person: 0, computer: 0 };
    const seen: (readonly PlyRecord[])[] = [];
    while (!state.view().game.isTerminal && plies < 400) {
      const before = state.view();
      let mover: 'person' | 'computer';
      if (before.thinking !== null) {
        // [W6-70]: present while a search is in flight.
        expect(control.isConnected).toBe(true);
        expect(harness.pending.length).toBe(answered + 1);
        expect(Object.keys(harness.pending[answered]).sort()).toEqual(['generation', 'position', 'tier']);
        await harness.answer(answered++, { value: (plies % 7) - 3 });
        mover = 'computer';
      } else {
        const asked = harness.pending.length;
        personPlays(state);
        expect(harness.pending.length - asked).toBe(state.view().thinking !== null ? 1 : 0);
        mover = 'person';
      }
      plies++;
      const after = state.view();
      expect(after.history).toHaveLength(plies);
      expect(after.history).not.toBe(before.history);
      // Earlier arrays still say what they said [0003 U3-21].
      seen.forEach((array, i) => expect(array).toHaveLength(i + 1));
      seen.push(after.history);
      const last = after.history[plies - 1];
      expect(last.seat).toBe(before.game.currentPlayer);
      expect(last.round).toBe(before.game.round);
      expect(last.choice !== null).toBe(mover === 'computer');
      if (after.game.round > before.game.round || (after.game.isTerminal && !before.game.isTerminal)) {
        expect(after.transition, 'a transition went unpublished').not.toBeNull();
        expect(last.scoring).toBe(after.scoring);
        transitions[mover]++;
      } else {
        expect(last.scoring).toBeNull();
      }
      holdsRecordInvariants(state, after, plies);
      // Focus stays where it was, in the dialog [W6-71].
      expect(document.activeElement).toBe(close);
      // [W6-79]: the announcement is the view's own, nothing of the record in it.
      expect(live.textContent).toBe(announcement(after));
    }
    expect(state.view().game.isTerminal).toBe(true);
    expect(transitions.person).toBeGreaterThan(0);
    expect(transitions.computer).toBeGreaterThan(0);

    // The log, live: a row per ply and one per round scored.
    const scored = state.view().history.filter((r) => r.scoring !== null).length;
    expect(rows(dialog)).toHaveLength(plies + scored);

    // [W6-70]: still there at the end of the game, and focus goes back to it.
    within(dialog).getByRole('button', { name: 'Close' }).click();
    flush();
    await Promise.resolve();
    expect(screen.queryByRole('dialog', { name: 'Game record' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Record' }));
  }, 30_000);
});

describe('the control and the dialog [W6-70], [W6-71], [W6-72]', () => {
  it('[W6-70] [W6-71] [W6-72] opens from the top bar, leaves nothing when closed, and closes by Close, Escape and a press outside', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { screen } = await mount('?seed=42&seating=human-human');
    const url = location.href;
    const control = screen.getByRole('button', { name: 'Record' });
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    expect(control.closest('.topbar')).not.toBeNull();
    // Closed by default: no dialog, and nothing of it in the document.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.container.querySelector('.record, .record-log, .graph')).toBeNull();

    const closers: [string, (dialog: HTMLElement) => void][] = [
      ['Close', (d) => within(d).getByRole('button', { name: 'Close' }).click()],
      ['Escape', (d) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
      ['a press outside', (d) => (d.parentElement as HTMLElement).click()],
    ];
    for (const [what, closeIt] of closers) {
      const dialog = await openRecord(screen);
      expect(document.activeElement, `focus on opening, before ${what}`).toBe(
        within(dialog).getByRole('button', { name: 'Close' }),
      );
      // The page beneath is inert while it is open.
      expect(control.closest('.stage')?.hasAttribute('inert')).toBe(true);
      closeIt(dialog);
      flush();
      await Promise.resolve();
      expect(screen.queryByRole('dialog'), `still open after ${what}`).toBeNull();
      expect(document.activeElement, `focus after ${what}`).toBe(control);
      expect(control.closest('.stage')?.hasAttribute('inert')).toBe(false);
    }
    // Nothing kept: no storage, no URL.
    expect(setItem).not.toHaveBeenCalled();
    expect(location.href).toBe(url);
    setItem.mockRestore();
  });

  it('[W6-72] closes on a deal made while it is open, and is closed on a fresh mount', async () => {
    const { screen, state } = await mount('?seed=42&seating=human-human');
    personPlays(state);
    await openRecord(screen);
    // The interface offers no deal while it is open; this deal is code's.
    state.startNewGame();
    flush();
    expect(screen.queryByRole('dialog', { name: 'Game record' })).toBeNull();
    screen.unmount();

    const again = await mount('?seed=42&seating=human-human');
    expect(again.screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the log [W6-74] through [W6-79]', () => {
  it('[W6-74] [W6-75] [W6-76] [W6-79] reads each kind of computer row, as a table with headers', async () => {
    const { screen, state, harness } = await mount('?seed=42&seating=easy-master');
    await harness.answer(0, { value: 3.24, depth: 4, nodes: 12_345, complete: true, curtailed: true });
    await harness.answer(1, { value: 0.24, simulations: 10_000 });
    const names = state.view().game.colorNames;
    const { lastMoveText } = await import('../src/components/PlayerBoard.jsx');
    const dialog = await openRecord(screen);

    const table = logOf(dialog);
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Ply',
      'Round',
      'Player',
      'Move',
      'Estimate',
      'Search',
    ]);
    expect(within(table).getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['1', '2']);
    const [h0, h1] = state.view().history;
    expect(rows(dialog)).toEqual([
      ['1', '1', 'Player 1 (gentle)', lastMoveText(h0.action, names), 'Ahead by 3 points / Behind by 3 points', 'value +3.2 points, depth 4, 12,345 nodes, complete, curtailed'],
      ['2', '1', 'Player 2 (master)', lastMoveText(h1.action, names), '38% / 62%', '10,000 simulations'],
    ]);
    // [W6-79]: nothing live in it, and no part of the announcement.
    expect(dialog.querySelector('[role="status"], [aria-live]')).toBeNull();
    const live = document.querySelector('[role="status"][aria-live]');
    expect(live?.textContent ?? '').not.toMatch(/simulations|nodes|Ply/);
  });

  it('[W6-76] words a tier\'s value whole, fractional, negative, as zero and decided; and each report form', async () => {
    const { searchWords, valueText } = await pure(() => import('../src/components/Record.jsx'));
    const { WIN } = await pure(() => import('../src/game.js'));
    expect(valueText(12)).toBe('+12');
    expect(valueText(3.24)).toBe('+3.2');
    expect(valueText(-7.5)).toBe('−7.5');
    expect(valueText(-0.04)).toBe('0.0');
    expect(valueText(0)).toBe('0');
    expect(valueText(1234.5)).toBe('+1,234.5');
    expect(valueText(WIN + 12)).toBe('+1,000,012');
    expect(valueText(-WIN - 7)).toBe('−1,000,007');
    const tier: Choice = { action: 0, value: -2, depth: 3, nodes: 1500, complete: false, curtailed: false };
    expect(searchWords(tier, 'sharp')).toBe('value −2 points, depth 3, 1,500 nodes');
    expect(searchWords({ ...tier, complete: true }, 'steady')).toBe('value −2 points, depth 3, 1,500 nodes, complete');
    expect(searchWords({ ...tier, curtailed: true }, 'sharp')).toBe('value −2 points, depth 3, 1,500 nodes, curtailed');
    expect(searchWords({ action: 0, value: 0.1, simulations: 800, rootVisits: 412 }, 'expert')).toBe(
      '800 simulations, 412 root visits',
    );
    expect(searchWords({ action: 0, value: 0.1, simulations: 200_000 }, 'master')).toBe('200,000 simulations');
  });

  it('[W6-75] gives both sides of each kind, a decided lead each way', async () => {
    const { estimateCell } = await pure(() => import('../src/components/Record.jsx'));
    const { estimateOf, WIN } = await pure(() => import('../src/game.js'));
    const players = [null, 'sharp'] as const;
    expect(estimateCell(estimateOf(0.24, 1, 'master'), [null, 'master'])).toBe('38% / 62%');
    expect(estimateCell(estimateOf(2.4, 1, 'sharp'), players)).toBe('Behind by 2 points / Ahead by 2 points');
    expect(estimateCell(estimateOf(0.2, 1, 'sharp'), players)).toBe('Even / Even');
    expect(estimateCell(estimateOf(WIN + 3, 1, 'sharp'), players)).toBe('A loss by 3 points / A win by 3 points');
    expect(estimateCell(estimateOf(-WIN - 1, 1, 'sharp'), players)).toBe('A win by 1 point / A loss by 1 point');
    expect(estimateCell(estimateOf(WIN, 0, 'sharp'), players)).toBe('A win on the tie-break / A loss on the tie-break');
  });

  it('[W6-78] says each seat\'s round from its own entry, bonuses on the last', async () => {
    const { roundWords } = await pure(() => import('../src/components/Record.jsx'));
    const player = (scoreBefore: number, scoreAfterRound: number) => ({ scoreBefore, scoreAfterRound });
    const scoring = { round: 1, players: [player(7, 15), player(4, 9)], bonuses: null } as unknown as RoundScoring;
    expect(roundWords(scoring)).toBe('Round 2 scored: Player 1: 7 to 15; Player 2: 4 to 9');
    const bonus = (total: number, scoreAfter: number) => ({ total, scoreAfter });
    const last = {
      round: 4,
      players: [player(30, 33), player(41, 40)],
      bonuses: [bonus(12, 45), bonus(0, 40)],
    } as unknown as RoundScoring;
    expect(roundWords(last)).toBe(
      'Round 5 scored: Player 1: 30 to 33, bonuses +12, final 45; Player 2: 41 to 40, bonuses 0, final 40',
    );
  });

  it('[W6-74] [W6-77] [W6-78] logs a game of two people: moves, round rows, no estimate or report', async () => {
    const { screen, state } = await mount('?seed=42&seating=human-human');
    const { roundWords } = await pure(() => import('../src/components/Record.jsx'));
    while (state.view().scoring === null) personPlays(state);
    const plies = state.view().history.length;
    const dialog = await openRecord(screen);
    const logged = rows(dialog);
    expect(logged).toHaveLength(plies + 1);
    for (const row of logged.slice(0, plies)) {
      expect(row[2]).toMatch(/^Player [12] \(Person\)$/);
      expect(row[4]).toBe('');
      expect(row[5]).toBe('');
    }
    // The round row comes after the ply that scored it, one cell across.
    expect(logged[plies]).toEqual([roundWords(state.view().scoring!)]);
    const cell = logOf(dialog).querySelector('tbody tr:last-child td') as HTMLTableCellElement;
    expect(cell.colSpan).toBe(6);
    expect(logged[plies][0]).toMatch(/^Round 1 scored: Player 1: 0 to \d+; Player 2: 0 to \d+$/);
  });
});

/**
 * [W6-80]: the report's fields reach the screen through the record alone.
 * [W6-25]'s source check in `source.test.ts` already keeps `lastChoice` out of
 * every component; this one keeps the reply's types and fields out of every
 * component but the record's. It claims only the forms below, each with a
 * source it rejects.
 */
describe('the report renders nowhere else [W6-80]', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const COMPONENTS = join(HERE, '..', 'src', 'components');
  const FORMS = /\b(?:Choice|ExpertChoice|MasterChoice|rootVisits|curtailed)\b|\.(?:depth|nodes|complete|choice)\b|\blastChoice\b/g;
  const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const offences = (code: string): string[] => strip(code).match(FORMS) ?? [];

  it('[W6-80] rejects each form it claims', () => {
    expect(offences('import type { MasterChoice } from "../opponent.js";')).toEqual(['MasterChoice']);
    expect(offences('<td>{props.record.choice.nodes}</td>')).toEqual(['.choice', '.nodes']);
    expect(offences('const d = r.depth; const v = c.rootVisits; c.curtailed; c.complete')).toEqual([
      '.depth',
      'rootVisits',
      'curtailed',
      '.complete',
    ]);
    expect(offences('view().lastChoice')).toEqual(['lastChoice']);
  });

  it('[W6-80] finds none outside the record, and the record reads no lastChoice', () => {
    for (const file of readdirSync(COMPONENTS)) {
      const code = readFileSync(join(COMPONENTS, file), 'utf8');
      const found = offences(code);
      if (file === 'Record.tsx') expect(found.filter((f) => f === 'lastChoice'), file).toEqual([]);
      else expect(found, file).toEqual([]);
    }
  });
});
