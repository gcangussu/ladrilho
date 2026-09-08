/**
 * The opponent against a **real worker**, in a real browser [W6-30].
 *
 * Everything else about *0006* is exercised in the fast suite through the
 * injected seam of [W6-18]. These four requirements cannot be: jsdom has no
 * `Worker`, no second thread to keep off, and no way to tell a search that ran
 * off-thread from one that did not. Asserting them there would be asserting
 * them about a stub.
 *
 * The interface is loaded into an iframe for the reasons `layout.test.ts` gives
 * — the viewport is exact and the frame can be torn down without taking the
 * runner with it. Here it also isolates the worker: terminating the frame ends
 * whatever it spawned.
 */

import { afterEach, describe, expect, it } from 'vitest';

const SEED = 909;

let frame: HTMLIFrameElement | null = null;

afterEach(() => {
  frame?.remove();
  frame = null;
});

/** Load the client with a seating, and resolve on its rendered board. */
function load(seating: string): Promise<{ doc: Document; win: Window }> {
  const el = document.createElement('iframe');
  frame = el;
  el.style.cssText = 'width:1280px;height:800px;border:0;position:fixed;left:0;top:0';
  el.src = `/index.html?seed=${SEED}&seating=${seating}`;
  const ready = new Promise<{ doc: Document; win: Window }>((resolve, reject) => {
    const deadline = Date.now() + 20_000;
    const poll = (): void => {
      const doc = el.contentDocument;
      const win = el.contentWindow;
      if (doc?.querySelector('[aria-label="Factory displays"] button') && win) {
        resolve({ doc, win });
      } else if (Date.now() > deadline) reject(new Error('the interface never rendered'));
      else setTimeout(poll, 25);
    };
    el.addEventListener('load', poll, { once: true });
    poll();
  });
  document.body.append(el);
  return ready;
}

/** Wait until `predicate` holds, or give up. */
async function until(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Tiles left on the board, read off the status the interface renders. */
function tilesLeft(doc: Document): number {
  const text = doc.querySelector('.status')?.textContent ?? '';
  return Number(/(\d+) tiles left/.exec(text)?.[1] ?? -1);
}

describe('the opponent against a real worker [W6-30]', () => {
  it('[W6-30] [W6-11] plays a move through a real worker', async () => {
    const { doc } = await load('sharp-human');
    // It says it is thinking, honestly, before any move arrives [W6-20].
    await until(
      () => /thinking/i.test(doc.querySelector('.status')?.textContent ?? ''),
      5_000,
      'the thinking indicator',
    );
    const before = tilesLeft(doc);
    expect(before).toBeGreaterThan(0);

    // And a real search, in a real worker, produces a real ply. `sharp` is the
    // shipped budget, so this is also [0004 B4-47] observed end to end.
    await until(() => tilesLeft(doc) < before, 20_000, 'the opponent to move');
    expect(tilesLeft(doc)).toBeLessThan(before);
  }, 60_000);

  /**
   * [W6-26], [W6-35], [W6-10]: the page stays alive while the search runs.
   *
   * Measured by driving a timer inside the frame and watching for a gap. A
   * search on the main thread would starve it — `sharp` is over a second of
   * solid work, so a gap anywhere near that size is the search running where it
   * must not. The threshold is generous on purpose: this is looking for a
   * frozen page, not for jitter.
   */
  it('[W6-30] [W6-26] [W6-35] [W6-10] keeps the main thread responsive while it thinks', async () => {
    const { doc, win } = await load('sharp-human');

    let worst = 0;
    let last = win.performance.now();
    const tick = (): void => {
      const now = win.performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    };
    const timer = win.setInterval(tick, 10);

    try {
      await until(
        () => /thinking/i.test(doc.querySelector('.status')?.textContent ?? ''),
        5_000,
        'the thinking indicator',
      );
      const before = tilesLeft(doc);
      await until(() => tilesLeft(doc) < before, 20_000, 'the opponent to move');
    } finally {
      win.clearInterval(timer);
    }

    // A `sharp` search is ~1.2s of work [0004 B4-47]; on the main thread the
    // gap would be that. Off it, the loop keeps running throughout.
    expect(worst, `longest main-thread gap was ${worst.toFixed(0)}ms`).toBeLessThan(400);
  }, 60_000);

  it('[W6-30] [W6-23] leaves the new-game control usable mid-search', async () => {
    const { doc } = await load('sharp-human');
    await until(
      () => /thinking/i.test(doc.querySelector('.status')?.textContent ?? ''),
      5_000,
      'the thinking indicator',
    );
    const control = doc.querySelector<HTMLButtonElement>('button.new-game');
    expect(control).not.toBeNull();
    expect(control!.disabled).toBe(false);
    // Clickable, and it actually deals: the player's way out of a long think.
    const seedBefore = doc.querySelector('.status')?.textContent ?? '';
    control!.click();
    await until(
      () => (doc.querySelector('.status')?.textContent ?? '') !== seedBefore,
      10_000,
      'a new game',
    );
  }, 60_000);
});
