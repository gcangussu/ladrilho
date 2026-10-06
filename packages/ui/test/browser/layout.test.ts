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

/** A board row: one of the six destinations of [U3-79], held to 32px tall rather than 44 [U3-59]. */
const isRow = (control: HTMLElement): boolean => control.closest('[data-group="destinations"]') !== null;

describe('the board at a real size', () => {
  it.each(VIEWPORTS)('[U3-58] fits $name with no horizontal page scroll', async (viewport) => {
    const doc = await load(viewport.width, viewport.height);
    const root = doc.documentElement;
    expect(root.scrollWidth, `${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(
      root.clientWidth,
    );
  });

  it.each(VIEWPORTS)('[U3-59] gives every target 44 by 44 CSS pixels, and a board row 32 tall, at $name', async (viewport) => {
    const doc = await load(viewport.width, viewport.height);
    const controls = [...doc.querySelectorAll<HTMLElement>('button')];
    expect(controls.length).toBeGreaterThan(5);
    const small = controls
      .map((control) => ({
        control,
        name: control.getAttribute('aria-label') ?? control.textContent ?? '',
        box: control.getBoundingClientRect(),
      }))
      // A board's rows are the one exception, and have their own floor.
      .filter(({ control, box }) => (isRow(control) ? box.height < 32 : box.width < 44 || box.height < 44))
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

/** Are this board's lines and wall on one row, or has the wall wrapped below? */
function sideBySide(el: HTMLElement): boolean {
  return (
    Math.round(patternRows(el)[0].getBoundingClientRect().top) ===
    Math.round(wallRows(el)[0].getBoundingClientRect().top)
  );
}

/**
 * The play area [U3-86] is about: the lines and the wall, and nothing else.
 *
 * By class, and deliberately, which is the one place this file departs from the
 * rule above — `.board-play` is the arrangement under test, so this is exactly
 * the objection made against `.pattern-line`, one level up. The alternative is
 * to give it `role="group"` and a name, and that is the reason not to: a board
 * already announces three groups to a screen reader, and a fourth wrapping the
 * other two would be a landmark that exists to be measured. The test takes the
 * awkward selector so the board does not take the extra announcement.
 */
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
 * | Mutation | Fails |
 * | --- | --- |
 * | `.destination`: `padding: 0` → `0.25rem`, `border: 0` → `2px solid var(--rule)` | one [U3-86] (the turn passing) |
 * | `.lines, .pattern-lines, .wall`: drop `.wall` from the selector | [U3-88] |
 * | `.board-play`: `flex-wrap: wrap` → `nowrap` | [U3-89], and [U3-58] with it |
 * | `.pattern-line`: `justify-content: flex-end` → `flex-start` | both [U3-92] |
 * | `.pattern-lines`: `align-items: flex-end` → `flex-start` | **nothing** — see below |
 * | `.board-play`: `nowrap` plus `@media (max-width: 900px) { flex-direction: column }` | [U3-89] alone |
 * | `.board-play`: `nowrap` plus `@media (max-width: 56.25rem)` — a **rem** breakpoint | [U3-89] alone |
 * | `App.tsx`: `WIDE_FROM = 77` → `40` (two full boards down to 640px) | [U3-94] alone |
 * | `--lines-width`: `5 * --tile + 4 * --tile-gap` → `4 * … + 3 * …` (under-measures) | [U3-94] |
 * | `--lines-width`: → `6 * … + 5 * …` (over-measures) | **nothing** — see below |
 * | `--panel-pad`: `0.875rem` → `2rem` | **nothing** — see below |
 * | `--row: max(calc(--tile + 0.35rem + 2px), 32px)` → the calc alone, `.destination { min-height: 32px }` | [U3-86] at 12px |
 *
 * Re-run in full when the table redesign ([U3-95]) moved the code they name:
 * the columns became five tiles wide, `--tile` split into `--tile` and `--row`,
 * `.boards` went, and which arrangement seats two boards became a width in root
 * ems in `App.tsx`. Two rows changed what they say, and both are worth reading.
 *
 * `.pattern-lines`' `align-items` used to be the [U3-92] mutation and now breaks
 * nothing: a row is as wide as its column, so the five rows share a right edge
 * whatever the column does. That is also why [U3-92] measures each line's last
 * tile now and not the line — measuring the row passed with the tiles filling
 * from the left, which is the `justify-content` row above.
 *
 * `WIDE_FROM` at 55 also broke nothing, and correctly: two boards still fit
 * whole at the widths the sweep visits above 880. It has to fall below the
 * width two boards need — 40 seats them at 700 — before a play area comes apart.
 *
 * Two are worth keeping for what they are rather than for what they break. The
 * media query is a working layout, and it fails [U3-89] and nothing else, which
 * is what says that requirement is asserted rather than claimed. The `WIDE_FROM`
 * one is the descendant of a layout that actually shipped for a while — two
 * boards seated on a row too narrow for either — which looked right at 1280 and
 * at 390 and was wrong across the whole band between, which is why it took a
 * person looking at the page to find it and why the sweep exists now.
 *
 * The rem breakpoint is worth its row on its own. It is the mutation a reader
 * reaches for on being told a root font-size defeats a media query — and it
 * fails [U3-89], because a rem in a media query resolves against the initial
 * font-size and not against a declaration. Recorded so nobody has to rediscover
 * that the hard way.
 *
 * The `--lines-width` and `--panel-pad` rows are about `--board-width`, which
 * restates what the two columns are made of. Two of them stay green, and both
 * greens are the point.
 *
 * `--panel-pad` is *used* by `--board-width` rather than copied into it, so
 * moving it moves both together and there is no drift to catch — that class of
 * staleness was removed by composing the value instead of summing it, and the
 * green says so. What is still genuinely written twice is the tile and gap
 * counts of each column, and those are caught **in one direction only**: a
 * stylesheet that under-measures seats a board at a width it cannot use and
 * [U3-94] reports it, while one that over-measures merely stacks the boards
 * sooner than it needed to, which costs room the table could have used —
 * [U3-95] measures the page at three sizes, not the boards' margin at each. The asymmetry is benign and is
 * stated here rather than left to be discovered.
 *
 * The last row was recorded as failing *nothing*, on the reasoning that a px
 * floor beside a rem size diverges only at a root font-size the lane never
 * uses. That was wrong, and usefully so: the lane owns the document it
 * measures and can set the root font-size itself. Recording a mutation that
 * stays green is how a blind spot stays visible instead of passing for
 * coverage — and this one turned out to be one line of test away from being no
 * blind spot at all. It failed at 15px under the old 44px floor; with the
 * 32px floor of today it fails at 12px, where it measured 202 against 193.
 *
 * The first of those is why the ply assertion measures `.board-play`: against
 * the whole board section it stayed green, both boards being grid items that
 * `align-items: stretch` pins to one height whatever they hold.
 */
describe('a board that holds still', () => {
  // Only where both boards are full size. In the docked arrangements the two
  // are drawn at different sizes on purpose [U3-103], and [U3-86] is the
  // per-board claim the next test makes at every viewport.
  it.each(VIEWPORTS.slice(0, 1))('[U3-86] is the same size to move as waiting, at $name', async (viewport) => {
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

  /**
   * The same requirement at a root font-size the browser did not pick.
   *
   * `rem` resolves against the root element, which this stylesheet never sets —
   * so a control floored in pixels ([U3-59]) beside a tile sized in `rem` is two
   * sizes that agree at 16px and nowhere else. It reads as untestable and is
   * not: the lane owns the document it measures, and can simply say what the
   * root font-size is.
   */
  it('[U3-86] is the same size to move as waiting at a root font-size of 12px', async () => {
    const doc = await load(1280, 800);
    // Small enough that the row's 32px floor is what holds it up [U3-59]: at
    // 12px a tile and its margin come to 30.2px.
    doc.documentElement.style.fontSize = '12px';
    expect(height(playArea(board(doc, 'Player 1')))).toBe(
      height(playArea(board(doc, 'Player 2'))),
    );
  });

  it('[U3-88] lays every pattern line level with the wall row it feeds, at 1280 × 800', async () => {
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

      // Beside the wall, not merely somewhere to its left.
      const right = Math.round(lines[NUM_ROWS - 1].getBoundingClientRect().right);
      const wallLeft = Math.round(wall[0].getBoundingClientRect().left);
      expect(right, `${who}: the lines are not left of the wall`).toBeLessThanOrEqual(wallLeft);
      expect(wallLeft - right, `${who}: the lines are not beside the wall`).toBeLessThan(44);
    }
  });

  it.each(VIEWPORTS)('[U3-92] ends every pattern line on one shared edge, at $name',
    async (viewport) => {
      const doc = await load(viewport.width, viewport.height);
      // Both arrangements: this one holds stacked as well, where the wall is
      // below rather than beside and "the edge nearer the wall" would have no
      // referent — so the assertion is that the five agree, not where they
      // agree. That the shared edge meets the wall's is [U3-88], at the one
      // viewport where there is a wall beside them to meet.
      // The last tile of each line, not the line: a row is as wide as its
      // column, so rows share an edge whatever their tiles do, and it is the
      // tiles that have to fill toward it.
      for (const who of ['Player 1', 'Player 2']) {
        const rights = patternRows(board(doc, who))
          .map((line) => Math.round(line.lastElementChild!.getBoundingClientRect().right));
        expect(rights, who).toHaveLength(NUM_ROWS);
        expect([...new Set(rights)], `${who}: the lines do not share a right edge`).toHaveLength(1);
      }
    });

  /**
   * The arrangement is not monotonic in viewport width, and that is the point
   * [U3-89] rests on. `.boards` seats two boards on one row until the viewport
   * is too narrow for two, and the board then gets the whole width back — so as
   * the viewport narrows the board gets wider once, and the arrangement goes
   * side by side, stacked, side by side.
   *
   * The witness holds the viewport still and changes the root font-size.
   *
   * `--tile` and `--tile-gap` are in `rem`, so a larger root makes the two
   * columns ask for more room while the viewport gives exactly as much as
   * before. Nothing a media query can see has changed, and the arrangement
   * changes anyway. 1280 × 800 is side by side at 16px and stacked at 36px;
   * the numbers are an instance, and any pair that straddles the boundary
   * does — the two columns need `--lines-width + --play-gap + --wall-width`,
   * so the boundary moves with them.
   *
   * A rem-denominated breakpoint does not defeat this, and the reason is not
   * obvious enough to leave unwritten. Media Queries Level 4 §1.3: relative
   * units in a media query resolve against the **initial** font-size — the UA
   * default or the user's preference — and never against a declaration, so
   * that "units are never based on results of declarations". Setting
   * `documentElement.style.fontSize` is a declaration, so
   * `@media (max-width: 56.25rem)` sits exactly where it sat and answers the
   * same at both roots. Verified in this browser: `matchMedia` on that query
   * returns false at a 16px root and false at a 36px one. Do not "simplify"
   * this test back to something a breakpoint can pass.
   *
   * This replaces an earlier witness: the arrangement used to go side by side,
   * stacked, side by side as the viewport narrowed, which a media query also
   * cannot produce. That was a symptom of the defect [U3-94] names — boards
   * seated two-to-a-row at widths where neither could hold its play area — and
   * fixing it made the arrangement monotonic in viewport width.
   */
  it('[U3-89] decides the arrangement from the board’s width, not the viewport’s', async () => {
    const doc = await load(1280, 800);
    const atRoot = (size: string): boolean => {
      doc.documentElement.style.fontSize = size;
      return sideBySide(board(doc, 'Player 1'));
    };
    expect(
      [atRoot('16px'), atRoot('36px')],
      'one viewport, two root font-sizes, and the arrangement did not change',
    ).toEqual([true, false]);

    // The rule half of [U3-89], asserted here rather than borrowed: where the
    // two columns do not fit, they wrap *rather than overflow*. The 36px root
    // above is a width they do not fit, so this is the case to check it in —
    // it was standing on the `scrollWidth` check inside [U3-94]'s sweep, which
    // is filed under another requirement's identifier.
    doc.documentElement.style.fontSize = '36px';
    expect(sideBySide(board(doc, 'Player 1')), 'the columns did not wrap').toBe(false);
    expect(doc.documentElement.scrollWidth, 'the columns overflowed instead of wrapping')
      .toBeLessThanOrEqual(doc.documentElement.clientWidth);

    // This and [U3-58] both read `scrollWidth` on the document, and that only
    // sees an overflow that reaches the document. `body { overflow-x: hidden }`
    // does not hide it — `overflow: hidden` still makes a programmatically
    // scrollable box, which is why the `nowrap` mutation fails this and [U3-58]
    // together. What would hide it is `overflow: hidden` on anything *between*
    // a board's columns and the document — `.board-play`, `.boards`, `.app` —
    // which would clip the overflow before it arrived and turn both green on a
    // layout that overflows. Don't add one without replacing these checks.
  });

  /**
   * Which of the two things that want the same pixels gives way.
   *
   * Between roughly 660 and 1230 the row could seat two boards or it could
   * leave each board wide enough to keep its lines beside its wall, and not
   * both. It was seating two, so both play areas came apart at every width in
   * that band while stacking the boards would have left both whole. Both
   * boards at once is [U3-60] and a SHOULD; level rows are [U3-88] and a MUST
   * — though [U3-88] is pinned to 1280 × 800 and did not reach this band, so
   * nothing was violated here and this is a judgement rather than a deduction.
   *
   * 1232 and 622 are the two boundary widths, and they sit on zero slack: a
   * pixel either way flips the arrangement. That is deliberate and it cannot
   * make this test flaky, because nothing is asserted *about* a particular
   * width. The per-width assertion is the invariant `!(row && !side)`, which
   * holds on both sides of a flip; the three `toContain` checks need each
   * combination to appear *somewhere* in the sweep, and 1400, 1000 and 390
   * supply all three on their own. The boundary probes are there to exercise
   * the transition, not to pin it — if you ever want to pin it, assert the
   * width itself and expect to maintain the number.
   */
  it('[U3-94] stacks the boards rather than letting a play area come apart', async () => {
    const seen: string[] = [];
    for (const width of [1400, 1232, 1231, 1000, 844, 700, 622, 600, 390, 320]) {
      const doc = await load(width, 800);
      // The arrangement is measured after the first paint [U3-95].
      await new Promise((r) => setTimeout(r, 100));
      const one = board(doc, 'Player 1');
      const two = board(doc, 'Player 2');
      const boardsShareARow =
        Math.round(one.getBoundingClientRect().top) === Math.round(two.getBoundingClientRect().top);
      const play = sideBySide(one);

      expect(doc.documentElement.scrollWidth, `${width}px scrolls sideways`)
        .toBeLessThanOrEqual(doc.documentElement.clientWidth);
      // The one arrangement that is never right: two boards on a row, each too
      // narrow to use the room it was given.
      expect(
        boardsShareARow && !play,
        `at ${width}px the boards share a row and the play area is stacked anyway`,
      ).toBe(false);

      seen.push(`${boardsShareARow ? 'row' : 'stacked'}/${play ? 'side' : 'stacked'}`);
      frame?.remove();
      frame = null;
    }

    // Both sides of the trade must actually occur in the sweep, or the
    // assertion above is true of a layout that never seats two boards at all
    // and of one whose play area never comes apart.
    expect(seen, 'the sweep never seated two boards').toContain('row/side');
    expect(seen, 'the sweep never stacked the boards').toContain('stacked/side');
    expect(seen, 'the sweep never reached a width too narrow for either').toContain(
      'stacked/stacked',
    );
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
