import type { JSX } from '@solidjs/web';
import { For, Show, createSignal } from 'solid-js';
import {
  LEVELS,
  MASTER_SIMULATIONS,
  validSimulations,
  type Level,
  type Seating as SeatingModel,
} from '../opponent.js';

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
  master: 'Computer — master',
};

/** Who sits at a seat, in words — for the board that seat plays [W6-1]. */
export function seatLabel(level: Level | null): string {
  return level === null ? 'Person' : LABELS[level];
}

/** A seat's simulations input, by the name the seat is shown under [W6-45]. */
export function simulationsLabel(seat: 0 | 1): string {
  return `Player ${seat + 1}: simulations per move`;
}

const RANGE = `${MASTER_SIMULATIONS.min.toLocaleString('en')} to ${MASTER_SIMULATIONS.max.toLocaleString('en')}`;

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
    props.onChoose({ players, simulations: props.seating.simulations });
  };

  /** Why the last entry was refused, or nothing [W6-45]. */
  const [refusal, setRefusal] = createSignal('');

  /**
   * [W6-45]: a valid number applies to that seat alone, and deals a new game
   * [W6-44]; anything else leaves both settings and the game as they were, and
   * says why.
   */
  const setSimulations = (seat: 0 | 1, input: HTMLInputElement): void => {
    const raw = input.value.trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !validSimulations(n)) {
      input.value = String(props.seating.simulations[seat]);
      setRefusal(`${raw === '' ? 'An empty value' : raw} is not a number of simulations from ${RANGE}.`);
      return;
    }
    setRefusal('');
    const simulations: [number, number] = [...props.seating.simulations];
    simulations[seat] = n;
    props.onChoose({ players: props.seating.players, simulations });
  };

  const masterSeats = (): (0 | 1)[] => ([0, 1] as const).filter((seat) => props.seating.players[seat] === 'master');

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
      <Show when={masterSeats().length > 0}>
        <details class="advanced">
          <summary>Advanced</summary>
          <For each={masterSeats()}>
            {(seat) => (
              <p>
                <label>
                  {simulationsLabel(seat)}{' '}
                  <input
                    type="number"
                    inputmode="numeric"
                    min={MASTER_SIMULATIONS.min}
                    max={MASTER_SIMULATIONS.max}
                    step="1"
                    value={props.seating.simulations[seat]}
                    onChange={(event) => setSimulations(seat, event.currentTarget)}
                  />
                </label>
              </p>
            )}
          </For>
          <p class="seating-note">
            {`More simulations play stronger and slower. Default ${MASTER_SIMULATIONS.default.toLocaleString('en')}; from ${RANGE}.`}
          </p>
          <p class="seating-note" role="status">
            {refusal()}
          </p>
        </details>
      </Show>
    </section>
  );
}
