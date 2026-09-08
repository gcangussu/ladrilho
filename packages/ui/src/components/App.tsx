import type { JSX } from '@solidjs/web';
import { decodeAction, encodeAction } from 'engine';
import { Show, createEffect, createSignal } from 'solid-js';
import { computerSeat, startNewGame, startWithSeating, submit, view } from '../game.js';
import { Announcer, announcement } from './Announcer.jsx';
import { Displays, type Pick } from './Displays.jsx';
import { GameOver } from './GameOver.jsx';
import { PlayerBoard } from './PlayerBoard.jsx';
import { Seating } from './Seating.jsx';
import { Status } from './Status.jsx';

/**
 * The whole interface, and the only component that reads the published view
 * model [U3-6]; everything below it is handed plain data as props, which is
 * also what lets the tests pose a view directly for the endings random play
 * cannot reach [U3-44], [U3-45].
 *
 * A turn is two steps [U3-22]: pick a `(source, colour)`, then pick where it
 * goes. Both halves ask `legalActions` and nothing else [U3-48] — the first by
 * asking which pairs any legal action mentions, the second by asking whether
 * this exact action is in the list. Neither looks at a pattern line's capacity
 * or colour, which is [0001 E1-10] and belongs to the engine.
 */
export function App(): JSX.Element {
  const game = (): ReturnType<typeof view>['game'] => view().game;
  const names = (): string[] => game().colorNames;

  const [selection, setSelection] = createSignal<Pick | null>(null);
  let root!: HTMLElement;
  /** The group that last held focus, so [U3-57] can find its way back. */
  let lastGroup = 'factories';

  const legal = (): Set<number> => new Set(game().legalActions);

  /**
   * The `(source, colour)` pairs some legal action mentions [U3-23], [U3-61].
   *
   * Filtering a list the engine produced, not deciding what belongs in it —
   * which is the line [U3-3] draws, and which side of it this is on.
   */
  const pairs = (): Set<string> => {
    const open = new Set<string>();
    for (const action of game().legalActions) {
      const [source, color] = decodeAction(action);
      open.add(`${source},${color}`);
    }
    return open;
  };

  /**
   * Is it a person's turn at all [W6-22]?
   *
   * While the seat to move is a tier every move control is unavailable — under
   * [U3-29]'s discipline, so it stays present, focusable and `aria-disabled`
   * rather than vanishing. The new-game control is deliberately not a move
   * control ([U3-79]) and stays live throughout [W6-23], which is the player's
   * way out of a long think.
   */
  const humanToMove = (): boolean =>
    !game().isTerminal && !computerSeat(game().currentPlayer);

  const pickAvailable = (source: number, color: number): boolean =>
    humanToMove() && pairs().has(`${source},${color}`);

  /** A destination is available when this exact action is legal [U3-24], [U3-62]. */
  const destAvailable = (dest: number): boolean => {
    const picked = selection();
    return (
      humanToMove() && picked !== null && legal().has(encodeAction(picked.source, picked.color, dest))
    );
  };

  const choosePick = (picked: Pick): void => {
    // An unavailable control does nothing when activated [U3-29].
    if (!pickAvailable(picked.source, picked.color)) return;
    const current = selection();
    const same = current?.source === picked.source && current?.color === picked.color;
    // The same pair again clears; a different one replaces [U3-26]. Neither
    // touches the game [U3-27].
    setSelection(same ? null : picked);
  };

  const chooseDest = (dest: number): void => {
    const picked = selection();
    if (picked === null || !destAvailable(dest)) return;
    // Immediately, with no intervening step [U3-25]. The selection is cleared by
    // the per-ply effect below, which covers every path a ply can arrive by.
    submit(encodeAction(picked.source, picked.color, dest));
  };

  const destinations = (player: number): { available: typeof destAvailable; onChoose: typeof chooseDest } | null =>
    !game().isTerminal && game().currentPlayer === player
      ? { available: destAvailable, onChoose: chooseDest }
      : null;

  /**
   * A selection never survives a ply [U3-28], [U3-64], and focus is never lost
   * across one [U3-57].
   *
   * Keyed on the published view model, so it holds however the ply arrived —
   * a click, a key, or a new game — rather than only on the paths that
   * remembered to clear up after themselves.
   */
  createEffect(
    () => view(),
    () => {
      setSelection(null);
      if (document.activeElement === null || document.activeElement === document.body) {
        const group = root.querySelector<HTMLElement>(`[data-group="${lastGroup}"]`);
        group?.querySelector<HTMLElement>('[data-roving]')?.focus();
      }
    },
  );

  return (
    <main
      class="app"
      aria-label="Azul"
      ref={root}
      // Escape clears a selection wherever focus happens to be [U3-26].
      onKeyDown={(event) => {
        if (event.key === 'Escape') setSelection(null);
      }}
      onFocusIn={(event) => {
        const group = (event.target as HTMLElement).closest<HTMLElement>('[data-group]');
        if (group) lastGroup = group.dataset['group'] ?? lastGroup;
      }}
    >
      <h1>Azul</h1>
      <Announcer message={announcement(view())} />
      <Status
        game={game()}
        seed={view().seed}
        names={names()}
        thinking={view().thinking}
      />
      <Seating seating={view().seating} onChoose={(next) => startWithSeating(next)} />

      <Show when={game().isTerminal}>
        <GameOver game={game()} names={names()} />
      </Show>

      <Displays
        game={game()}
        names={names()}
        selection={selection()}
        available={pickAvailable}
        onChoose={choosePick}
      />

      <div class="boards">
        <PlayerBoard
          name="Player 1"
          player={game().players[0]}
          floorOccupied={view().floorOccupied[0]}
          placed={view().transition?.newlyPlaced[0] ?? null}
          scoreDelta={view().transition?.scoreDelta[0] ?? null}
          toMove={!game().isTerminal && game().currentPlayer === 0}
          names={names()}
          destinations={destinations(0)}
        />
        <PlayerBoard
          name="Player 2"
          player={game().players[1]}
          floorOccupied={view().floorOccupied[1]}
          placed={view().transition?.newlyPlaced[1] ?? null}
          scoreDelta={view().transition?.scoreDelta[1] ?? null}
          toMove={!game().isTerminal && game().currentPlayer === 1}
          names={names()}
          destinations={destinations(1)}
        />
      </div>

      {/* A fresh seed, never the one in the URL [U3-47]. */}
      <button type="button" class="new-game" onClick={() => startNewGame()}>
        New game
      </button>
    </main>
  );
}
