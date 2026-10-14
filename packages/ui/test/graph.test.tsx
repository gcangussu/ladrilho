/**
 * The estimate graph: *0006 — Opponent in the interface*, [W6-85] through
 * [W6-94], for intent 0014 — The game's record, for the curious. The list of
 * what must be asserted is [W6-95]'s.
 *
 * The graph is rendered directly from hand-made records. What it can get wrong
 * is which seat's entry it reads, which plies it draws at, and what it draws
 * between them — so the values here never mirror onto themselves (no chance of
 * 50, no lead of 0) except where a test is about exactly that, and the axes are
 * read back off the rendered ticks rather than copied from the component.
 * Mutation records for these tests are in the spec, under [W6-95].
 */

import { render } from '@solidjs/testing-library';
import type { Player } from 'engine';
import { createSignal, flush } from 'solid-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EstimateGraph } from '../src/components/Graph.jsx';
import type { Estimate, PlyRecord } from '../src/game.js';
import { DEFAULT_SIMULATIONS, type Level, type Seating, type Tier } from '../src/opponent.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function seating(a: Level | null, b: Level | null): Seating {
  return { players: [a, b], simulations: DEFAULT_SIMULATIONS };
}

function chance(by: Player, mine: number, level: 'master' | 'expert' = 'master'): Estimate {
  const c: [number, number] = [0, 0];
  c[by] = mine;
  c[1 - by] = 100 - mine;
  return { kind: 'chance', by, level, chance: c };
}

function lead(by: Player, mine: number, level: Tier = 'sharp', decided: Player | null = null): Estimate {
  const l: [number, number] = [0, 0];
  l[by] = mine;
  l[1 - by] = mine === 0 ? 0 : -mine;
  return { kind: 'lead', by, level, lead: l, decided };
}

/** A ply of the record; a person's when `estimate` is null. */
function ply(n: number, seat: Player, estimate: Estimate | null, level: Level | null = null): PlyRecord {
  return {
    ply: n,
    round: Math.floor((n - 1) / 20),
    seat,
    action: 0,
    level: estimate === null ? level : estimate.level,
    choice: null,
    estimate,
    scoring: null,
  };
}

/**
 * A person on seat 0 against `master` on seat 1, twelve plies: the computer
 * moves on the even plies with these chances of its own.
 */
const MASTER_CHANCES = [55, 61, 47, 70, 66, 62];
function masterGame(): PlyRecord[] {
  const out: PlyRecord[] = [];
  for (let n = 1; n <= 12; n++) {
    out.push(n % 2 === 1 ? ply(n, 0, null) : ply(n, 1, chance(1, MASTER_CHANCES[n / 2 - 1])));
  }
  return out;
}

/** `ruthless` on seat 0 against a person, nine plies, ending in a foreseen loss for seat 1. */
const SHARP_LEADS = [3, -2, 12, 7];
function sharpGame(): PlyRecord[] {
  return [
    ply(1, 0, lead(0, SHARP_LEADS[0])),
    ply(2, 1, null),
    ply(3, 0, lead(0, SHARP_LEADS[1])),
    ply(4, 1, null),
    ply(5, 1, null),
    ply(6, 0, lead(0, SHARP_LEADS[2])),
    ply(7, 1, null),
    ply(8, 0, lead(0, SHARP_LEADS[3], 'sharp', 0)),
    ply(9, 1, null),
  ];
}

/** `ruthless` on seat 0 against `master` on seat 1, alternating, ten plies. */
function mixedGame(): PlyRecord[] {
  const out: PlyRecord[] = [];
  for (let n = 1; n <= 10; n++) {
    out.push(n % 2 === 1 ? ply(n, 0, lead(0, n - 4)) : ply(n, 1, chance(1, 50 + n)));
  }
  return out;
}

function figures(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('figure.estimate-graph')];
}

function num(el: Element, name: string): number {
  return Number(el.getAttribute(name));
}

/** The plot's axes, read off the rendered ticks — not copied from the component. */
function axes(fig: HTMLElement): { x(ply: number): number; y(value: number): number } {
  const xLabels = [...fig.querySelectorAll('text.graph-tick[text-anchor="middle"]')];
  const yLabels = [...fig.querySelectorAll('text.graph-tick[text-anchor="end"]')];
  const grid = [...fig.querySelectorAll('line.graph-grid')];
  const first = xLabels[0];
  const last = xLabels[xLabels.length - 1];
  const p0 = Number(first.textContent);
  const p1 = Number(last.textContent);
  const x0 = num(first, 'x');
  const x1 = num(last, 'x');
  const value = (t: Element): number => Number((t.textContent ?? '').replace('−', '-'));
  const v0 = value(yLabels[0]);
  const v1 = value(yLabels[2]);
  const y0 = num(grid[0], 'y1');
  const y1 = num(grid[2], 'y1');
  return {
    x: (p) => x0 + ((p - p0) / (p1 - p0)) * (x1 - x0),
    y: (v) => y0 + ((v - v0) / (v1 - v0)) * (y1 - y0),
  };
}

function seriesOf(fig: HTMLElement, seat: Player): Element {
  const g = fig.querySelector(`g.graph-series[data-seat="${seat}"]`);
  if (g === null) throw new Error(`no series for seat ${seat}`);
  return g;
}

/** A series' path's vertices, as written. */
function vertices(fig: HTMLElement, seat: Player): [number, number][] {
  const d = seriesOf(fig, seat).querySelector('path')?.getAttribute('d') ?? '';
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

function markers(fig: HTMLElement, seat: Player): Element[] {
  return [...seriesOf(fig, seat).querySelectorAll('.graph-marker')];
}

function markerCentre(m: Element): [number, number] {
  return m.tagName === 'circle'
    ? [num(m, 'cx'), num(m, 'cy')]
    : [num(m, 'x') + num(m, 'width') / 2, num(m, 'y') + num(m, 'height') / 2];
}

/** Each seat's expected points: its own entry, at each estimate ply of `kind`. */
function expected(history: PlyRecord[], kind: Estimate['kind'], seat: Player): [number, number][] {
  return history
    .filter((r) => r.estimate?.kind === kind)
    .map((r) => {
      const e = r.estimate as Estimate;
      return [r.ply, e.kind === 'chance' ? e.chance[seat] : e.lead[seat]];
    });
}

function expectPoints(fig: HTMLElement, seat: Player, want: [number, number][]): void {
  const { x, y } = axes(fig);
  const got = vertices(fig, seat);
  expect(got.length, `seat ${seat}'s vertex count`).toBe(want.length);
  want.forEach(([p, v], i) => {
    expect(got[i][0]).toBeCloseTo(x(p), 0);
    expect(got[i][1]).toBeCloseTo(y(v), 0);
  });
  const ms = markers(fig, seat).map(markerCentre);
  expect(ms.length, `seat ${seat}'s marker count`).toBe(want.length);
  want.forEach(([p, v], i) => {
    expect(ms[i][0]).toBeCloseTo(x(p), 0);
    expect(ms[i][1]).toBeCloseTo(y(v), 0);
  });
}

function tickLabels(fig: HTMLElement, anchor: 'middle' | 'end'): string[] {
  return [...fig.querySelectorAll(`text.graph-tick[text-anchor="${anchor}"]`)].map((t) => t.textContent ?? '');
}

describe('the estimate graph', () => {
  it('[W6-86] [W6-88] plots each seat its own chance, only where the computer moved', () => {
    const history = masterGame();
    const { container } = render(() => <EstimateGraph history={history} seating={seating(null, 'master')} />);
    const [fig] = figures(container);
    expect(fig.dataset.kind).toBe('chance');
    expectPoints(fig, 0, expected(history, 'chance', 0));
    expectPoints(fig, 1, expected(history, 'chance', 1));
    // No vertex at a person's ply: every vertex sits on an even ply.
    const { x } = axes(fig);
    const personX = history.filter((r) => r.estimate === null).map((r) => x(r.ply));
    for (const seat of [0, 1] as const) {
      for (const [vx] of vertices(fig, seat)) {
        for (const px of personX) expect(Math.abs(vx - px)).toBeGreaterThan(1);
      }
    }
  });

  it('[W6-86] [W6-87] [W6-88] plots a lead on its own symmetric axis, a decided lead at its margin', () => {
    const history = sharpGame();
    const { container } = render(() => <EstimateGraph history={history} seating={seating('sharp', null)} />);
    const all = figures(container);
    expect(all).toHaveLength(1);
    const [fig] = all;
    expect(fig.dataset.kind).toBe('lead');
    // The widest lead is 12, so the axis is ±15, and includes 0.
    expect(tickLabels(fig, 'end')).toEqual(['−15', '0', '+15']);
    expectPoints(fig, 0, expected(history, 'lead', 0));
    expectPoints(fig, 1, expected(history, 'lead', 1));
  });

  it('[W6-87] keeps the lead axis at least ±5, and the chance axis fixed', () => {
    const small = [ply(1, 0, lead(0, 2)), ply(2, 1, null), ply(3, 0, lead(0, -1))];
    const { container } = render(() => <EstimateGraph history={small} seating={seating('easy', null)} />);
    expect(tickLabels(figures(container)[0], 'end')).toEqual(['−5', '0', '+5']);
    const exact = [ply(1, 0, lead(0, 10)), ply(2, 1, null)];
    const second = render(() => <EstimateGraph history={exact} seating={seating('easy', null)} />);
    expect(tickLabels(figures(second.container)[0], 'end')).toEqual(['−10', '0', '+10']);
    const third = render(() => <EstimateGraph history={masterGame()} seating={seating(null, 'master')} />);
    expect(tickLabels(figures(third.container)[0], 'end')).toEqual(['0', '50', '100']);
  });

  it('[W6-87] [W6-88] [W6-90] gives two graphs for two kinds, chance first, each with only its own plies', () => {
    const history = mixedGame();
    const { container } = render(() => <EstimateGraph history={history} seating={seating('sharp', 'master')} />);
    const [first, second] = figures(container);
    expect(figures(container)).toHaveLength(2);
    expect(first.dataset.kind).toBe('chance');
    expect(second.dataset.kind).toBe('lead');
    for (const seat of [0, 1] as const) {
      expectPoints(first, seat, expected(history, 'chance', seat));
      expectPoints(second, seat, expected(history, 'lead', seat));
    }
    expect(first.querySelector('.graph-title')?.textContent).toBe('chance to win, %');
    expect(second.querySelector('.graph-title')?.textContent).toBe('lead, points');
    expect(first.querySelector('figcaption')?.textContent).toBe(
      'Each point is an estimate by Player 2’s master, made on its own move.',
    );
    expect(second.querySelector('figcaption')?.textContent).toBe(
      'Each point is an estimate by Player 1’s ruthless, made on its own move.',
    );
    for (const fig of [first, second]) {
      // Read above the drawing it qualifies, not under the x axis's title.
      expect(fig.firstElementChild?.tagName).toBe('FIGCAPTION');
      expect(fig.querySelector('.graph-axis-title')?.textContent).toBe('move');
    }
  });

  it('[W6-90] names one computer by its level, and two of one kind by seat', () => {
    const one = render(() => <EstimateGraph history={masterGame()} seating={seating(null, 'master')} />);
    expect(figures(one.container)[0].querySelector('figcaption')?.textContent).toBe(
      'Each point is an estimate by master, made on its own move.',
    );
    const both = [ply(1, 0, chance(0, 58)), ply(2, 1, chance(1, 45)), ply(3, 0, chance(0, 61))];
    const two = render(() => <EstimateGraph history={both} seating={seating('master', 'master')} />);
    expect(figures(two.container)[0].querySelector('figcaption')?.textContent).toBe(
      'Each point is an estimate by Player 1’s master or Player 2’s master, made on its own move.',
    );
    // The accessible name keeps the short form, its names joined by "and" [W6-92].
    expect(figures(two.container)[0].querySelector('svg')?.getAttribute('aria-label')).toMatch(
      /, as Player 1’s master and Player 2’s master saw it$/,
    );
  });

  it('[W6-87] ticks the moves at 1, every ten, and the last, without a label beside the last', () => {
    const run = (n: number): { at: string[]; marks: number } => {
      const history = [ply(1, 0, chance(0, 60))];
      for (let p = 2; p <= n; p++) history.push(ply(p, (p - 1) % 2 === 0 ? 0 : 1, null));
      const { container } = render(() => <EstimateGraph history={history} seating={seating('master', null)} />);
      const fig = figures(container)[0];
      return { at: tickLabels(fig, 'middle'), marks: fig.querySelectorAll('line.graph-axis-tick').length };
    };
    expect(run(1)).toEqual({ at: ['1'], marks: 1 });
    expect(run(9)).toEqual({ at: ['1', '9'], marks: 2 });
    expect(run(12)).toEqual({ at: ['1', '12'], marks: 3 });
    expect(run(14)).toEqual({ at: ['1', '10', '14'], marks: 3 });
    expect(run(23)).toEqual({ at: ['1', '10', '23'], marks: 4 });
    expect(run(30)).toEqual({ at: ['1', '10', '20', '30'], marks: 4 });
    expect(run(82)).toEqual({ at: ['1', '10', '20', '30', '40', '50', '60', '70', '82'], marks: 10 });
    expect(run(84)).toEqual({ at: ['1', '10', '20', '30', '40', '50', '60', '70', '80', '84'], marks: 10 });
  });

  it('[W6-87] [W6-88] spans the whole game so far, and draws a lone point as a marker without a line', () => {
    const history = [ply(1, 0, null), ply(2, 1, chance(1, 64)), ply(3, 0, null), ply(4, 1, null), ply(5, 0, null)];
    const { container } = render(() => <EstimateGraph history={history} seating={seating(null, 'master')} />);
    const fig = figures(container)[0];
    expect(tickLabels(fig, 'middle')).toEqual(['1', '5']);
    for (const seat of [0, 1] as const) {
      expect(seriesOf(fig, seat).querySelector('path')).toBeNull();
      expect(markers(fig, seat)).toHaveLength(1);
    }
    const { x, y } = axes(fig);
    const [cx, cy] = markerCentre(markers(fig, 0)[0]);
    expect(cx).toBeCloseTo(x(2), 0);
    expect(cy).toBeCloseTo(y(36), 0);
    // A single-ply history still has an x axis to draw on.
    const single = render(() => <EstimateGraph history={[ply(1, 0, chance(0, 70))]} seating={seating('master', null)} />);
    const [sx] = markerCentre(markers(figures(single.container)[0], 0)[0]);
    expect(Number.isFinite(sx)).toBe(true);
  });

  it('[W6-89] tells the series apart by line, marker and label, not by colour alone', () => {
    const { container } = render(() => <EstimateGraph history={masterGame()} seating={seating(null, 'master')} />);
    const fig = figures(container)[0];
    expect(seriesOf(fig, 0).querySelector('path')?.hasAttribute('stroke-dasharray')).toBe(false);
    expect(seriesOf(fig, 1).querySelector('path')?.getAttribute('stroke-dasharray')).toMatch(/^\d+ \d+$/);
    expect(markers(fig, 0).every((m) => m.tagName === 'circle')).toBe(true);
    expect(markers(fig, 1).every((m) => m.tagName === 'rect')).toBe(true);
    // Each end label at its own series' last point, Player 2 the higher at 62%.
    const label = (seat: Player): Element => seriesOf(fig, seat).querySelector('.graph-end-label') as Element;
    expect(label(0).textContent).toBe('Player 1');
    expect(label(1).textContent).toBe('Player 2');
    for (const seat of [0, 1] as const) {
      const [lx, ly] = markerCentre(markers(fig, seat).at(-1) as Element);
      expect(num(label(seat), 'x')).toBeGreaterThan(lx);
      expect(Math.abs(num(label(seat), 'y') - 4 - ly)).toBeLessThan(1);
    }
    expect(num(label(1), 'y')).toBeLessThan(num(label(0), 'y'));
  });

  it('[W6-89] moves the end labels apart where the series meet', () => {
    const label = (fig: HTMLElement, seat: Player): number =>
      num(seriesOf(fig, seat).querySelector('.graph-end-label') as Element, 'y');
    const even = render(() => (
      <EstimateGraph history={[ply(1, 0, chance(0, 70)), ply(2, 1, chance(1, 50))]} seating={seating('master', 'master')} />
    ));
    const fig = figures(even.container)[0];
    expect(label(fig, 1) - label(fig, 0)).toBeGreaterThanOrEqual(14);
    const near = render(() => (
      <EstimateGraph history={[ply(1, 0, chance(0, 52))]} seating={seating('master', null)} />
    ));
    const nearFig = figures(near.container)[0];
    // Seat 0 is higher at 52%, so its label goes above.
    expect(label(nearFig, 1) - label(nearFig, 0)).toBeGreaterThanOrEqual(14);
    const flat = render(() => <EstimateGraph history={[ply(1, 0, chance(0, 49))]} seating={seating('master', null)} />);
    const flatFig = figures(flat.container)[0];
    expect(label(flatFig, 0) - label(flatFig, 1)).toBeGreaterThanOrEqual(14);
  });

  it('[W6-89] [W6-94] draws in neutral ink at a fixed size: no accent, no tile colour', () => {
    const source = readFileSync(join(HERE, '..', 'src', 'components', 'Graph.tsx'), 'utf8');
    const styles = readFileSync(join(HERE, '..', 'src', 'styles.css'), 'utf8');
    const start = styles.indexOf('The estimate graph [W6-85]');
    expect(start).toBeGreaterThan(0);
    const block = styles.slice(styles.lastIndexOf('/*', start));
    const forbidden = /--accent|--tile-|--ghost|--loss|#[0-9a-f]{3,6}\b|rgb\(|hsl\(/i;
    expect(source).not.toMatch(forbidden);
    expect(block).not.toMatch(forbidden);
    expect(block).toMatch(/\.estimate-graph-svg\s*\{[^}]*width:\s*40rem;[^}]*height:\s*16rem;[^}]*max-width:\s*none;/);
    const { container } = render(() => <EstimateGraph history={masterGame()} seating={seating(null, 'master')} />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 256');
    expect(Number(svg.getAttribute('font-size'))).toBeGreaterThanOrEqual(12);
    expect(container.querySelector('button, a, input, [tabindex]')).toBeNull();
  });

  it('[W6-91] says there is nothing to draw, in a game of two people and before the first estimate', () => {
    const people = [ply(1, 0, null), ply(2, 1, null), ply(3, 0, null)];
    const hot = render(() => <EstimateGraph history={people} seating={seating(null, null)} />);
    expect(hot.container.querySelector('svg')).toBeNull();
    expect(hot.container.textContent).toBe('No estimates in a game of two people.');
    const empty = render(() => <EstimateGraph history={[]} seating={seating(null, null)} />);
    expect(empty.container.textContent).toBe('No estimates in a game of two people.');
    const waiting = render(() => <EstimateGraph history={[ply(1, 0, null)]} seating={seating(null, 'master')} />);
    expect(waiting.container.querySelector('svg')).toBeNull();
    expect(waiting.container.textContent).toBe('No estimates yet.');
    const dealt = render(() => <EstimateGraph history={[]} seating={seating('easy', 'master')} />);
    expect(dealt.container.textContent).toBe('No estimates yet.');
  });

  it('[W6-92] names each graph by its kind, span and latest point, with its data in a hidden table', () => {
    const chanceView = render(() => <EstimateGraph history={masterGame()} seating={seating(null, 'master')} />);
    const svg = chanceView.container.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe(
      'Chance to win over 12 moves; latest: Player 1 38%, Player 2 62%, as master saw it',
    );
    const table = figures(chanceView.container)[0].querySelector('table') as HTMLTableElement;
    // Hidden by a wrapper: sr-only on a table leaves its caption drawn.
    expect(table.classList.contains('sr-only')).toBe(false);
    expect(table.parentElement?.classList.contains('sr-only')).toBe(true);
    expect(table.caption?.textContent).toBe('Chance to win, by move');
    const rows = [...table.rows].map((r) => [...r.cells].map((c) => c.textContent));
    expect(rows[0]).toEqual(['move', 'Player 1', 'Player 2']);
    expect(rows.slice(1)).toEqual(
      MASTER_CHANCES.map((c, i) => [String(2 * (i + 1)), `${100 - c}% to win`, `${c}% to win`]),
    );

    const leadView = render(() => <EstimateGraph history={sharpGame()} seating={seating('sharp', null)} />);
    expect(leadView.container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Lead in points over 9 moves; latest: Player 1 win, Player 2 loss, as ruthless saw it',
    );
    const leadTable = leadView.container.querySelector('table') as HTMLTableElement;
    expect(leadTable.caption?.textContent).toBe('Lead in points, by move');
    const leadRows = [...leadTable.rows].map((r) =>
      [...r.cells].map((c) => c.textContent),
    );
    expect(leadRows.slice(1)).toEqual([
      ['1', 'Ahead by 3 points', 'Behind by 3 points'],
      ['3', 'Behind by 2 points', 'Ahead by 2 points'],
      ['6', 'Ahead by 12 points', 'Behind by 12 points'],
      ['8', 'A win by 7 points', 'A loss by 7 points'],
    ]);

    const one = render(() => <EstimateGraph history={[ply(1, 0, lead(0, 1, 'steady'))]} seating={seating('steady', null)} />);
    expect(one.container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Lead in points over 1 move; latest: Player 1 +1 pt, Player 2 −1 pt, as steady saw it',
    );
  });

  it('[W6-93] renders the same history to the same markup, with no id', () => {
    const a = render(() => <EstimateGraph history={mixedGame()} seating={seating('sharp', 'master')} />);
    const b = render(() => <EstimateGraph history={mixedGame()} seating={seating('sharp', 'master')} />);
    expect(a.container.innerHTML).toBe(b.container.innerHTML);
    expect(a.container.innerHTML.length).toBeGreaterThan(1000);
    expect(a.container.querySelector('[id]')).toBeNull();
    expect(a.container.querySelector('marker, pattern, defs')).toBeNull();
    for (const el of a.container.querySelectorAll('svg *')) {
      for (const attr of ['x', 'y', 'cx', 'cy', 'x1', 'x2', 'y1', 'y2']) {
        const v = el.getAttribute(attr);
        if (v !== null) expect(v).toMatch(/^-?\d+(\.\d)?$/);
      }
      const d = el.getAttribute('d');
      if (d !== null) for (const v of d.match(/-?[\d.]+/g) ?? []) expect(v).toMatch(/^-?\d+(\.\d)?$/);
    }
  });

  it('[W6-85] follows the record as it grows', () => {
    const [history, setHistory] = createSignal<readonly PlyRecord[]>([ply(1, 0, null)]);
    const { container } = render(() => <EstimateGraph history={history()} seating={seating(null, 'master')} />);
    expect(container.textContent).toBe('No estimates yet.');
    setHistory([ply(1, 0, null), ply(2, 1, chance(1, 64))]);
    flush();
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Chance to win over 2 moves; latest: Player 1 36%, Player 2 64%, as master saw it',
    );
    setHistory([ply(1, 0, null), ply(2, 1, chance(1, 64)), ply(3, 0, null), ply(4, 1, chance(1, 71))]);
    flush();
    expect(vertices(figures(container)[0], 1)).toHaveLength(2);
  });
});
