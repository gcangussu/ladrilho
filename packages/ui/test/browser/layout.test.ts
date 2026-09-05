/**
 * The requirements jsdom cannot see [U3-73]: two viewports with a real layout
 * engine, and a real reload.
 *
 * The interface is loaded into an iframe rather than into the runner's own
 * page, for two reasons: the viewport can then be set exactly, and the iframe
 * can be reloaded without taking the test runner down with it.
 */

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
});

describe('a reload', () => {
  it('[U3-16] deals the URL’s seed again and restarts from the opening', async () => {
    const doc = await load(1280, 800);
    const status = (d: Document): string =>
      d.querySelector('[aria-label="Game status"]')?.textContent ?? '';
    const opening = status(doc);
    expect(opening).toContain(String(SEED));

    // Play a ply, so there is a position for a reload to fail to restore. Each
    // click is given a turn of the event loop: the interface renders on Solid's
    // own schedule, and the destinations only become available once the
    // selection has been published.
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
    expect(status(doc), 'the ply did not land').not.toBe(opening);

    const reloaded = await reload(frame!);

    // The deal comes back; the position does not [U3-16], [U3-17].
    expect(status(reloaded)).toBe(opening);
  });
});
