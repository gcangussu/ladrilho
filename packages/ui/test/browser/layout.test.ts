/**
 * The requirements jsdom cannot see [U3-73]: two viewports with a real layout
 * engine, and a real reload.
 *
 * The interface is loaded into an iframe rather than into the runner's own
 * page, for two reasons: the viewport can then be set exactly, and the iframe
 * can be reloaded without taking the test runner down with it.
 */

import { NUM_FACTORIES, NUM_ROWS } from 'engine';
import { afterEach, describe, expect, it } from 'vitest';

/** A laptop, and a phone held sideways [U3-58]. */
const VIEWPORTS = [
  { name: 'a laptop', width: 1280, height: 800 },
  { name: 'a phone held sideways', width: 844, height: 390 },
];

const SEED = 909;

let frame: HTMLIFrameElement | null = null;

afterEach(() => {
  frame?.remove();
  frame = null;
});

function load(width: number, height: number): Promise<Document> {
  const el = document.createElement('iframe');
  frame = el;
  el.style.cssText = `width:${width}px;height:${height}px;border:0;position:fixed;left:0;top:0`;
  el.src = `/index.html?seed=${SEED}`;
  const ready = settled(el);
  document.body.append(el);
  return ready;
}

/** Resolve once the interface inside `el` has rendered its board. */
function settled(el: HTMLIFrameElement): Promise<Document> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const poll = (): void => {
      const doc = el.contentDocument;
      if (doc?.querySelector('[aria-label="Factory displays"] button')) resolve(doc);
      else if (Date.now() > deadline) reject(new Error('the interface never rendered'));
      else setTimeout(poll, 25);
    };
    el.addEventListener('load', poll, { once: true });
    poll();
  });
}

/**
 * Reload the frame and resolve on the board the *new* document renders.
 *
 * Waiting for the `load` event first is the whole point: polling for a rendered
 * board would find the board that is still on screen from before the reload and
 * resolve against a document that is about to be thrown away — which is a test
 * that passes whether or not anything was persisted.
 */
function reload(el: HTMLIFrameElement): Promise<Document> {
  const loaded = new Promise<void>((resolve) =>
    el.addEventListener('load', () => resolve(), { once: true }),
  );
  el.contentWindow!.location.reload();
  return loaded.then(() => settled(el));
}

/**
 * Play one ply in `doc`, by clicking a source and then a legal destination.
 *
 * Each click is given a turn of the event loop: the interface renders on Solid's
 * own schedule, and the destinations only become available once the selection
 * has been published.
 */
async function playAPly(doc: Document): Promise<void> {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
  const source = doc.querySelector<HTMLElement>('[aria-label="Factory displays"] button');
  expect(source, 'no source control to click').not.toBeNull();
  source!.click();
  await tick();

  const dest = [
    ...doc.querySelectorAll<HTMLElement>('[data-group="destinations"] button'),
  ].find((control) => control.getAttribute('aria-disabled') === 'false');
  expect(dest, 'the selection made no destination available').toBeDefined();
  dest!.click();
  await tick();
}

describe('the board at a real size', () => {
  it.each(VIEWPORTS)('[U3-58] fits $name with no horizontal page scroll', async (viewport) => {
    const doc = await load(viewport.width, viewport.height);
    const root = doc.documentElement;
    expect(root.scrollWidth, `${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(
      root.clientWidth,
    );
  });

  it.each(VIEWPORTS)('[U3-59] gives every target 44 by 44 CSS pixels at $name', async (viewport) => {
    const doc = await load(viewport.width, viewport.height);
    const controls = [...doc.querySelectorAll<HTMLElement>('button')];
    expect(controls.length).toBeGreaterThan(5);
    const small = controls
      .map((control) => ({
        name: control.getAttribute('aria-label') ?? control.textContent ?? '',
        box: control.getBoundingClientRect(),
      }))
      .filter(({ box }) => box.width < 44 || box.height < 44)
      .map(({ name, box }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`);
    expect(small).toEqual([]);
  });

  it.each(VIEWPORTS)('[U3-81] leaves every display where it was at $name', async (viewport) => {
    const doc = await load(viewport.width, viewport.height);
    /** Where each display is, and how much room it takes — to the pixel. */
    const places = (): string[] =>
      [...doc.querySelectorAll<HTMLElement>('[data-group="factories"] [role="group"]')].map(
        (plate) => {
          const box = plate.getBoundingClientRect();
          return [
            plate.getAttribute('aria-label'),
            `at ${Math.round(box.x)},${Math.round(box.y)}`,
            `${Math.round(box.width)}x${Math.round(box.height)}`,
          ].join(' ');
        },
      );

    const before = places();
    expect(before).toHaveLength(NUM_FACTORIES);

    await playAPly(doc);

    // The ply emptied the display it took from — which is the whole hazard: a
    // plate sized to what it holds collapses, and the rest slide along.
    const emptied = [
      ...doc.querySelectorAll<HTMLElement>('[data-group="factories"] [role="group"]'),
    ].filter((plate) => plate.querySelectorAll('button').length === 0);
    expect(emptied, 'no display was emptied, so nothing was tested').toHaveLength(1);
    expect(places()).toEqual(before);

    // Every number is on screen, not merely in the markup — checked after the
    // ply, so it covers the display that has just emptied as well. `textContent`
    // in the fast lane cannot tell a caption from a hidden one, and a caption
    // nobody can see is the defect [U3-81] was written about.
    const captions = [...doc.querySelectorAll<HTMLElement>('.display-name')];
    expect(captions.length).toBeGreaterThanOrEqual(NUM_FACTORIES);
    const unseen = captions
      .filter((caption) => {
        const box = caption.getBoundingClientRect();
        return (
          box.width === 0 || box.height === 0 || getComputedStyle(caption).visibility !== 'visible'
        );
      })
      .map((caption) => caption.textContent);
    expect(unseen, 'display captions that are in the markup but not on screen').toEqual([]);
  });
});

/**
 * A board's parts, found the way this lane can find them.
 *
 * [U3-68] wants elements located by role and visible text, and these are as
 * close to that as a layout measurement gets: the board and the wall by their
 * accessible names, and the five pattern lines by `data-row`, which is the one
 * hook both configurations of [U3-86] carry — a `<button>` on the board of the
 * player to move and a `<div>` on the other. Reaching for `.pattern-line`
 * instead would be reaching for the very class under test.
 */
function board(doc: Document, who: string): HTMLElement {
  const section = doc.querySelector<HTMLElement>(`section[aria-label="${who}"]`);
  expect(section, `no board for ${who}`).not.toBeNull();
  return section!;
}

function patternRows(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('[data-row]')];
}

function wallRows(el: HTMLElement): HTMLElement[] {
  const wall = el.querySelector<HTMLElement>('[role="group"][aria-label$="wall"]');
  expect(wall, 'no wall').not.toBeNull();
  return [...wall!.children] as HTMLElement[];
}

/** The play area [U3-86] is about: the lines and the wall, and nothing else. */
function playArea(el: HTMLElement): HTMLElement {
  const play = el.querySelector<HTMLElement>('.board-play');
  expect(play, 'no play area').not.toBeNull();
  return play!;
}

const height = (el: HTMLElement): number => Math.round(el.getBoundingClientRect().height);

/**
 * Mutation records for the four assertions below, in the manner of
 * [0007 S7-31]: each was applied to a `git archive HEAD` copy, run, and seen to
 * fail exactly what it names. Re-run them if the rules they point at move.
 *
 * | Mutation in `src/styles.css` | Fails |
 * | --- | --- |
 * | `.destination`: `padding: 0` → `0.25rem`, `border: 0` → `2px solid var(--line)` | both [U3-86] |
 * | `.lines, .pattern-lines, .wall`: drop `.wall` from the selector | [U3-88] |
 * | `.board-play`: `flex-wrap: wrap` → `nowrap` | [U3-89], and [U3-58] with it |
 * | `.pattern-lines`: `align-items: flex-end` → `flex-start` | [U3-88] |
 *
 * The first of those is why the ply assertion measures `.board-play`: against
 * the whole board section it stayed green, both boards being grid items that
 * `align-items: stretch` pins to one height whatever they hold.
 */
describe('a board that holds still', () => {
  it.each(VIEWPORTS)('[U3-86] is the same size to move as waiting, at $name', async (viewport) => {
    const doc = await load(viewport.width, viewport.height);

    // At the opening the two boards hold the same nothing and differ only in
    // whose turn it is, which is the whole of what [U3-86] forbids mattering.
    const mover = board(doc, 'Player 1');
    const waiting = board(doc, 'Player 2');
    expect(mover.querySelector('[data-group="destinations"]'), 'Player 1 is not to move').not
      .toBeNull();
    expect(waiting.querySelector('[data-group="destinations"]'), 'Player 2 is to move too').toBeNull();

    expect(height(playArea(mover)), 'the offered play area against the shown one').toBe(
      height(playArea(waiting)),
    );
  });

  it.each(VIEWPORTS)('[U3-86] does not resize either play area when the turn passes, at $name',
    async (viewport) => {
      const doc = await load(viewport.width, viewport.height);
      const areas = (): number[] =>
        ['Player 1', 'Player 2'].map((who) => height(playArea(board(doc, who))));
      const before = areas();

      await playAPly(doc);

      // The turn has moved, so both boards have changed configuration — the
      // one that was offering its rows is now showing them, and the other way
      // about. Neither may have changed size for it.
      expect(board(doc, 'Player 2').querySelector('[data-group="destinations"]'),
        'the ply did not pass the turn').not.toBeNull();
      expect(areas()).toEqual(before);

      // The play area and not the whole board, because the whole board cannot
      // fail: the two are grid items on one row and `align-items: stretch`
      // makes them the same height whatever they hold. This assertion passed
      // under the very defect it names until the mutation of [U3-86] showed it
      // could not fail, which is what that record is for.
    });

  it('[U3-88] lays every pattern line level with the wall row it feeds, at a laptop', async () => {
    const doc = await load(1280, 800);

    // Both configurations: the board of the player to move, whose rows are the
    // six controls of [U3-79], and the board that is only showing them.
    for (const who of ['Player 1', 'Player 2']) {
      const el = board(doc, who);
      const lines = patternRows(el);
      const wall = wallRows(el);
      expect(lines, who).toHaveLength(NUM_ROWS);
      expect(wall, who).toHaveLength(NUM_ROWS);

      const levels = lines.map((line, r) => {
        const a = line.getBoundingClientRect();
        const b = wall[r].getBoundingClientRect();
        return [Math.round(a.top - b.top), Math.round(a.height - b.height)];
      });
      expect(levels, `${who}: [top, height] of each pattern line against its wall row`).toEqual(
        levels.map(() => [0, 0]),
      );

      // Level, and filling toward the wall: every line ends on the same edge,
      // and that edge is the wall's. Checking only that the lines are somewhere
      // to the left would pass on a column of rows aligned the other way, whose
      // filled ends are then five different distances from the cells they feed.
      const rights = lines.map((line) => Math.round(line.getBoundingClientRect().right));
      const wallLeft = Math.round(wall[0].getBoundingClientRect().left);
      expect([...new Set(rights)], `${who}: the lines do not share a right edge`).toHaveLength(1);
      expect(rights[0], `${who}: the lines are not left of the wall`).toBeLessThanOrEqual(wallLeft);
      expect(wallLeft - rights[0], `${who}: the lines are not beside the wall`).toBeLessThan(44);
    }
  });

  it('[U3-89] stacks the lines and the wall where the board is too narrow', async () => {
    const doc = await load(844, 390);
    for (const who of ['Player 1', 'Player 2']) {
      const el = board(doc, who);
      const lines = patternRows(el)[0].getBoundingClientRect();
      const wall = wallRows(el)[0].getBoundingClientRect();
      expect(Math.round(wall.top), `${who}: the wall did not wrap below the lines`).toBeGreaterThan(
        Math.round(lines.top),
      );
      expect(Math.round(wall.left), `${who}: the wall did not wrap below the lines`).toBeLessThan(
        Math.round(lines.right),
      );
    }
  });
});

describe('a reload', () => {
  it('[U3-16] deals the URL’s seed again and restarts from the opening', async () => {
    const doc = await load(1280, 800);
    const status = (d: Document): string =>
      d.querySelector('[aria-label="Game status"]')?.textContent ?? '';
    const opening = status(doc);
    expect(opening).toContain(String(SEED));

    // Play a ply, so there is a position for a reload to fail to restore.
    await playAPly(doc);
    expect(status(doc), 'the ply did not land').not.toBe(opening);

    const reloaded = await reload(frame!);

    // The deal comes back; the position does not [U3-16], [U3-17].
    expect(status(reloaded)).toBe(opening);
  });
});
