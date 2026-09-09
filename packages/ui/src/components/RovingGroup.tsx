import type { JSX } from '@solidjs/web';
import { createEffect, createSignal } from 'solid-js';

/**
 * A group of controls that is a single tab stop, with the arrow keys moving
 * within it [U3-53]. Tabbing through 180 actions is not keyboard support.
 *
 * Exactly one control in the group carries `tabindex="0"` and the rest carry
 * `-1`; the arrow keys move that one and take focus with it. Unavailable
 * controls are part of the rotation, because [U3-29] keeps them focusable so a
 * keyboard player can reach the cell they are wondering about.
 *
 * The children render the controls and are free to arrange them — the factory
 * displays nest theirs one plate per display [U3-81] — because everything here
 * reads the DOM inside the container rather than a list of items. All the group
 * asks is that the control at position `i` carries `tabIndex(i)`, and that the
 * positions run `0 .. count - 1` in the order the controls appear.
 */
export function RovingGroup(props: {
  label: string;
  /** Stable across renders; how [U3-57] finds this group again after a ply. */
  group: string;
  /**
   * The arrangement this group brings with it, if it brings one.
   *
   * A board's rows are a column whether they are offered or shown, and under
   * [U3-86] it has to be the *same* column — so the class that arranges them is
   * the caller's to name, and lands on the container rather than on a wrapper
   * inside it that only one of the two configurations would have.
   */
  class?: string;
  /**
   * How many controls the children render. Checked against the DOM below,
   * because unlike the list this replaced it is a promise rather than a fact.
   */
  count: number;
  children: (tabIndex: (index: number) => number) => JSX.Element;
}): JSX.Element {
  const [active, setActive] = createSignal(0);
  let container!: HTMLDivElement;

  const controls = (): HTMLElement[] =>
    [...container.querySelectorAll<HTMLElement>('[data-roving]')];

  const moveTo = (index: number): void => {
    const all = controls();
    if (all.length === 0) return;
    const next = ((index % all.length) + all.length) % all.length;
    setActive(next);
    all[next].focus();
  };

  /**
   * Where the roving index is *now*, read off the DOM rather than off `active`.
   *
   * Writes are staged in Solid v2, so `active()` immediately after a `setActive`
   * still returns the previous index. Two arrow presses in one tick would then
   * both be computed from the same starting point and the second would undo the
   * first. The focused element is the truth here, and it is never stale.
   */
  const current = (): number => controls().indexOf(document.activeElement as HTMLElement);

  /**
   * Which control carries `tabindex="0"`, clamped into range.
   *
   * A group's controls come and go as the pools empty, so the index the arrows
   * last landed on can outlive the control it named. Without the clamp every
   * control in the group would carry `-1` and Tab would skip the group whole,
   * which is [U3-52] and [U3-53] silently broken.
   */
  const stop = (): number => Math.min(active(), Math.max(0, props.count - 1));

  /**
   * The children's half of the bargain, kept.
   *
   * `count` and the DOM are two statements of the same number, and when they
   * disagree the group fails in the way nobody notices: an overshoot puts the
   * tab stop on a control that does not exist, every control carries `-1`, and
   * Tab skips the group whole — [U3-52] and [U3-53] broken in silence, on
   * whichever board state the miscount happened to need. So it is checked,
   * after the render that would have caused it, and loudly. Development only:
   * a wrong tab order is not worth taking the game down over in front of a
   * player.
   */
  createEffect(
    () => props.count,
    (count) => {
      if (!import.meta.env.DEV) return;
      const rendered = controls().length;
      if (rendered !== count) {
        throw new Error(
          `roving group "${props.group}" declares ${count} controls but rendered ${rendered}`,
        );
      }
    },
  );

  const onKeyDown = (event: KeyboardEvent): void => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      const from = current();
      moveTo(from < 0 ? 0 : from + step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveTo(controls().length - 1);
    }
  };

  return (
    <div
      class={['roving-group', props.class ?? '']}
      role="group"
      aria-label={props.label}
      data-group={props.group}
      ref={container}
      onKeyDown={onKeyDown}
      onFocusIn={(event) => {
        const index = controls().indexOf(event.target as HTMLElement);
        if (index >= 0) setActive(index);
      }}
    >
      {props.children((index) => (stop() === index ? 0 : -1))}
    </div>
  );
}
