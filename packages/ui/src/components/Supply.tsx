import type { JSX } from '@solidjs/web';
import type { AzulJSON } from 'engine';
import { For } from 'solid-js';
import { Tile } from './Tile.jsx';

/**
 * What is left in the bag and in the lid, by colour [U3-34] — all the engine
 * reports and all it may: the bag's order is hidden information no player may
 * see [0001 E1-55].
 *
 * One component for both places it is shown, so a screen reader is told the
 * same thing in each [U3-105]: behind the top bar's disclosure where the table
 * is small [U3-96], and in plain view beneath the ring on the wide table.
 *
 * A table, so a colour's two counts are read together: a tile for the colour,
 * and the bag and the lid as columns.
 */
export function Supply(props: { game: AzulJSON; names: string[] }): JSX.Element {
  return (
    <table class="supply">
      <caption class="sr-only">Tiles in the bag and in the lid, by colour</caption>
      <thead>
        <tr>
          <th scope="col">
            <span class="sr-only">Colour</span>
          </th>
          <th scope="col">Bag</th>
          <th scope="col">Lid</th>
        </tr>
      </thead>
      <tbody>
        <For each={props.names} keyed={false}>
          {(_, color) => (
            <tr>
              <th scope="row">
                <Tile color={color} names={props.names} />
              </th>
              <td>{props.game.bag[color]}</td>
              <td>{props.game.lid[color]}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}
