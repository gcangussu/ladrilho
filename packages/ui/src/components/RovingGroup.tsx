import type { JSX } from '@solidjs/web';
import { For, createSignal } from 'solid-js';

/**
 * A group of controls that is a single tab stop, with the arrow keys moving
 * within it [U3-53]. Tabbing through 180 actions is not keyboard support.
 *
 * Exactly one control in the group carries `tabindex="0"` and the rest carry
 * `-1`; the arrow keys move that one and take focus with it. Unavailable
 * controls are part of the rotation, because [U3-29] keeps them focusable so a
 * keyboard player can reach the cell they are wondering about.
 */
export function RovingGroup<T>(props: {
  label: string;
  /** Stable across renders; how [U3-57] finds this group again after a ply. */
  group: string;
  items: T[];
  /**
   * Children receive an **accessor**, not a value. `<For keyed={false}>` hands
   * its callback an accessor in Solid v2, and calling it here — outside any
   * tracking scope — would freeze every control at the value it had when the
   * group was first built. Read it inside JSX instead.
   */
  children: (item: () => T, index: number, tabIndex: () => number) => JSX.Element;
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
  const stop = (): number => Math.min(active(), Math.max(0, props.items.length - 1));

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
      class="roving-group"
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
      <For each={props.items} keyed={false}>
        {(item, index) => props.children(item, index, () => (stop() === index ? 0 : -1))}
      </For>
    </div>
  );
}
