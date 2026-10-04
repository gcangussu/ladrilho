/**
 * Our position as danluu.com/game/tile's engine reads it, and its action ids
 * as ours.
 *
 * Their game object is what `AzulEngine.get_state().game` returns and
 * `AzulEngine.set_state` accepts. It differs from ours in four ways that
 * matter here:
 *
 * - the centre is display 0 and the factories are 1..5, where ours puts the
 *   centre at source 5 — so an action id is `display * 30 + colour * 6 + line`
 *   on both sides, with only the display renumbered;
 * - a floor is a count, the first-player marker included, and floored tiles go
 *   to the discards at once, where ours keeps them by colour until the round
 *   ends;
 * - `round` counts from 1;
 * - the bag is counts, as in our `AzulJSON`.
 *
 * Colours are in the same order on both sides (their white is our teal), and
 * the wall is the standard one on both. `verify` checks all of this against
 * their engine, ply by ply; nothing here is taken on trust.
 */

import { CENTER, NUM_COLORS, NUM_ROWS, type AzulState } from 'engine';

export const THEIR_COLORS = ['Blue', 'Yellow', 'Red', 'Black', 'White'] as const;
type Seat = 'P0' | 'P1';

export interface TheirGame {
  cfg: { seed: number; first_player: Seat };
  to_play: Seat;
  scores: number[];
  round: number;
  bag: number[];
  discards: number[];
  centre: number[];
  token_in_centre: boolean;
  token_owner?: Seat;
  factories: number[][];
  pattern_colors: (string | null)[][];
  pattern_counts: number[][];
  walls: boolean[][][];
}

const seat = (p: number): Seat => (p === 0 ? 'P0' : 'P1');

export function toTheirs(s: AzulState, seed: number): TheirGame {
  const bag = [0, 0, 0, 0, 0];
  for (const c of s.bag) bag[c]++;
  const discards = s.lid.slice();
  for (const f of s.floor) for (let c = 0; c < NUM_COLORS; c++) discards[c] += f[c];
  const holder = s.floorMarker[0] ? 0 : s.floorMarker[1] ? 1 : null;
  const game: TheirGame = {
    cfg: { seed, first_player: seat(s.firstPlayer) },
    to_play: seat(s.currentPlayer),
    scores: s.scores.slice(),
    round: s.roundIndex + 1,
    bag,
    discards,
    centre: s.center.slice(),
    token_in_centre: s.markerInCenter,
    factories: s.factories.map((f) => f.slice()),
    pattern_colors: s.plColor.map((row) => row.map((c) => (c < 0 ? null : THEIR_COLORS[c]))),
    pattern_counts: [0, 1].map((p) => {
      const floor = s.floor[p].reduce((a, b) => a + b, 0) + (s.floorMarker[p] ? 1 : 0);
      return [...s.plCount[p], floor];
    }),
    walls: s.walls.map((w) => Array.from({ length: NUM_ROWS }, (_, r) => w.slice(r * 5, r * 5 + 5).map((x) => x === 1))),
  };
  if (holder !== null) game.token_owner = seat(holder);
  return game;
}

/** Our action id as theirs. */
export function actionToTheirs(a: number): number {
  const source = (a / 30) | 0;
  const display = source === CENTER ? 0 : source + 1;
  return display * 30 + (a % 30);
}

/** Their action id as ours. */
export function actionFromTheirs(id: number): number {
  const display = (id / 30) | 0;
  const source = display === 0 ? CENTER : display - 1;
  return source * 30 + (id % 30);
}
