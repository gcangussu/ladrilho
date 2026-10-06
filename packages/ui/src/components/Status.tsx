import type { JSX } from '@solidjs/web';
import type { AzulJSON } from 'engine';
import { For, Show } from 'solid-js';
import type { Thinking } from '../game.js';

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
 * [U3-34], [0001 E1-55]. They are folded behind a disclosure, being the one
 * thing here a player looks at rarely.
 */
export function Status(props: {
  game: AzulJSON;
  seed: number;
  names: string[];
  thinking: Thinking;
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
      <details class="supply-pop">
        <summary>Bag</summary>
        <dl class="supply">
          <For each={props.names} keyed={false}>
            {(name, color) => (
              <div class="supply-colour">
                <dt>{name()}</dt>
                <dd>
                  bag {props.game.bag[color]}, lid {props.game.lid[color]}
                </dd>
              </div>
            )}
          </For>
        </dl>
      </details>
    </section>
  );
}
