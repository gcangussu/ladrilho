import type { JSX } from '@solidjs/web';
import type { AzulJSON } from 'engine';
import { For } from 'solid-js';

/**
 * The round, what is left to take, whose turn it is, and the seed this game was
 * dealt from [U3-14] — which, with no undo [U3-17] and nothing surviving a
 * reload [U3-16], is the only way to see a deal twice.
 *
 * Bag and lid are shown as per-colour counts, which is all the engine reports
 * and all it may: the bag's order is hidden information no player may see
 * [U3-34], [0001 E1-55].
 */
export function Status(props: { game: AzulJSON; seed: number; names: string[] }): JSX.Element {
  return (
    <section class="status" aria-label="Game status">
      <p>Round {props.game.round + 1}</p>
      <p>{props.game.tilesLeft} tiles left on the board this round</p>
      <p class="whose-turn">
        {props.game.isTerminal
          ? 'Game over'
          : `Player ${props.game.currentPlayer + 1} to move`}
      </p>
      <p class="marker-location">
        First-player marker:{' '}
        {props.game.markerInCenter
          ? 'in the centre'
          : `on player ${props.game.players[0].floorMarker ? 1 : 2}’s floor line`}
      </p>
      <p>
        Seed <code>{props.seed}</code>
      </p>
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
    </section>
  );
}
