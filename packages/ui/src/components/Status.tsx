import type { JSX } from '@solidjs/web';
import type { AzulJSON } from 'engine';
import { Show } from 'solid-js';
import type { Thinking } from '../game.js';
import { Supply } from './Supply.jsx';

/**
 * The round, what is left to take, whose turn it is, and the seed this game was
 * dealt from [U3-14] — which, with no undo [U3-17] and nothing surviving a
 * reload [U3-16], is the only way to see a deal twice.
 *
 * Drawn as the strip across the top of the table rather than as a paragraph
 * [U3-95]: the round and the tiles left as two pills, the turn in words beside
 * them [U3-33], and the deal number at the end of the strip.
 *
 * Bag and lid are shown as per-colour counts, which is all the engine reports
 * and all it may: the bag's order is hidden information no player may see
 * [U3-34], [0001 E1-55]. Where the table is small they are folded behind a
 * disclosure, being the one thing here a player looks at rarely [U3-96]; on
 * the wide table they are in view beneath the ring instead, and `bag` is false
 * so the top bar does not carry them twice [U3-105]. The caller says which: the
 * arrangement is measured above this component, not in it [U3-110].
 */
export function Status(props: {
  game: AzulJSON;
  seed: number;
  names: string[];
  thinking: Thinking;
  /** Whether the bag's disclosure is in the top bar. Defaults to true. */
  bag?: boolean;
}): JSX.Element {
  return (
    <section class="status" aria-label="Game status">
      <p class="pill round">Round {props.game.round + 1}</p>
      <p class="pill tiles-left">{props.game.tilesLeft} tiles left</p>
      <p class="whose-turn">
        {props.game.isTerminal
          ? 'Game over'
          : `Player ${props.game.currentPlayer + 1} to move`}
      </p>
      {/*
        Shown exactly while a request is outstanding [W6-19], [W6-21], and never
        otherwise — which is the whole of intent 0003's "the interface can say
        'thinking…' honestly". What it never shows is the value, the depth, or
        any judgement of the move [W6-24].
      */}
      <Show when={props.thinking !== null}>
        <p class="thinking">Player {(props.thinking?.seat ?? 0) + 1} is thinking…</p>
      </Show>
      {/* The marker itself is on screen as a tile, in the centre or on a floor
          line [U3-32]; this is the same fact in words. */}
      <p class="marker-location sr-only">
        First-player marker:{' '}
        {props.game.markerInCenter
          ? 'in the centre'
          : `on player ${props.game.players[0].floorMarker ? 1 : 2}’s floor line`}
      </p>
      <p class="seed">
        <span class="seed-word">Deal </span>
        <code>{props.seed}</code>
      </p>
      <Show when={props.bag ?? true}>
        <details
          class="supply-pop"
          onToggle={(event) => {
            if (!event.currentTarget.open) return;
            for (const other of document.querySelectorAll<HTMLDetailsElement>('.topbar details[open]')) {
              if (other !== event.currentTarget) other.open = false;
            }
          }}
        >
          <summary>Bag</summary>
          <Supply game={props.game} names={props.names} />
        </details>
      </Show>
    </section>
  );
}
