/**
 * The workings [U3-82] through [U3-85], and the bonus half of [U3-46].
 *
 * Two halves, tested two ways. The *slot* is a property of a history — it
 * persists across plies and a deal clears it — so it is driven through the
 * state module, playing real games. The *panel* is a component handed a record,
 * so it is driven from posed props, including a record whose numbers disagree
 * with each other: that is the only way to tell a view that reads its input
 * apart from one that recomputes it and happens to agree.
 */

import { render, within } from '@solidjs/testing-library';
import type { RoundScoring } from 'engine';
import { flush } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameOver } from '../src/components/GameOver.jsx';
import { Scoring } from '../src/components/Scoring.jsx';
import { endedGame } from './fixtures.js';

type Game = typeof import('../src/game.js');

async function load(search = ''): Promise<Game> {
  history.replaceState({}, '', `/${search}`);
  vi.resetModules();
  return import('../src/game.js');
}

/** Play one ply with whatever the engine says is legal, and commit the write. */
function step(game: Game, pick = 0): void {
  game.submit(game.view().game.legalActions[pick]);
  flush();
}

/** Play until `stop` says so, or the game ends. */
function playUntil(game: Game, stop: () => boolean, limit = 400): void {
  for (let ply = 0; ply < limit; ply++) {
    if (stop() || game.view().game.isTerminal) return;
    step(game);
  }
  throw new Error('nothing scored within the ply limit');
}

let randomSeed = 0;
beforeEach(() => {
  randomSeed = 0;
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array: ArrayBufferView<ArrayBuffer>) => {
    (array as Uint32Array)[0] = randomSeed;
    return array;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('the sticky slot [U3-82], [U3-83]', () => {
  it('[U3-82] is null until a round scores, and then carries that round', async () => {
    const game = await load('?seed=42');
    expect(game.view().scoring, 'workings before anything scored').toBeNull();

    playUntil(game, () => game.view().scoring !== null);
    const scoring = game.view().scoring;
    expect(scoring, 'no round scored').not.toBeNull();
    // The round it describes is the one that just ended, not the one now being
    // played [0007 S7-13] — the published game has already moved on.
    expect(scoring!.round).toBe(game.view().game.round - 1);
    expect(game.view().transition, 'the transition ply carries both').not.toBeNull();
  });

  /**
   * The difference between this and `transition`, which is the whole reason
   * [U3-82] exists as a separate field: `transition` is null on the very next
   * ply [U3-42], and the workings are still there.
   */
  it('[U3-82] persists across plies, and is replaced only by a later record', async () => {
    const game = await load('?seed=42');
    playUntil(game, () => game.view().scoring !== null);
    const first = game.view().scoring!;

    step(game);
    expect(game.view().transition, 'the transition did not clear [U3-42]').toBeNull();
    expect(game.view().scoring, 'the workings cleared with the transition').toBe(first);
    step(game);
    step(game);
    expect(game.view().scoring).toBe(first);

    // And a later round replaces it — the slot holds the *most recent* record.
    playUntil(game, () => game.view().scoring !== first);
    const second = game.view().scoring!;
    expect(second).not.toBe(first);
    expect(second.round).toBe(first.round + 1);
  });

  /**
   * [U3-83], and it needs two games to see: within one game the slot is only
   * ever replaced, so a missing reset shows up exclusively at the moment a new
   * game is dealt — with the previous game's arithmetic sitting under a fresh
   * board for however long the first round takes.
   */
  it('[U3-83] a new game clears it', async () => {
    const game = await load('?seed=42');
    playUntil(game, () => game.view().scoring !== null);
    expect(game.view().scoring).not.toBeNull();

    randomSeed = 99;
    game.startNewGame();
    flush();
    expect(game.view().seed, 'the new game was not dealt').toBe(99);
    expect(game.view().scoring, "the new game shows the old game's workings").toBeNull();
    expect(game.view().game.round).toBe(0);
  });

  it('[U3-82] carries the bonus half on the ply that ends the game', async () => {
    const game = await load('?seed=42');
    playUntil(game, () => game.view().game.isTerminal);
    expect(game.view().game.isTerminal).toBe(true);
    const scoring = game.view().scoring!;
    expect(scoring.bonuses, 'the terminal record carried no bonuses').not.toBeNull();
    // [0007 S7-27]: the final score is the record's, with nothing left over.
    for (const p of [0, 1]) {
      expect(game.view().game.players[p].score).toBe(scoring.bonuses![p].scoreAfter);
    }
  });
});

/**
 * A record nothing in the engine would ever produce: **every** number in it
 * disagrees with the number a panel would compute for itself.
 *
 * That is [U3-84] made observable, and there is no other way to observe it —
 * against a real record a panel that reads and a panel that recomputes agree
 * everywhere. Which means the fixture is only as good as its disagreements,
 * and an earlier version of it was not good at all: its second placement had
 * `points === h + v`, so rendering `h + v` instead of `points` — the exact
 * [0007 S7-10] confusion the engine spec calls "the only position where the
 * two readings differ" — passed the whole suite. Its bonus half was fully
 * self-consistent (`2 = 2 × 1`, `14 = 7 × 2`, `30 = 10 × 3`, `46` their sum),
 * so a panel doing [0001 E1-38] itself passed too, and a review mutation that
 * did exactly that ran green through this file.
 *
 * So: no number here is derivable from its neighbours. `tiling` is not the sum
 * of the placements' points; `penalty` is not the sum of the rungs; each
 * placement's `points` is neither `h + v` nor `1`; each bonus count times its
 * rate is not its points; `total` is not their sum; `scoreAfter` is not
 * `scoreBefore + total`. Every value is also distinct from every other value
 * on screen, so a substring assertion cannot pass by matching a different
 * number.
 */
const INCONSISTENT: RoundScoring = {
  round: 3,
  players: [
    {
      placements: [
        // Landed alone, and worth 23 rather than the 1 that [0001 E1-24] would
        // give it or the 2 that `h + v` would.
        { row: 0, col: 0, h: 1, v: 1, points: 23 },
        // Two real runs, and worth 41 rather than the 5 that `h + v` would.
        { row: 2, col: 3, h: 3, v: 2, points: 41 },
      ],
      tiling: 99,
      floor: { occupied: 9, rungs: [-1, -1, -2, -2, -2, -3, -3], markerHeld: true, penalty: -77 },
      scoreBefore: 10,
      scoreAfterRound: 40,
      forgiven: 4,
    },
    {
      placements: [],
      tiling: 0,
      floor: { occupied: 0, rungs: [], markerHeld: false, penalty: 0 },
      scoreBefore: 7,
      scoreAfterRound: 7,
      forgiven: 0,
    },
  ],
  bonuses: [
    {
      // Every itemised figure disagrees with `count × rate` [0001 E1-38]: one
      // row is not 2, two columns are not 14, three colours are not 30, and
      // the total is not their sum.
      rows: 1,
      cols: 2,
      colors: 3,
      rowPoints: 51,
      colPoints: 52,
      colorPoints: 53,
      total: 61,
      scoreBefore: 40,
      scoreAfter: 1000,
    },
    {
      rows: 0,
      cols: 0,
      colors: 0,
      rowPoints: 0,
      colPoints: 0,
      colorPoints: 0,
      total: 0,
      scoreBefore: 7,
      scoreAfter: 7,
    },
  ],
};

const NAMES = ['blue', 'yellow', 'red', 'black', 'teal'];
const PLAYERS = ['Player 1', 'Player 2'];

function panel(scoring: RoundScoring = INCONSISTENT): HTMLElement {
  const { getByRole } = render(() => (
    <Scoring scoring={scoring} names={NAMES} playerNames={PLAYERS} />
  ));
  return getByRole('region', { name: 'How the last round scored' });
}

describe('the panel [U3-84], [U3-85]', () => {
  it('[U3-84] shows the record’s own numbers, even where they disagree', () => {
    const shown = panel();
    // The sums it does not compute: 99 rather than 1 + 5, and -77 rather than
    // the ladder's -14.
    expect(shown).toHaveTextContent('Tiles placed +99');
    expect(shown).toHaveTextContent('Floor penalty -77');
    // The score line is read, not derived: 10 to 40 with 4 forgiven is not an
    // equation that balances, and the panel has no opinion about that.
    expect(shown).toHaveTextContent('Score 10 to 40');
    expect(shown).toHaveTextContent('4 forgiven');
    // And the bonus half likewise, itemised figure by itemised figure: one
    // completed row earned 51 here, and a panel doing [0001 E1-38] for itself
    // would say 2. The totals are the record's for the same reason — 61, not
    // the sum of anything on screen, and a final score of 1000, whatever
    // 40 + 61 comes to.
    const bonuses = [...shown.querySelectorAll('.bonus-lines')][0];
    expect(bonuses).toHaveTextContent('1 completed rows: +51');
    expect(bonuses).toHaveTextContent('2 completed columns: +52');
    expect(bonuses).toHaveTextContent('3 completed colours: +53');
    expect(shown).toHaveTextContent('Bonuses +61, final score 40 to 1000');
  });

  it('[U3-84] itemises each placement: where it landed, its runs, and what it earned', () => {
    const shown = panel();
    expect(shown).toHaveTextContent('Row 1, column 1, blue');
    expect(shown).toHaveTextContent('on its own');
    // The second tile: row index 2, column index 3 is yellow on the fixed wall
    // — `wallColorAt(2, 3)` — and the runs are shown as the record gives them,
    // not multiplied out [0001 E1-1].
    expect(shown).toHaveTextContent('Row 3, column 4, yellow');
    expect(shown).toHaveTextContent('row run of 3');
    expect(shown).toHaveTextContent('column run of 2');

    // The points, read off the element that carries them rather than searched
    // for in the region's whole text. `toHaveTextContent('+1')` matched inside
    // the `+14` of a bonus line and asserted nothing; an exact read of the
    // element is what makes the two numbers below the record's own.
    const points = [...shown.querySelectorAll('.placement-points')].map((el) => el.textContent);
    expect(points, 'the placement points are not the record’s').toEqual(['+23', '+41']);
  });

  it('[U3-85] shows the floor as a ladder of charged rungs, with the marker called out', () => {
    const { getAllByRole, getByRole } = render(() => (
      <Scoring scoring={INCONSISTENT} names={NAMES} playerNames={PLAYERS} />
    ));
    const ladder = getAllByRole('list', { name: 'floor penalty by slot' })[0];
    const rungs = ladder.querySelectorAll('li');
    // One entry per rung the record says was charged, in ladder order.
    expect(rungs).toHaveLength(INCONSISTENT.players[0].floor.rungs.length);
    expect(rungs[0]).toHaveTextContent('Slot 1: -1');
    expect(rungs[6]).toHaveTextContent('Slot 7: -3');
    const shown = getByRole('region', { name: 'How the last round scored' });
    expect(shown).toHaveTextContent('9 slots, 7 of them charged');
    expect(shown).toHaveTextContent('the first-player marker among them');
    expect(shown).toHaveTextContent('the rest are past the last slot and cost nothing');
  });

  it('[U3-85] attributes no rung to a tile', () => {
    // The placements list and the ladder are separate lists, and no placement
    // line carries a penalty: the floor is a per-colour count and a marker flag
    // [0001 E1-3], so there is no order to attribute a rung by [0007 S7-16].
    const shown = panel();
    for (const placement of shown.querySelectorAll('.placement')) {
      expect(placement.textContent).not.toMatch(/-\d/);
    }
    expect(shown.querySelectorAll('.placement')).toHaveLength(2);
    // Structurally, too: no rung is rendered inside a placement, and the
    // ladder is one entry per charged slot beside them.
    expect(shown.querySelectorAll('.placement .rung')).toHaveLength(0);
    expect(shown.querySelectorAll('.scoring-player .rungs .rung').length).toBe(
      INCONSISTENT.players[0].floor.rungs.length,
    );
  });

  it('says so when a player completed no line at all', () => {
    const shown = panel();
    expect(shown).toHaveTextContent('No pattern line was complete');
  });
});

describe('the end-of-game bonuses [U3-46]', () => {
  it('[U3-46] itemises what each count earned, from the record', () => {
    const game = endedGame();
    const { getByRole } = render(() => (
      <GameOver game={game} names={NAMES} bonuses={INCONSISTENT.bonuses} />
    ));
    const panelEl = getByRole('region', { name: 'Final result' });
    // One fact, one source: where there is a record, both the counts and the
    // points beside them are read from it. The posed game view says every
    // count is zero, and the record says one row, two columns, three colours —
    // a screen reading "0 completed rows ... bonuses: rows 51" would be two
    // answers to the same question, which is what taking them from two places
    // produces.
    expect(panelEl).toHaveTextContent(
      'Player 1: 50 points, 1 completed rows, 2 completed columns, 3 completed colours',
    );
    expect(panelEl).toHaveTextContent('bonuses: rows 51, columns 52, colours 53, total 61');
  });

  it('[U3-46] shows the counts alone when there is no record to read', () => {
    const game = endedGame();
    const { getByRole } = render(() => <GameOver game={game} names={NAMES} bonuses={null} />);
    const panelEl = getByRole('region', { name: 'Final result' });
    expect(panelEl).toHaveTextContent('completed colours');
    expect(panelEl.textContent).not.toContain('bonuses:');
  });
});

/**
 * The join between the two halves above [U3-82].
 *
 * The slot is tested through the state module and the panel is tested from
 * posed props, and neither of those notices if the app never puts one into the
 * other: review deleted the `<Show when={view().scoring}>` block from
 * `App.tsx` and the whole suite stayed green. So this mounts the real
 * interface, plays until a round scores, and looks for the panel on screen.
 */
describe('[U3-82] the interface renders the workings it is published', () => {
  async function mount(): Promise<{ screen: ReturnType<typeof render>; game: Game }> {
    history.replaceState({}, '', '/?seed=42');
    vi.resetModules();
    const { App } = await import('../src/components/App.jsx');
    const game = await import('../src/game.js');
    return { screen: render(() => <App />), game };
  }

  it('shows nothing before a round has scored, and the round after it has', async () => {
    const { screen, game } = await mount();
    expect(game.view().scoring, 'a fresh game has workings').toBeNull();
    expect(screen.queryByRole('region', { name: 'How the last round scored' })).toBeNull();

    playUntil(game, () => game.view().scoring !== null);
    const scoring = game.view().scoring!;
    const shown = screen.getByRole('region', { name: 'How the last round scored' });

    // It is *this* record on screen, not a panel that happens to be there: the
    // round it names and one of the numbers only the record knows.
    expect(shown).toHaveTextContent(`Round ${scoring.round + 1} scoring`);
    const seat = within(shown).getByRole('region', { name: 'Player 1 scoring' });
    expect(seat).toHaveTextContent(
      `Score ${scoring.players[0].scoreBefore} to ${scoring.players[0].scoreAfterRound}`,
    );

    // And it is still there a ply later, which is the sticky lifetime seen
    // through the DOM rather than through the view model [U3-42].
    step(game);
    expect(screen.getByRole('region', { name: 'How the last round scored' })).toBeTruthy();
  });
});
