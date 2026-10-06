/**
 * The opponent against a **real worker**, in a real browser [W6-30].
 *
 * Everything else about *0006* is exercised in the fast suite through the
 * injected seam of [W6-18]. These four requirements cannot be: jsdom has no
 * `Worker`, no second thread to keep off, and no way to tell a search that ran
 * off-thread from one that did not. Asserting them there would be asserting
 * them about a stub.
 *
 * What each player is asked to do here is [W6-30] as corrected: a tier plays a
 * **ply**, because it is stateless ([0004 B4-30]) and one real round-trip
 * through a real worker proves the wiring the fast suite's seam stands in for;
 * `expert` plays a **whole game**, because its sessions and their per-seat
 * lifetime ([W6-40]) exist only across one.
 *
 * The interface is loaded into an iframe for the reasons `layout.test.ts` gives
 * — the viewport is exact and the frame can be torn down without taking the
 * runner with it. Here it also isolates the worker: terminating the frame ends
 * whatever it spawned.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EXPERT_AVAILABLE } from '../../src/opponent.js';

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

/**
 * Tiles left on the board, read off the status the interface renders.
 *
 * Per paragraph, not off the whole block: `textContent` runs the lines
 * together, so "Round 5" followed by "0 tiles left…" reads as "50 tiles left".
 * The comparisons below survived that because a constant prefix cancels, but
 * the number was never the one on screen.
 */
function tilesLeft(doc: Document): number {
  for (const line of doc.querySelectorAll('.status p')) {
    const match = /^(\d+) tiles left/.exec(line.textContent ?? '');
    if (match !== null) return Number(match[1]);
  }
  return -1;
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

  /**
   * [W6-30] as extended by [0008 A8-33]: a complete game against a real worker
   * running `expert`.
   *
   * The only place any of it is real. The weights are a 630 KB module the
   * worker's bundle carries, the sessions of [W6-40] live for the worker's
   * lifetime, and intent 0006's one performance promise — the page stays alive
   * however long it thinks — is only observable off the main thread.
   */
  //
  // Skipped while the committed gate withdraws `expert` ([0008 A8-33]): the
  // URL may not seat a level the interface does not offer ([W6-4]), so the
  // game would be hot-seat and the case would time out waiting for a move,
  // failing for a reason that has nothing to do with [W6-30]. The answer is
  // the interface's own `EXPERT_AVAILABLE`, not a second reading of the file,
  // and `skipIf` makes the reporter say so rather than pass in silence.
  //
  // Seen to work, on a copy: with the condition inverted to
  // `skipIf(EXPERT_AVAILABLE)` the case runs, and fails as it did before.
  it.skipIf(!EXPERT_AVAILABLE)('[W6-30] [W6-40] plays a whole game against a real worker running expert', async () => {
    const { doc, win } = await load('expert-expert');

    let worst = 0;
    let last = win.performance.now();
    const timer = win.setInterval(() => {
      const now = win.performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 10);

    try {
      // Both seats are the expert, which is [W6-40]'s configuration: two
      // sessions in one worker, each asked only about its own seat.
      await until(
        () => /thinking/i.test(doc.querySelector('.status')?.textContent ?? ''),
        20_000,
        'the thinking indicator',
      );
      await until(
        () => /wins|draw/i.test(doc.querySelector('.game-over')?.textContent ?? ''),
        600_000,
        'the game to finish',
      );
    } finally {
      win.clearInterval(timer);
    }

    const status = doc.querySelector('.status')?.textContent ?? '';
    const verdict = doc.querySelector('.game-over')?.textContent ?? '';
    expect(tilesLeft(doc), `status was ${JSON.stringify(status)}`).toBe(0);
    expect(verdict, 'the verdict panel').toMatch(/wins|draw/i);
    // [W6-26], [W6-35]: however long it thought, the page never froze.
    expect(worst, `longest main-thread gap was ${worst.toFixed(0)}ms`).toBeLessThan(400);
  }, 900_000);

  it('[W6-30] [W6-23] leaves the new-game control usable mid-search, and plays on after it', async () => {
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
    const opening = tilesLeft(doc);
    // The control opens the sheet, and the sheet's Deal deals [W6-49]; both
    // stay live mid-search [W6-23].
    control!.click();
    await until(() => doc.querySelector('[role="dialog"][aria-labelledby]') !== null, 2_000, 'the sheet');
    const dealButton = [...doc.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === 'Deal',
    );
    expect(dealButton, 'no Deal in the sheet').toBeDefined();
    dealButton!.click();
    await until(
      () => (doc.querySelector('.status')?.textContent ?? '') !== seedBefore,
      10_000,
      'a new game',
    );
    // And the computer then plays in it. A New Game mid-search used to leave
    // two requests on one worker, the old reply settle both, and the new game
    // sit on "thinking" forever. Both deals are openings, so the count before
    // the click is the new game's too.
    //
    // Seen red, on a copy, with both halves of that fix reverted: `deal` not
    // terminating the worker [W6-13] *and* the seam's replies unrouted
    // [W6-42]. Either half alone keeps it green — the new request merely
    // waits behind the old search — so each is held by its own fast test.
    await until(() => tilesLeft(doc) < opening, 20_000, 'the opponent to move in the new game');
  }, 60_000);
});

/** Every resource the frame requested, by URL: the workers' scripts included. */
function requested(win: Window): string[] {
  return win.performance.getEntriesByType('resource').map((e) => e.name);
}

describe('the master against its real worker [0012 T12-30]', () => {
  /**
   * [W6-30] as extended by [0012 T12-30]: a complete game with `master` on
   * both seats, each at its own setting from the URL [W6-44], in the master
   * worker [W6-46] — the WebAssembly module and the trained weights loaded
   * from the bundle's bytes, and the page alive throughout [W6-26], [W6-35].
   */
  it('[W6-30] [W6-46] [W6-44] plays a whole game with master on both seats, at each seat\'s setting', async () => {
    const { doc, win } = await load('master-master&p1Simulations=100&p2Simulations=200');

    let worst = 0;
    let last = win.performance.now();
    const timer = win.setInterval(() => {
      const now = win.performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 10);

    try {
      await until(
        () => /wins|draw/i.test(doc.querySelector('.game-over')?.textContent ?? ''),
        600_000,
        'the game to finish',
      );
    } finally {
      win.clearInterval(timer);
    }

    expect(tilesLeft(doc)).toBe(0);
    expect(worst, `longest main-thread gap was ${worst.toFixed(0)}ms`).toBeLessThan(400);
    // The positive control for the next case: the master worker's script is
    // a resource this check can see when it is loaded.
    expect(requested(win).some((url) => url.includes('master-worker'))).toBe(true);
    expect(requested(win).some((url) => /\/worker\.ts/.test(url)), 'the tiers\' worker, in a game without a tier').toBe(false);
  }, 900_000);

  /**
   * [W6-46]: a game without a `master` seat never builds the master worker,
   * so it never loads the payload it carries.
   */
  it('[W6-46] loads nothing of the master in a game against sharp', async () => {
    // `sharp` opens, so a real ply arrives through the tiers' worker with no
    // person's move needed.
    const { doc, win } = await load('sharp-human');
    const before = tilesLeft(doc);
    await until(() => tilesLeft(doc) < before, 20_000, 'sharp to move');
    expect(requested(win).some((url) => /\/worker\.ts/.test(url)), "the tiers' worker").toBe(true);
    // The settings module is the main thread's to load [W6-46]; nothing else
    // of the package, and not the master worker, may be. Matched on the
    // package path, since a checkout's own directory may say "alphazero" too.
    const master = /master-worker|\/src\/masters\.ts|\/alphazero-bot\/web\/(?!settings\.ts)/;
    expect(requested(win).some((url) => url.includes('/alphazero-bot/web/settings.ts')), 'the control: settings is seen').toBe(true);
    expect(requested(win).filter((url) => master.test(url))).toEqual([]);
  }, 60_000);
});
