/**
 * The property test [U3-70]: complete games played through the *rendered*
 * interface, choosing uniformly at random among the controls that are actually
 * available, with every position checked against an engine state driven in
 * parallel.
 *
 * This is what makes [U3-48] and [U3-51] observable. The source check is a
 * bounded matcher and cannot decide whether code contains a rule — a view-side
 * re-implementation of [0001 E1-10] reading only view-model fields would pass
 * every one of its clauses. This test disagrees with such an interface at the
 * first position where the copy is wrong.
 *
 * Both the game seeds and the choice stream are fixed and recorded, and a
 * failure reports them: a property failure nobody can reproduce is a property
 * failure nobody can fix.
 */

import { render, within } from '@solidjs/testing-library';
import type { AzulJSON, AzulState } from 'engine';
import { CENTER, FLOOR, NUM_COLORS, NUM_ROWS, Rng, apply, decodeAction, encodeAction, newGame, toJSON } from 'engine';
import { flush } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { pickName, picksIn } from '../src/components/Displays.jsx';
import { floorLineName } from '../src/components/FloorLine.jsx';
import { patternLineName } from '../src/components/PatternLines.jsx';

/** Recorded, so every run plays the same games. */
const GAME_SEEDS = [7, 1337, 90210];
const CHOICE_SEED = 20260905;
/** No lawful two-player game runs anywhere near this long. */
const PLY_LIMIT = 400;

const DESTINATIONS = [...Array(NUM_ROWS).keys(), FLOOR];

type Screen = ReturnType<typeof render>;

/** Uniform over `0..n-1`, from the engine's own generator so the stream replays. */
function uniform(rng: Rng, n: number): number {
  return rng.next() % n;
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

/**
 * The rendered universe of source controls [U3-79]: one per `(source, colour)`
 * group whose pool actually holds a tile of that colour.
 */
function renderedPicks(game: AzulJSON): { source: number; color: number; count: number }[] {
  return [
    ...game.factories.flatMap((pool, source) => picksIn(pool, source)),
    ...picksIn(game.center, CENTER),
  ];
}

const availableOf = (control: HTMLElement): boolean =>
  control.getAttribute('aria-disabled') === 'false';

/**
 * Every button on screen, indexed by its accessible name.
 *
 * Still role-and-name addressing [U3-68] — a control this cannot find is a
 * control [U3-54] has not labelled — but taken once per position instead of
 * once per control. A game is around 150 plies and a position offers around
 * twenty controls; querying each one separately costs more than the rest of
 * the suite put together.
 */
function controls(screen: Screen): Map<string, HTMLElement> {
  const index = new Map<string, HTMLElement>();
  for (const button of screen.getAllByRole('button')) {
    index.set(button.getAttribute('aria-label') ?? button.textContent ?? '', button);
  }
  return index;
}

function control(index: Map<string, HTMLElement>, name: string): HTMLElement {
  const found = index.get(name);
  if (!found) throw new Error(`no control named ${JSON.stringify(name)} on screen`);
  return found;
}

function destName(game: AzulJSON, state: AzulState, dest: number): string {
  const p = game.currentPlayer;
  return dest === FLOOR
    ? floorLineName(occupied(state, p), game.players[p].floorPenalty)
    : patternLineName(game.players[p].patternLines[dest], dest, game.colorNames);
}

/** `floorOccupied` for the parallel state, taken from the engine [U3-4]. */
function occupied(state: AzulState, p: number): number {
  let n = state.floorMarker[p] ? 1 : 0;
  for (let c = 0; c < NUM_COLORS; c++) n += state.floor[p][c];
  return n;
}

async function mount(seed: number): Promise<Screen> {
  history.replaceState({}, '', `/?seed=${seed}&seating=human-human`);
  vi.resetModules();
  const { App } = await import('../src/components/App.jsx');
  return render(() => <App />);
}

describe('[U3-70] complete games played through the rendered interface', () => {
  it.each(GAME_SEEDS)('agrees with the engine at every position, seed %i', async (seed) => {
    const screen = await mount(seed);
    // The oracle: the same deal, driven by the engine alone.
    const state = newGame(seed);
    const rng = new Rng(CHOICE_SEED);
    const where = (ply: number, note: string): string =>
      `game seed ${seed}, choice seed ${CHOICE_SEED}, ply ${ply}: ${note}`;

    let ply = 0;
    for (; ply < PLY_LIMIT && !state.isTerminal; ply++) {
      const game = toJSON(state);

      // [U3-61] at rest: over the rendered universe of [U3-79], the available
      // selection controls are exactly the pairs some legal action mentions.
      const open = legalPairs(game);
      const rendered = renderedPicks(game);
      const atRest = controls(screen);
      const offered: typeof rendered = [];
      for (const pick of rendered) {
        const isAvailable = availableOf(control(atRest, pickName(pick, game.colorNames)));
        expect(isAvailable, where(ply, `pair ${pick.source},${pick.color}`)).toBe(
          open.has(`${pick.source},${pick.color}`),
        );
        if (isAvailable) offered.push(pick);
      }
      expect(offered, where(ply, 'no pair on offer in a non-terminal position')).not.toHaveLength(
        0,
      );

      const chosen = offered[uniform(rng, offered.length)];
      control(atRest, pickName(chosen, game.colorNames)).click();
      flush();

      // [U3-62] under a selection: the available destinations encode exactly the
      // legal actions with this source and colour.
      const legal = new Set(game.legalActions);
      const selected = controls(screen);
      const reachable: number[] = [];
      for (const dest of DESTINATIONS) {
        const isAvailable = availableOf(control(selected, destName(game, state, dest)));
        expect(isAvailable, where(ply, `dest ${dest} for ${chosen.source},${chosen.color}`)).toBe(
          legal.has(encodeAction(chosen.source, chosen.color, dest)),
        );
        if (isAvailable) reachable.push(dest);
      }
      // Never empty: the floor is always available while tiles are [0001 E1-12].
      expect(reachable, where(ply, 'a selection with nowhere to go')).toContain(FLOOR);

      const dest = reachable[uniform(rng, reachable.length)];
      control(selected, destName(game, state, dest)).click();
      flush();
      apply(state, encodeAction(chosen.source, chosen.color, dest));
    }

    expect(state.isTerminal, where(ply, 'the game never ended')).toBe(true);

    // [U3-47]: a terminal position has no legal actions, so nothing is on offer.
    const final = toJSON(state);
    const ended = controls(screen);
    expect(final.legalActions).toEqual([]);
    for (const pick of renderedPicks(final)) {
      expect(
        availableOf(control(ended, pickName(pick, final.colorNames))),
        where(ply, 'offered after the end'),
      ).toBe(false);
    }
    expect(screen.getByRole('button', { name: 'New game' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Final result' })).getByText(/wins|draw/i),
    ).toBeInTheDocument();
  });
});
