import type { JSX } from '@solidjs/web';
import { FLOOR, NUM_ROWS, decodeAction, encodeAction } from 'engine';
import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { computerSeat, replayDeal, startNewGame, startWithSeating, submit, view } from '../game.js';
import { Announcer, announcement } from './Announcer.jsx';
import { Displays, type Pick } from './Displays.jsx';
import { GameOver } from './GameOver.jsx';
import { PlayerBoard } from './PlayerBoard.jsx';
import { Scoring } from './Scoring.jsx';
import { NewGameSheet, seatLabel } from './Seating.jsx';
import { Status } from './Status.jsx';

/**
 * How the table is arranged [U3-95]: both boards full size beside the table,
 * or one board docked full size and the other shown small — beside the table
 * where the width allows (`side`), above it where it does not (`stack`).
 */
export type Layout = 'wide' | 'side' | 'stack';

/**
 * The widths, in root ems, at which the arrangement changes [U3-95].
 *
 * In root ems and measured against a probe one root em wide, so a larger root
 * font-size asks for more room exactly as the boards' own `rem` sizes do —
 * which is the distinction [U3-89] draws between the room a board is given and
 * the viewport. A media query cannot make it: a `rem` there resolves against the
 * initial font-size and never against a declaration.
 */
const WIDE_FROM = 77;
const SIDE_FROM = 50;

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
  let probe!: HTMLDivElement;
  /** The group that last held focus, so [U3-57] can find its way back. */
  let lastGroup = 'factories';

  /**
   * The arrangement, decided from the width the interface has against the
   * root font-size [U3-95]. Where nothing can be measured — jsdom has no
   * `ResizeObserver` and no layout — it is the arrangement that docks nothing.
   */
  const [layout, setLayout] = createSignal<Layout>('wide');
  let observer: ResizeObserver | null = null;
  const measure = (): void => {
    const em = probe.getBoundingClientRect().width;
    if (em === 0) return;
    const width = root.clientWidth / em;
    // Side by side only on a screen wider than it is tall: upright, the
    // stacked arrangement uses the height and the side one strands it.
    const landscape = window.innerWidth >= window.innerHeight;
    setLayout(width >= WIDE_FROM ? 'wide' : width >= SIDE_FROM && landscape ? 'side' : 'stack');
  };
  /**
   * Started from the root's `ref` rather than from `onSettled`, whose returned
   * cleanup ran before the first resize arrived and left the arrangement
   * frozen at whatever the first measurement said.
   */
  const observe = (el: HTMLElement): void => {
    root = el;
    if (typeof ResizeObserver === 'undefined') return;
    queueMicrotask(() => {
      // The probe as well as the root: a change of root font-size resizes the
      // probe and nothing else, and it changes the answer all the same.
      observer = new ResizeObserver(measure);
      observer.observe(root);
      observer.observe(probe);
      measure();
    });
    // Belt and braces: a resize observer delivers on the rendering steps, and a
    // page that is not being painted gets none. A window resize still arrives.
    window.addEventListener('resize', measure);
  };
  onCleanup(() => {
    observer?.disconnect();
    window.removeEventListener('resize', measure);
  });

  /** The people at the table, by seat. */
  const people = (): number[] => [0, 1].filter((seat) => view().seating.players[seat] === null);
  const hotSeat = (): boolean => people().length === 2;

  /**
   * Hot-seat on a docked arrangement [U3-103]: the seat whose board is docked,
   * and the seat the curtain is waiting on, if it is up.
   *
   * The docked board follows the player to move, but only through the
   * curtain: when a ply passes the turn the curtain names the next player and
   * covers the table, and the boards change places when that player lifts it —
   * never under the finger of the player who just moved.
   */
  const [shown, setShown] = createSignal(0);
  const [curtain, setCurtain] = createSignal<number | null>(null);
  createEffect(
    () => ({
      mover: game().currentPlayer,
      over: game().isTerminal,
      docks: layout() !== 'wide' && hotSeat(),
    }),
    ({ mover, over, docks }) => {
      if (!docks || over) {
        setShown(mover);
        setCurtain(null);
      } else if (mover !== shown()) {
        setCurtain(mover);
      }
    },
  );
  const lift = (): void => {
    const next = curtain();
    if (next === null) return;
    setShown(next);
    setCurtain(null);
  };

  /** Which board is docked, or `null` where both are full size [U3-103]. */
  const docked = (): number | null => {
    if (layout() === 'wide') return null;
    const seats = people();
    if (seats.length === 1) return seats[0];
    return seats.length === 2 ? shown() : 0;
  };
  const roleOf = (seat: number): 'dock' | 'mini' | null => {
    const dock = docked();
    return dock === null ? null : dock === seat ? 'dock' : 'mini';
  };
  const curtainUp = (): boolean => curtain() !== null && layout() !== 'wide';

  /**
   * The top bar's disclosures [U3-96] behave as popovers: one open at a time,
   * and a press anywhere else closes them. Native `<details>` does neither.
   */
  const closePopovers = (except: Element | null): void => {
    for (const open of root.querySelectorAll<HTMLDetailsElement>('.topbar details[open]')) {
      if (open !== except && !open.contains(except)) open.open = false;
    }
  };
  const onOutside = (event: PointerEvent): void => {
    const target = event.target as Element;
    closePopovers(target.closest('.topbar details'));
  };
  document.addEventListener('pointerdown', onOutside);
  onCleanup(() => document.removeEventListener('pointerdown', onOutside));

  /**
   * The new-game sheet [W6-49]: open or not, and the control that opened it,
   * which gets focus back when it closes.
   */
  const [dealing, setDealing] = createSignal(false);
  let opener: HTMLElement | null = null;
  const openSheet = (event: MouseEvent): void => {
    opener = event.currentTarget as HTMLElement;
    closePopovers(null);
    setDealing(true);
  };
  const closeSheet = (): void => {
    setDealing(false);
    const back = opener;
    queueMicrotask(() => {
      // The opener may be gone — a game-over offer, after the deal — and then
      // focus falls to the new game's first group, as after any ply [U3-57].
      if (back?.isConnected) back.focus();
      else root.querySelector<HTMLElement>('[data-group="factories"] [data-roving][tabindex="0"]')?.focus();
    });
  };

  /** The last round's workings, as a sheet, where the boards leave no room [U3-102]. */
  const [sheet, setSheet] = createSignal(false);

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

  /** The selection, on the board it will be placed on [U3-99]. */
  const holding = (player: number): Pick | null =>
    humanToMove() && game().currentPlayer === player ? selection() : null;

  /**
   * A row by its number, the floor by F [U3-100] — the same choice a click on
   * that row makes, under the same rule: a key for an unavailable row does
   * nothing [U3-29]. Not while typing into the seat settings.
   */
  const onShortcut = (event: KeyboardEvent): void => {
    if (selection() === null) return;
    if ((event.target as HTMLElement).closest('input, select, textarea')) return;
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      chooseDest(FLOOR);
      return;
    }
    if (/^[1-9]$/.test(event.key) && Number(event.key) <= NUM_ROWS) {
      event.preventDefault();
      chooseDest(Number(event.key) - 1);
    }
  };

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

  const board = (seat: 0 | 1): JSX.Element => (
    <PlayerBoard
      name={`Player ${seat + 1}`}
      seat={seat}
      seatLabel={seatLabel(view().seating.players[seat])}
      player={game().players[seat]}
      floorOccupied={view().floorOccupied[seat]}
      placed={view().transition?.newlyPlaced[seat] ?? null}
      scoreDelta={view().transition?.scoreDelta[seat] ?? null}
      toMove={!game().isTerminal && game().currentPlayer === seat}
      thinking={view().thinking?.seat === seat}
      person={view().seating.players[seat] === null}
      names={names()}
      destinations={destinations(seat)}
      holding={holding(seat)}
      onPutBack={() => setSelection(null)}
      lastMove={view().lastMoves[seat]}
      placements={view().scoring?.players[seat].placements ?? null}
      role={roleOf(seat)}
    />
  );

  return (
    <main
      class="app"
      aria-label="Azul"
      data-layout={layout()}
      data-sheet={sheet() && layout() !== 'wide' ? 'workings' : undefined}
      ref={observe}
      // Escape clears a selection wherever focus happens to be [U3-26].
      onKeyDown={(event) => {
        if (event.key === 'Escape' && dealing()) {
          // [W6-49]: Escape discards the sheet's choices and nothing else.
          closeSheet();
        } else if (event.key === 'Escape') {
          setSelection(null);
          setSheet(false);
          closePopovers(null);
        } else onShortcut(event);
      }}
      onFocusIn={(event) => {
        const group = (event.target as HTMLElement).closest<HTMLElement>('[data-group]');
        if (group) lastGroup = group.dataset['group'] ?? lastGroup;
      }}
    >
      <div class="layout-probe" aria-hidden="true" ref={probe} />
      <Announcer message={announcement(view())} />

      {/* Everything under the curtain is out of reach while it is up [U3-103]. */}
      <div class="stage" inert={curtainUp() || dealing() || undefined}>
        <header class="topbar">
          <h1 class="logo">
            <span class="logo-mark" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            azul
          </h1>
          <Status
            game={game()}
            seed={view().seed}
            names={names()}
            thinking={view().thinking}
          />
          <div class="top-actions">
            <Show when={layout() !== 'wide' && view().scoring !== null}>
              <button
                type="button"
                class="tool"
                aria-expanded={sheet() ? 'true' : 'false'}
                onClick={() => setSheet(!sheet())}
              >
                Workings
              </button>
            </Show>
            {/* Opens the sheet, where the seats are and where Deal is [W6-49];
                available throughout, a search included [W6-23]. */}
            <button
              type="button"
              class="new-game"
              aria-haspopup="dialog"
              onClick={openSheet}
            >
              New game
            </button>
          </div>
        </header>

        <div class={['table', { paused: view().thinking !== null }]}>
          {/* The table is paused while a computer chooses, said once for the
              whole table rather than by fading every tile [W6-20]. The live
              region already announces it, so this is for the eye only. */}
          <Show when={view().thinking}>
            {(thinking) => (
              <p class="table-note" aria-hidden="true">
                <span class="dots">
                  <i />
                  <i />
                  <i />
                </span>
                Player {thinking().seat + 1} is choosing a move
              </p>
            )}
          </Show>
          <Displays
            game={game()}
            names={names()}
            selection={selection()}
            available={pickAvailable}
            onChoose={choosePick}
          />
          <Show when={layout() === 'wide'}>
            <p class="keys" aria-hidden="true">
              <span>
                <kbd>Tab</kbd> factories
              </span>
              <span>
                <kbd>← →</kbd> colours
              </span>
              <span>
                <kbd>Enter</kbd> pick
              </span>
              <span>
                <kbd>1–5</kbd> row
              </span>
              <span>
                <kbd>F</kbd> floor
              </span>
              <span>
                <kbd>Esc</kbd> put back
              </span>
            </p>
          </Show>
        </div>

        <Show when={game().isTerminal}>
          {/* A slot the size of the table's room, which the result sits in at
              its own height and scrolls within only when it must. */}
          <div class="game-over-slot">
            <GameOver
              game={game()}
              names={names()}
              bonuses={view().scoring?.bonuses ?? null}
              onRematch={() => startNewGame()}
              onReplay={() => replayDeal()}
              onChangeSeats={openSheet}
            />
          </div>
        </Show>

        {board(0)}
        {board(1)}

        {/* The workings of the last round, for as long as it is the last round
            [U3-82]. Unlike the transition marking of [U3-43] this does not clear
            on the next ply — reading a round's arithmetic takes longer than a
            ply does. Under each board where the table has room, as a sheet
            where it has not [U3-102]. */}
        <Show when={view().scoring}>
          {(scoring) => (
            <Scoring
              scoring={scoring()}
              names={names()}
              playerNames={['Player 1', 'Player 2']}
              onClose={sheet() && layout() !== 'wide' ? () => setSheet(false) : undefined}
            />
          )}
        </Show>
      </div>

      <Show when={dealing()}>
        <NewGameSheet
          seating={view().seating}
          onClose={closeSheet}
          onDeal={(deal) => {
            closeSheet();
            startWithSeating(deal.seating, deal.seed);
          }}
        />
      </Show>

      <Show when={curtainUp()}>
        <div class="curtain" role="dialog" aria-modal="true" aria-label="Pass the device">
          <p class="curtain-title">Player {(curtain() ?? 0) + 1}’s turn</p>
          <p class="curtain-text">
            Pass the device. Your board is under this screen until you are ready.
          </p>
          <button
            type="button"
            class="lift"
            ref={(el: HTMLButtonElement) => queueMicrotask(() => el.focus())}
            onClick={lift}
          >
            Show Player {(curtain() ?? 0) + 1}’s board
          </button>
        </div>
      </Show>
    </main>
  );
}
