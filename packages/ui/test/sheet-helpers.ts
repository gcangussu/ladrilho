/**
 * Driving the new-game sheet the way a player does: by role and visible name.
 * Shared by every test that deals a game through it. (No requirement is cited
 * here: the traceability check reads every file in this directory, and a
 * helper is not a test of anything.)
 */

import { type render, within } from '@solidjs/testing-library';
import { flush } from 'solid-js';

type Screen = ReturnType<typeof render>;

/** Open the sheet from the top bar, and hand it back. */
export function openSheet(screen: Screen): HTMLElement {
  screen.getByRole('button', { name: 'New game' }).click();
  flush();
  return screen.getByRole('dialog', { name: 'New game' });
}

/** Make `seat` (0 or 1) the seat being edited. */
export function editSeat(sheet: HTMLElement, seat: 0 | 1): void {
  within(sheet).getByRole('button', { name: new RegExp(`^Player ${seat + 1}`) }).click();
  flush();
}

/** The radios offered for the seat being edited, in order. */
export function choices(sheet: HTMLElement): HTMLInputElement[] {
  const group = within(sheet).getByRole('group', { name: /^Player \d is$/ });
  return within(group).getAllByRole('radio') as HTMLInputElement[];
}

/** Each offered choice's short name, as the sheet shows it. */
export function choiceNames(sheet: HTMLElement): string[] {
  return choices(sheet).map((radio) => radio.closest('label')!.querySelector('.choice-name')!.textContent ?? '');
}

/** Choose a level (or 'human') for the seat being edited. */
export function choose(sheet: HTMLElement, value: string): void {
  const radio = choices(sheet).find((r) => r.value === value);
  if (!radio) throw new Error(`the sheet offers no ${value}`);
  radio.click();
  flush();
}

/** Commit a value into an input the way a player does: type, then leave it. */
export function commit(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  flush();
}

/** Press Deal. */
export function deal(sheet: HTMLElement): void {
  within(sheet).getByRole('button', { name: 'Deal' }).click();
  flush();
}
