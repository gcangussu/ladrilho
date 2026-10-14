/**
 * The centre at its largest [U3-106], posed as a view [U3-110].
 *
 * The largest centre a round can make is `NUM_FACTORIES * (FACTORY_SIZE - 1)`
 * tiles and the marker. It is reachable, but random play does not reach it, so
 * the displays are rendered alone — on the wide table's stylesheet, in a table
 * column the width `wide` gives it — and handed every split of exactly that
 * many tiles among the five colours. A view is posed, never a state
 * ([0001 E1-5]), as [U3-44] and [U3-45] are posed in the fast suite.
 *
 * Smaller pools are not posed: a group losing a tile, or a colour going, only
 * narrows a control, and a wrapped pool never needs more rows for that — the
 * argument [U3-106] records, and the reason this checks the largest only.
 *
 * Seen red, on a copy, with `--pool-h` at three rows of controls rather than
 * four, at both widths: "4,11,0,0,0: the centre covers 2 display(s)" first.
 * And seen red for real before that: the factories' 2 × 2 rule for a group of
 * four reached the centre too, a group of fifteen was drawn two tiles wide, and
 * "15,0,0,0,0: the centre covers 2 display(s)" — which no deal this suite
 * plays would have shown.
 */

import { render } from '@solidjs/web';
import { FACTORY_SIZE, NUM_COLORS, NUM_FACTORIES, newGame, toJSON } from 'engine';
import type { AzulJSON } from 'engine';
import { createComponent, createSignal, flush } from 'solid-js';
import { afterEach, describe, expect, it } from 'vitest';
import { Displays } from '../../src/components/Displays.jsx';
import '../../src/styles.css';

const LARGEST = NUM_FACTORIES * (FACTORY_SIZE - 1);

/** Every way of putting `total` tiles into `parts` colours. */
function splits(total: number, parts: number): number[][] {
  if (parts === 1) return [[total]];
  const out: number[][] = [];
  for (let first = total; first >= 0; first--) {
    for (const rest of splits(total - first, parts - 1)) out.push([first, ...rest]);
  }
  return out;
}

let dispose: (() => void) | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = null;
  host = null;
});

/**
 * The wide table's column, `width` pixels across: the arrangement and the
 * ring as `App` marks them, the table as the grid area it is.
 */
function pose(width: number, game: () => AzulJSON): HTMLElement {
  host = document.createElement('main');
  host.className = 'app';
  host.dataset['layout'] = 'wide';
  host.dataset['table'] = 'ring';
  const table = document.createElement('div');
  table.className = 'table';
  table.style.width = `${width}px`;
  host.append(table);
  document.body.append(host);
  dispose = render(
    () =>
      createComponent(Displays, {
        get game() {
          return game();
        },
        get names() {
          return game().colorNames;
        },
        selection: null,
        available: () => true,
        onChoose: () => {},
        loose: true,
      }),
    table,
  );
  flush();
  return table;
}

type Box = DOMRect;
const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

describe('the largest centre [U3-106]', () => {
  // The narrowest table `wide` gives — the main element at its 77 root ems,
  // less two boards, the gaps and the padding — and the one at 1280 × 800.
  it.each([405, 453])(
    '[U3-106] [U3-110] holds every split of the largest centre, and the marker, clear of every display, %dpx across',
    (width) => {
      const opening = toJSON(newGame(7));
      const [game, setGame] = createSignal<AzulJSON>(opening);
      const table = pose(width, game);
      const plates = [...table.querySelectorAll('[data-group="factories"] [role="group"]')];
      expect(plates).toHaveLength(NUM_FACTORIES);
      const placed = plates.map((plate) => plate.getBoundingClientRect());

      const all = splits(LARGEST, NUM_COLORS);
      // C(19, 4): every split, not a sample.
      expect(all).toHaveLength(3876);
      const started = performance.now();
      const failures: string[] = [];
      for (const center of all) {
        setGame({ ...opening, center, markerInCenter: true });
        flush();
        const pool = table.querySelector('.centre .display')!.getBoundingClientRect();
        const hit = placed.filter((plate) => overlaps(pool, plate));
        const tiles = table.querySelectorAll('[data-group="centre"] .tile').length;
        if (tiles !== LARGEST + 1) failures.push(`${center}: ${tiles} tiles drawn`);
        if (hit.length > 0) failures.push(`${center}: the centre covers ${hit.length} display(s)`);
        if (failures.length > 5) break;
      }
      // The plates never moved for it [U3-81].
      expect(plates.map((plate) => plate.getBoundingClientRect())).toEqual(placed);
      expect(failures).toEqual([]);
      console.info(`[U3-106] ${all.length} centres at ${width}px in ${Math.round(performance.now() - started)} ms`);
    },
    60_000,
  );
});
