import type { JSX } from '@solidjs/web';
import { For, Show, createSignal } from 'solid-js';
import { parseSeed } from '../game.js';
import {
  LEVELS,
  MASTER_PRESETS,
  MASTER_SIMULATIONS,
  validSimulations,
  type Level,
  type Seating as SeatingModel,
} from '../opponent.js';

/**
 * Who plays each seat, chosen in the new-game sheet [W6-49] through [W6-51].
 *
 * Every combination is offered, including two people (which is 0003's game
 * unchanged) and two computers ([W6-9]) — watching two opponents play is how
 * you spot bad play, and once either seat can be a computer it costs one more
 * value here.
 *
 * A person may take either seat [W6-5]. Azul is not seat-symmetric — player 0
 * opens — so the sheet has a Swap rather than fixing the computer to seat 1,
 * which would quietly decide who gets the advantage [W6-50].
 *
 * Nothing chosen here touches the game until Deal [W6-49]: a game half-played
 * by a person and half by a program is one whose seed no longer describes a
 * match [W6-3], so the choices are gathered first and dealt together.
 */

/**
 * The settings by the name a board shows them under [W6-1].
 *
 * `expert` is offered only when the gate of [0008 A8-30] passed, which is what
 * [0008 A8-33] asks: intent 0006 said the learned opponent ships only if it
 * wins clearly more often than the hardest setting we built.
 */
const NAMES: Readonly<Record<Level, string>> = {
  easy: 'gentle',
  steady: 'steady',
  sharp: 'ruthless',
  expert: 'expert',
  master: 'master',
};

const LABELS: Readonly<Record<Level, string>> = {
  easy: `Computer — ${NAMES.easy}`,
  steady: `Computer — ${NAMES.steady}`,
  sharp: `Computer — ${NAMES.sharp}`,
  expert: `Computer — ${NAMES.expert}`,
  master: `Computer — ${NAMES.master}`,
};

/** A level in a board's own words, without `Computer — ` [W6-58]. */
export function levelName(level: Level): string {
  return NAMES[level];
}

/** Who sits at a seat, in words — for the board that seat plays [W6-1]. */
export function seatLabel(level: Level | null): string {
  return level === null ? 'Person' : LABELS[level];
}

/**
 * The sheet's own names and lines [W6-51]. Each line says how the player is
 * built and never who beats whom: that is measured, and it moves whenever
 * `sharp` does.
 */
const CHOICES: Readonly<Record<Level | 'human', { name: string; line: string }>> = {
  human: { name: 'A person', line: 'Pass the device between turns' },
  easy: { name: 'Gentle', line: 'Looks only at its own move' },
  steady: { name: 'Steady', line: 'Looks at your reply, and its answer to it' },
  sharp: { name: 'Ruthless', line: 'Looks as far ahead as it can, and times the round’s end' },
  expert: { name: 'Expert', line: 'A published player, learned rather than written' },
  master: { name: 'Master', line: 'Taught itself by playing itself' },
};

/** The offered choices, in [W6-1]'s order: a person, then each level. */
const OFFERED: readonly (Level | 'human')[] = ['human', ...LEVELS];

/** A seat's number input, by the name the seat is shown under [W6-45]. */
export function simulationsLabel(seat: 0 | 1): string {
  return `Player ${seat + 1}: exact setting`;
}

const RANGE = `${MASTER_SIMULATIONS.min.toLocaleString('en')} to ${MASTER_SIMULATIONS.max.toLocaleString('en')}`;

/**
 * The slider's stops [W6-45]: a 1-2-5 ladder from the least a master may think
 * to the most, so it is logarithmic, coarse, and passes through the default
 * exactly. Derived from the settings' own bounds rather than written out.
 */
const STOPS: readonly number[] = (() => {
  const stops: number[] = [];
  const steps = [2, 2.5, 2];
  for (let v: number = MASTER_SIMULATIONS.min, i = 0; v <= MASTER_SIMULATIONS.max; i++) {
    stops.push(Math.round(v));
    v *= steps[i % steps.length];
  }
  return stops;
})();

/** The stop nearest a value, by ratio — which is what "nearest" means on a log scale. */
function nearestStop(value: number): number {
  let best = 0;
  for (let i = 1; i < STOPS.length; i++) {
    if (Math.abs(Math.log(STOPS[i] / value)) < Math.abs(Math.log(STOPS[best] / value))) best = i;
  }
  return best;
}

/**
 * Each configuration's line [W6-45], [0012 T12-37]: what it is for, in plain
 * words — never its count, and never how long it takes, since the times are
 * promised on one laptop only (intent 0016). Deep thinks about twice as long as
 * Balanced for a small gain, so neither line makes the gap sound larger.
 */
const PRESET_LINES: Readonly<Record<(typeof MASTER_PRESETS)[number]['name'], string>> = {
  Quick: 'Faster, a little weaker',
  Balanced: 'Recommended',
  Deep: 'Slower, a little stronger',
};

/** The slider's value in words [W6-45]: the count, and whether it is the recommended one. */
function valueText(simulations: number): string {
  const n = simulations.toLocaleString('en');
  return simulations === MASTER_SIMULATIONS.default ? `${n} (recommended)` : n;
}

/** The configuration a count is, if it is one. */
export function presetOf(simulations: number): (typeof MASTER_PRESETS)[number] | undefined {
  return MASTER_PRESETS.find((p) => p.simulations === simulations);
}

/** What one deal starts with: the staged seating, and a seed only when asked for [U3-104]. */
export type Deal = { seating: SeatingModel; seed: number | null };

export function NewGameSheet(props: {
  seating: SeatingModel;
  onDeal: (deal: Deal) => void;
  onClose: () => void;
}): JSX.Element {
  // Staged, from the seating as it stands when the sheet opens [W6-49].
  const [players, setPlayers] = createSignal<SeatingModel['players']>([...props.seating.players]);
  const [sims, setSims] = createSignal<SeatingModel['simulations']>([...props.seating.simulations]);
  const [editing, setEditing] = createSignal<0 | 1>(0);
  /**
   * Each seat's `Custom`, held once chosen — by its radio, the slider or the
   * number — so landing on a configuration's count does not close the
   * controls being used [W6-45].
   */
  const [customChosen, setCustomChosen] = createSignal<[boolean, boolean]>([false, false]);
  /** A seat is custom when chosen so, or when its count is no configuration's. */
  const custom = (seat: 0 | 1): boolean => customChosen()[seat] || presetOf(sims()[seat]) === undefined;
  const chooseCustom = (seat: 0 | 1, on: boolean): void => {
    const next: [boolean, boolean] = [...customChosen()];
    next[seat] = on;
    setCustomChosen(next);
  };
  /** The deal-number field, read when Deal is pressed: what is in it then is what counts. */
  let dealField!: HTMLInputElement;
  /** Why the last entry was refused, or nothing [W6-45], [U3-104]. */
  const [refusal, setRefusal] = createSignal('');

  const choiceAt = (seat: 0 | 1): Level | 'human' => players()[seat] ?? 'human';

  const choose = (value: Level | 'human'): void => {
    const next: SeatingModel['players'] = [...players()];
    next[editing()] = value === 'human' ? null : value;
    setPlayers(next);
  };

  /** [W6-50]: the seats change places, each with its own setting. */
  const swap = (): void => {
    const [a, b] = players();
    const [x, y] = sims();
    const [p, q] = customChosen();
    setPlayers([b, a]);
    setSims([y, x]);
    setCustomChosen([q, p]);
    // The card being edited follows the player who moved, so what was on
    // screen — a master's setting, say — stays there rather than vanishing.
    setEditing(editing() === 0 ? 1 : 0);
  };

  const stage = (seat: 0 | 1, n: number): void => {
    const next: SeatingModel['simulations'] = [...sims()];
    next[seat] = n;
    setSims(next);
  };

  /**
   * [W6-45]: a valid number stages for that seat alone; anything else leaves
   * both as they were, puts the input back, and says why.
   */
  const commitNumber = (seat: 0 | 1, input: HTMLInputElement): void => {
    const raw = input.value.trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !validSimulations(n)) {
      input.value = String(sims()[seat]);
      setRefusal(`Pick a whole number from ${RANGE}.`);
      return;
    }
    setRefusal('');
    chooseCustom(seat, true);
    stage(seat, n);
  };

  /** [W6-49]: one deal, carrying everything staged — or nothing, and why. */
  const deal = (): void => {
    const raw = dealField.value.trim();
    const seed = raw === '' ? null : parseSeed(raw);
    if (raw !== '' && seed === null) {
      setRefusal(`${raw} is not a deal number from 0 to ${(2 ** 32 - 1).toLocaleString('en')}.`);
      return;
    }
    props.onDeal({ seating: { players: players(), simulations: sims() }, seed });
  };

  return (
    <div
      class="sheet-scrim"
      // A press on the dimmed page outside the sheet is Close [W6-49].
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <section
        class="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        ref={(el: HTMLElement) => queueMicrotask(() => el.querySelector<HTMLElement>('.seat-card[aria-pressed="true"]')?.focus())}
      >
        <header class="sheet-head">
          <h2 id="sheet-title">New game</h2>
          <button type="button" class="tool close" onClick={() => props.onClose()}>
            Close
          </button>
        </header>

        <div class="sheet-body">
          <div class="sheet-col">
            <div class="seats" role="group" aria-label="Who sits where">
              <For each={[0, 1] as const}>
                {(seat) => (
                  <>
                    <button
                      type="button"
                      class="seat-card"
                      aria-pressed={editing() === seat ? 'true' : 'false'}
                      onClick={() => setEditing(seat)}
                    >
                      <span class="avatar" aria-hidden="true">
                        {seat + 1}
                      </span>
                      <span class="seat-text">
                        <span class="seat-name">Player {seat + 1}</span>
                        <span class="seat-who">
                          {CHOICES[choiceAt(seat)].name}
                          {seat === 0 ? ' · opens the game' : ''}
                        </span>
                      </span>
                    </button>
                    <Show when={seat === 0}>
                      <button type="button" class="swap" onClick={swap}>
                        Swap seats
                      </button>
                    </Show>
                  </>
                )}
              </For>
            </div>

            <fieldset class="choices">
              <legend>Player {editing() + 1} is</legend>
              <For each={OFFERED}>
                {(value) => (
                  <label class={['choice', { chosen: choiceAt(editing()) === value }]}>
                    <input
                      type="radio"
                      name="seat-choice"
                      value={value}
                      checked={choiceAt(editing()) === value}
                      onChange={() => choose(value)}
                    />
                    <span class="choice-text">
                      <span class="choice-name">{CHOICES[value].name}</span>
                      <span class="choice-line">{CHOICES[value].line}</span>
                    </span>
                  </label>
                )}
              </For>
            </fieldset>
          </div>

          <div class="sheet-col">
            {/* [W6-45]: beside the seat it belongs to, and only while it is a master. */}
            <Show when={players()[editing()] === 'master'}>
              <div class="budget">
                <fieldset class="choices presets">
                  <legend>{`How hard Player ${editing() + 1} thinks`}</legend>
                  <For each={MASTER_PRESETS}>
                    {(preset) => (
                      <label
                        class={['choice', { chosen: !custom(editing()) && sims()[editing()] === preset.simulations }]}
                      >
                        <input
                          type="radio"
                          name="master-preset"
                          value={preset.name}
                          checked={!custom(editing()) && sims()[editing()] === preset.simulations}
                          onChange={() => {
                            setRefusal('');
                            chooseCustom(editing(), false);
                            stage(editing(), preset.simulations);
                          }}
                        />
                        <span class="choice-text">
                          <span class="choice-name">{preset.name}</span>
                          <span class="choice-line">{PRESET_LINES[preset.name]}</span>
                        </span>
                      </label>
                    )}
                  </For>
                  <label class={['choice', { chosen: custom(editing()) }]}>
                    <input
                      type="radio"
                      name="master-preset"
                      value="Custom"
                      checked={custom(editing())}
                      onChange={() => chooseCustom(editing(), true)}
                    />
                    <span class="choice-text">
                      <span class="choice-name">Custom</span>
                      <span class="choice-line">Set it yourself</span>
                    </span>
                  </label>
                </fieldset>
                <Show when={custom(editing())}>
                  <label class="budget-row">
                    <span>Thinking</span>
                    <input
                      type="range"
                      min="0"
                      max={STOPS.length - 1}
                      step="1"
                      value={nearestStop(sims()[editing()])}
                      aria-valuetext={valueText(sims()[editing()])}
                      onInput={(event) => {
                        setRefusal('');
                        chooseCustom(editing(), true);
                        stage(editing(), STOPS[Number(event.currentTarget.value)]);
                      }}
                    />
                    <span class="budget-ends" aria-hidden="true">
                      <span>Lighter</span>
                      <span>Deeper</span>
                    </span>
                  </label>
                  <label class="budget-row">
                    <span>{simulationsLabel(editing())}</span>
                    <input
                      type="number"
                      inputmode="numeric"
                      min={MASTER_SIMULATIONS.min}
                      max={MASTER_SIMULATIONS.max}
                      step="1"
                      value={sims()[editing()]}
                      onChange={(event) => commitNumber(editing(), event.currentTarget)}
                    />
                  </label>
                  <p class="sheet-note">
                    {`Higher plays a little stronger and a little slower. Recommended: ${MASTER_SIMULATIONS.default.toLocaleString('en')}.`}
                  </p>
                </Show>
              </div>
            </Show>

            {/* At the foot of its column, so it stays put while the master's
                setting comes and goes above it. */}
            <div class="sheet-deal">
              <label class="deal-number">
                <span>Deal number</span>
                <input
                  type="text"
                  inputmode="numeric"
                  placeholder="Random"
                  ref={dealField}
                />
              </label>
              <p class="sheet-note">Leave it empty for a fresh deal, or type a number to play that deal.</p>

              <p class="sheet-refusal" role="status">
                {refusal()}
              </p>

              <button type="button" class="deal" onClick={deal}>
                Deal
              </button>
              <p class="sheet-note center">The game in progress ends when you deal.</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
