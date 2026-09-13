import type { JSX } from '@solidjs/web';
import { For } from 'solid-js';
import { LEVELS, type Level, type Seating as SeatingModel } from '../opponent.js';

/**
 * Who plays each seat [W6-1], [W6-5].
 *
 * Every combination is offered, including two people (which is 0003's game
 * unchanged) and two computers ([W6-9]) — the intent asks for the last of those
 * because watching two opponents play is how you spot bad play, and once either
 * seat can be a computer it costs one more value here.
 *
 * A person may take either seat [W6-5]. Azul is not seat-symmetric — player 0
 * opens — so fixing the computer to seat 1 would quietly decide who gets the
 * advantage.
 *
 * Choosing anything deals a new game [W6-3], which the label says out loud: a
 * game half-played by a person and half by a program is one whose seed no
 * longer describes a match.
 */

/**
 * The settings, by a name a player can act on rather than a number [W6-1].
 *
 * `expert` is offered only when the gate of [0008 A8-30] passed, which is what
 * [0008 A8-33] asks: intent 0006 said the learned opponent ships only if it
 * wins clearly more often than the hardest setting we built.
 */
const LABELS: Readonly<Record<Level, string>> = {
  easy: 'Computer — gentle',
  steady: 'Computer — steady',
  sharp: 'Computer — ruthless',
  expert: 'Computer — expert',
};

const CHOICES: readonly { value: Level | 'human'; label: string }[] = [
  { value: 'human', label: 'Person' },
  ...LEVELS.map((level) => ({ value: level, label: LABELS[level] })),
];

export function Seating(props: {
  seating: SeatingModel;
  onChoose: (seating: SeatingModel) => void;
}): JSX.Element {
  const choose = (seat: 0 | 1, value: string): void => {
    const level = value === 'human' ? null : (value as Level);
    const players: [Level | null, Level | null] = [...props.seating.players];
    players[seat] = level;
    props.onChoose({ players });
  };

  return (
    <section class="seating" aria-label="Who is playing">
      <For each={[0, 1] as const}>
        {(seat) => (
          <p>
            <label>
              {`Player ${seat + 1}`}{' '}
              <select
                value={props.seating.players[seat] ?? 'human'}
                onChange={(event) => choose(seat, event.currentTarget.value)}
              >
                <For each={CHOICES}>
                  {(choice) => <option value={choice.value}>{choice.label}</option>}
                </For>
              </select>
            </label>
          </p>
        )}
      </For>
      <p class="seating-note">Changing this starts a new game.</p>
    </section>
  );
}
