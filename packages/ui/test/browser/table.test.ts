/**
 * The table in a real browser [U3-73]: the arrangements of [U3-95], the rails
 * of [U3-98], the strip's size half of [U3-99], and the docked board and its
 * curtain [U3-103]. jsdom has no layout and no `ResizeObserver`, so in the fast
 * suite the arrangement is always `wide` and none of this is visible.
 *
 * The interface is loaded into an iframe sized exactly, as `layout.test` does.
 */

import { afterEach, describe, expect, it } from 'vitest';

let frame: HTMLIFrameElement | null = null;

afterEach(() => {
  frame?.remove();
  frame = null;
});

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Load the interface at a size and resolve once it has settled on an arrangement. */
async function load(width: number, height: number, search = '?seed=909&seating=human-human'): Promise<Document> {
  frame?.remove();
  const el = document.createElement('iframe');
  frame = el;
  el.style.cssText = `width:${width}px;height:${height}px;border:0;position:fixed;left:0;top:0`;
  el.src = `/index.html${search}`;
  document.body.append(el);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const doc = el.contentDocument;
    if (doc?.querySelector('[aria-label="Factory displays"] button')) {
      // The arrangement is measured after the first paint; give it a frame.
      await tick(100);
      return doc;
    }
    if (Date.now() > deadline) throw new Error('the interface never rendered');
    await tick(25);
  }
}

const arrangement = (doc: Document): string | undefined =>
  doc.querySelector<HTMLElement>('main')?.dataset['layout'];

/** Wait for the arrangement to become `want`, which a resize observer delivers late. */
async function settleOn(doc: Document, want: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (arrangement(doc) !== want && Date.now() < deadline) await tick(25);
  expect(arrangement(doc)).toBe(want);
}

function board(doc: Document, who: string): HTMLElement {
  const section = doc.querySelector<HTMLElement>(`section[aria-label="${who}"]`);
  expect(section, `no board for ${who}`).not.toBeNull();
  return section!;
}

const height = (el: Element): number => Math.round(el.getBoundingClientRect().height);

const available = (el: Element): boolean => el.getAttribute('aria-disabled') === 'false';

/** Click the first available pick. */
async function pick(doc: Document): Promise<void> {
  const source = [...doc.querySelectorAll<HTMLElement>('[aria-label="Factory displays"] button')]
    .find(available);
  expect(source, 'no available source').toBeDefined();
  source!.click();
  await tick();
}

/** Play one ply by clicks, the way `layout.test` does. */
async function playAPly(doc: Document): Promise<void> {
  await pick(doc);
  const dest = [...doc.querySelectorAll<HTMLElement>('[data-group="destinations"] button')]
    .find(available);
  expect(dest, 'the selection made no destination available').toBeDefined();
  dest!.click();
  await tick();
}

/** A board row: one of the six destinations of [U3-79], held to 32px tall rather than 44 [U3-59]. */
const isRow = (control: HTMLElement): boolean => control.closest('[data-group="destinations"]') !== null;

const curtain = (doc: Document): HTMLElement | null =>
  doc.querySelector<HTMLElement>('[role="dialog"][aria-label="Pass the device"]');

describe('the arrangements [U3-95]', () => {
  const SIZES = [
    { width: 1280, height: 800, layout: 'wide' },
    { width: 844, height: 390, layout: 'side' },
    { width: 390, height: 844, layout: 'stack' },
  ];

  it.each(SIZES)('[U3-95] is $layout at $width × $height, and the page does not scroll',
    async ({ width, height: tall, layout }) => {
      const doc = await load(width, tall);
      await settleOn(doc, layout);
      const root = doc.documentElement;
      expect(root.scrollHeight, 'scrolls vertically at the opening').toBeLessThanOrEqual(root.clientHeight);
      expect(root.scrollWidth, 'scrolls sideways at the opening').toBeLessThanOrEqual(root.clientWidth);

      // And after a ply, when a strip says what was played and, between two
      // people on a docked arrangement, the curtain has come and gone.
      await playAPly(doc);
      curtain(doc)?.querySelector('button')?.click();
      await tick();
      expect(root.scrollHeight, 'scrolls vertically after a ply').toBeLessThanOrEqual(root.clientHeight);
    });

  // Seen red, on a copy, with the thinking pill visible again: 870 against 844.
  // Found by looking, not by this suite: hot-seat never thinks, and the top
  // bar's thinking pill wrapped the phone's top bar onto a third line.
  it('[U3-95] does not scroll on a phone while the computer is thinking', async () => {
    const doc = await load(390, 844, '?seed=12&seating=human-master&p2Simulations=200000');
    await settleOn(doc, 'stack');
    await playAPly(doc);
    const deadline = Date.now() + 5_000;
    while (!/thinking/.test(doc.querySelector('[aria-label="Game status"]')?.textContent ?? '')) {
      if (Date.now() > deadline) throw new Error('the computer never started thinking');
      await tick(25);
    }
    const root = doc.documentElement;
    expect(root.scrollHeight, 'scrolls vertically while thinking').toBeLessThanOrEqual(root.clientHeight);
  });

  // Seen red, on a copy, with the ring's width threshold raised past 768: the
  // rows at 768 × 1024 — and the other way, with the board's tiles left at
  // 2.5rem beside the ring: the page at 1026 against 1024.
  it('[U3-95] sets the factories round the centre on an upright tablet, and still fits', async () => {
    const doc = await load(768, 1024);
    await settleOn(doc, 'stack');
    expect(doc.querySelector<HTMLElement>('main')?.dataset['table']).toBe('ring');
    const root = doc.documentElement;
    expect(root.scrollHeight, 'the ring pushed the page past the screen').toBeLessThanOrEqual(root.clientHeight);
    // And a phone keeps its rows.
    const phone = await load(390, 844);
    await settleOn(phone, 'stack');
    expect(phone.querySelector<HTMLElement>('main')?.dataset['table']).toBe('rows');
  });

  // Seen red, on a copy, with the landscape condition dropped: `side` at
  // 938 × 1226, the factories scrolling sideways in a squeezed middle column.
  it('[U3-95] stacks on an upright screen wide enough for side, and nothing overflows', async () => {
    const doc = await load(938, 1226);
    await settleOn(doc, 'stack');
    const root = doc.documentElement;
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight);
    const table = doc.querySelector<HTMLElement>('.table')!;
    expect(table.scrollWidth, 'the factories overflow their row').toBeLessThanOrEqual(table.clientWidth);
  });

  // Seen red, on a copy, with the probe measured in pixels instead of root ems
  // (`em` fixed at 16): the arrangement stayed `wide` at a 20px root.
  it('[U3-95] decides the arrangement in root ems, not in pixels', async () => {
    const doc = await load(1280, 800);
    await settleOn(doc, 'wide');
    // 1280 pixels is 64 root ems at a 20px root: under `wide`'s 77.
    doc.documentElement.style.fontSize = '20px';
    await settleOn(doc, 'side');
    doc.documentElement.style.fontSize = '';
    await settleOn(doc, 'wide');
  });
});

describe('the new-game sheet at a real size [W6-49]', () => {
  // Seen red, on a copy, with the short-height sticky Deal removed: 512 against 390.
  // Found by looking: at 844 × 390 the sheet scrolled and Deal sat below its
  // fold, and at 390 × 844 the master's setting pushed it off the bottom.
  it.each([
    { width: 1280, height: 800, layout: 'wide' },
    { width: 844, height: 390, layout: 'side' },
    { width: 390, height: 844, layout: 'stack' },
  ])('[W6-49] keeps Deal on screen with a master seat being edited, at $width × $height',
    async ({ width, height: tall, layout }) => {
      const doc = await load(width, tall, '?seed=909&seating=human-master');
      await settleOn(doc, layout);
      [...doc.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'New game')!.click();
      await tick(80);
      const sheet = doc.querySelector<HTMLElement>('[role="dialog"]');
      expect(sheet, 'the sheet did not open').not.toBeNull();
      [...sheet!.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^2\s*Player 2/.test(b.textContent ?? ''))!.click();
      await tick(80);
      expect(sheet!.querySelector('input[type="range"]'), 'no master setting on show').not.toBeNull();
      const dealButton = [...sheet!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Deal')!;
      const box = dealButton.getBoundingClientRect();
      // On screen, and the top of the sheet's stack at its centre: not under
      // anything else.
      expect(box.top, 'Deal starts below the screen').toBeGreaterThanOrEqual(0);
      expect(box.bottom, 'Deal ends below the screen').toBeLessThanOrEqual(tall);
      const hit = doc.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      expect(hit?.closest('button'), 'something covers Deal').toBe(dealButton);
      // And every control in it is a target a finger can take [U3-59].
      const small = [...sheet!.querySelectorAll<HTMLElement>('button, input:not([type="radio"]), label.choice')]
        .filter((el) => el.getBoundingClientRect().height < 44)
        .map((el) => `${el.className || el.tagName}: ${Math.round(el.getBoundingClientRect().height)}`);
      expect(small).toEqual([]);
    });
});

describe('the result of a game on a docked arrangement [U3-95]', () => {
  // Seen red, on a copy, with the table's row not given the screen's spare
  // height: at 768 × 1024 the lines scrolled, 76 pixels of them in 50.
  it.each([
    { width: 768, height: 1024, layout: 'stack', whole: true },
    { width: 390, height: 844, layout: 'stack', whole: false },
    { width: 844, height: 390, layout: 'side', whole: false },
  ])('[U3-95] fits the screen at $width × $height, and shows every line where there is room',
    async ({ width, height: tall, layout, whole }) => {
      const doc = await load(width, tall, '?seed=12&seating=easy-easy');
      await settleOn(doc, layout);
      const deadline = Date.now() + 40_000;
      while (!doc.querySelector('[aria-label="Final result"]')) {
        if (Date.now() > deadline) throw new Error('the game never ended');
        await tick(100);
      }
      await tick(100);
      const root = doc.documentElement;
      expect(root.scrollHeight, 'the result pushed the page past the screen').toBeLessThanOrEqual(root.clientHeight);
      const lines = doc.querySelector<HTMLElement>('[aria-label="Final result"] ul')!;
      if (whole) {
        expect(lines.scrollHeight, 'the lines scroll though the screen has room').toBeLessThanOrEqual(lines.clientHeight);
      }
    }, 60_000);
});

describe('rails [U3-98]', () => {
  /** The centre of cell `col` of wall row `r` on a board. */
  function wallCell(el: HTMLElement, r: number, col: number): { x: number; y: number } {
    const wall = el.querySelector<HTMLElement>('[role="group"][aria-label$="wall"]')!;
    const cell = (wall.children[r] as HTMLElement).children[col] as HTMLElement;
    const box = cell.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  // Seen red, on a copy, with the wall's `pointer-events: none` removed: the
  // press landed on the wall cell and nothing was placed.
  it('[U3-98] lets a press on a wall row choose the pattern line that feeds it', async () => {
    const doc = await load(1280, 800);
    await settleOn(doc, 'wide');
    const mine = board(doc, 'Player 1');

    // At rest no row is available, so the wall is only a wall.
    const at = wallCell(mine, 2, 2);
    expect(doc.elementFromPoint(at.x, at.y)?.closest('button'), 'a control under the wall at rest')
      .toBeNull();

    await pick(doc);
    const line = mine.querySelector<HTMLElement>('[data-row="2"]')!;
    expect(available(line), 'pattern line 3 does not take this pick').toBe(true);
    const hit = doc.elementFromPoint(at.x, at.y);
    expect(hit?.closest('button'), 'the press does not reach pattern line 3').toBe(line);

    (hit as HTMLElement).click();
    await tick();
    // The board is no longer the mover's, so its rows are shown now and not
    // offered: a fresh element, named the same way [U3-93].
    expect(mine.querySelector('[data-row="2"]')?.textContent, 'nothing was placed').toMatch(/holds \d/);
  });

  /** Where a lit row's drawn highlight starts and ends, in the page. */
  function lit(el: HTMLElement): { left: number; right: number } {
    const box = el.getBoundingClientRect();
    const before = getComputedStyle(el, '::before');
    return { left: box.left + parseFloat(before.left), right: box.right - parseFloat(before.right) };
  }

  // Seen red, on a copy, with the rail's outset inside its `min()` again: at
  // all four sizes the rail ended on the wall's edge, its border half cut.
  it.each([
    { width: 1280, height: 800, layout: 'wide' },
    { width: 1024, height: 768, layout: 'side' },
    { width: 844, height: 390, layout: 'side' },
    { width: 390, height: 844, layout: 'stack' },
  ])('[U3-98] [U3-99] lights a rail past the wall and inside the board, the floor and the strip level with it, at $width × $height',
    async ({ width, height: tall, layout }) => {
      const doc = await load(width, tall);
      await settleOn(doc, layout);
      await pick(doc);
      const mine = board(doc, 'Player 1');
      const inner = mine.getBoundingClientRect();
      const wall = mine.querySelector<HTMLElement>('[role="group"][aria-label$="wall"]')!.getBoundingClientRect();
      const rail = lit(mine.querySelector<HTMLElement>('[data-row="0"]')!);
      const floor = lit(mine.querySelector<HTMLElement>('.floor-row')!);
      // The same outset as at its left end, not a sliver: a sub-pixel margin
      // is a border drawn half off the edge.
      expect(rail.right - wall.right, 'the rail has no outset past the wall').toBeGreaterThanOrEqual(4);
      expect(rail.right, 'the rail runs past the board').toBeLessThan(inner.right);
      expect(Math.round(floor.left), 'the floor is not level with the rails').toBe(Math.round(rail.left));
      // And the strip saying what is held runs edge to edge with them [U3-99].
      // Seen red, on a copy, with the docked strip set at the board's padding
      // again: 5px in from the rails on each side, at all three docked sizes.
      const strip = mine.querySelector<HTMLElement>('.hand')!.getBoundingClientRect();
      expect([Math.round(strip.left), Math.round(strip.right)], 'the strip is not edge to edge with the rails')
        .toEqual([Math.round(rail.left), Math.round(rail.right)]);
    });

  it('[U3-98] runs the floor line under both columns, and no wider than the board', async () => {
    const doc = await load(1280, 800);
    await settleOn(doc, 'wide');
    for (const who of ['Player 1', 'Player 2']) {
      const el = board(doc, who);
      const wall = el.querySelector<HTMLElement>('[role="group"][aria-label$="wall"]')!;
      // By class, as `layout.test`'s play area is: the shown board's floor group
      // and the offered board's floor block are the same element only by class.
      const block = el.querySelector<HTMLElement>('.floor-block')!;
      expect(Math.round(block.getBoundingClientRect().right), who)
        .toBeGreaterThanOrEqual(Math.round(wall.getBoundingClientRect().right) - 1);
      expect(block.getBoundingClientRect().right, who)
        .toBeLessThanOrEqual(el.getBoundingClientRect().right);
    }
  });
});

describe("the strip's size [U3-99]", () => {
  it.each([
    { width: 1280, height: 800, layout: 'wide' },
    { width: 390, height: 844, layout: 'stack' },
  ])('[U3-99] holding tiles does not change the size of the board, at $width × $height',
    async ({ width, height: tall, layout }) => {
      const doc = await load(width, tall);
      await settleOn(doc, layout);
      const mine = board(doc, 'Player 1');
      const before = [height(mine), Math.round(mine.getBoundingClientRect().width)];
      await pick(doc);
      expect(mine.textContent, 'nothing is held').toContain('Holding');
      expect([height(mine), Math.round(mine.getBoundingClientRect().width)]).toEqual(before);
    });
});

describe('the docked board and the curtain [U3-103]', () => {
  /** Which board is drawn full size: the taller of the two. */
  const docked = (doc: Document): string =>
    height(board(doc, 'Player 1')) > height(board(doc, 'Player 2')) ? 'Player 1' : 'Player 2';

  // Seen red, on a copy, with `setCurtain(mover)` replaced by `setShown(mover)`:
  // the boards changed places in plain view and no curtain came up.
  it('[U3-103] swaps the boards of two people only behind the curtain', async () => {
    const doc = await load(390, 844);
    await settleOn(doc, 'stack');
    expect(docked(doc)).toBe('Player 1');
    expect(curtain(doc)).toBeNull();

    await playAPly(doc);
    const shown = curtain(doc);
    expect(shown, 'no curtain after the turn passed').not.toBeNull();
    expect(shown!.textContent).toContain('Player 2');
    expect(shown!.getAttribute('aria-modal')).toBe('true');
    // Behind it, nothing has moved and nothing can be reached.
    expect(docked(doc), 'the boards changed places in front of the player').toBe('Player 1');
    expect(board(doc, 'Player 1').closest('[inert]'), 'the page under the curtain is live').not
      .toBeNull();
    expect(doc.activeElement, 'focus is not on the curtain').toBe(shown!.querySelector('button'));

    shown!.querySelector<HTMLElement>('button')!.click();
    await tick();
    expect(curtain(doc)).toBeNull();
    expect(docked(doc)).toBe('Player 2');
    expect(doc.querySelector('[inert]'), 'the page stayed inert').toBeNull();
  });

  it('[U3-103] raises no curtain where both boards are full size', async () => {
    const doc = await load(1280, 800);
    await settleOn(doc, 'wide');
    await playAPly(doc);
    expect(curtain(doc)).toBeNull();
    expect(height(board(doc, 'Player 1'))).toBe(height(board(doc, 'Player 2')));
  });

  it('[U3-103] docks the person against a computer, and keeps it docked through its move',
    async () => {
      const doc = await load(390, 844, '?seed=909&seating=human-easy');
      await settleOn(doc, 'stack');
      expect(docked(doc)).toBe('Player 1');
      await playAPly(doc);
      // The computer answers from its worker; wait for the turn to come back.
      const deadline = Date.now() + 15_000;
      while (!/Player 1 to move/.test(doc.querySelector('[aria-label="Game status"]')?.textContent ?? '')) {
        if (Date.now() > deadline) throw new Error('the computer never moved');
        await tick(50);
      }
      expect(curtain(doc)).toBeNull();
      expect(docked(doc)).toBe('Player 1');
    });

  it('[U3-103] [U3-59] keeps every control on a docked arrangement at 44 by 44, a row at 32 tall', async () => {
    const doc = await load(390, 844);
    await settleOn(doc, 'stack');
    const small = [...doc.querySelectorAll<HTMLElement>('button')]
      .map((control) => ({ control, name: control.getAttribute('aria-label') ?? control.textContent ?? '', box: control.getBoundingClientRect() }))
      // A board's rows are the one exception, and have their own floor.
      .filter(({ control, box }) => (isRow(control) ? box.height < 32 : box.width < 44 || box.height < 44))
      .map(({ name, box }) => `${name}: ${Math.round(box.width)}x${Math.round(box.height)}`);
    expect(small).toEqual([]);
  });
});
