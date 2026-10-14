import type { JSX } from '@solidjs/web';
import type { Player } from 'engine';
import { For, Show, createMemo } from 'solid-js';
import type { Estimate, PlyRecord } from '../game.js';
import type { Level, Seating } from '../opponent.js';
import { estimateWords, estimatorName, signed } from './Estimate.jsx';

/**
 * The record's graph of the estimate, [W6-85] through [W6-94], for intent
 * 0014 — The game's record, for the curious.
 *
 * It draws what the record already holds — one estimate per computer ply,
 * each seat's own entry [W6-55] — and computes nothing about the game. The
 * drawing is a pure function of the props: `layout` builds plain data, the
 * JSX writes it out, and nothing in either has an id, a random number or a
 * date, so the same history is the same markup [W6-93].
 */

type Kind = Estimate['kind'];
type Players = readonly [Level | null, Level | null];

/** The drawing's own units: 40rem × 16rem, one unit a sixteenth of a rem [W6-94]. */
const WIDTH = 640;
const HEIGHT = 256;
/** The plot's box inside it: room left for the y labels, right for the end labels. */
const LEFT = 44;
const RIGHT = 552;
const TOP = 36;
const BOTTOM = 212;
/** An end label's height, in units: closer than this, two labels overlap [W6-89]. */
const LABEL_HEIGHT = 14;

const SEATS = [0, 1] as const;

interface Point {
  x: number;
  y: number;
}

interface Tick {
  at: number;
  label: string | null;
}

interface Series {
  seat: Player;
  /** `null` for a series of one point: a marker and no line [W6-88]. */
  path: string | null;
  points: Point[];
  label: Point;
}

interface Row {
  ply: number;
  values: [string, string];
}

interface Graph {
  kind: Kind;
  title: string;
  name: string;
  /** The hidden table's caption, which tells it from the record's log [W6-92]. */
  tableCaption: string;
  /** The figure's caption, above the drawing: whose estimates these are [W6-90]. */
  caption: string;
  yTicks: Tick[];
  reference: number;
  xTicks: Tick[];
  series: Series[];
  rows: Row[];
}

/** One decimal place at most, and never `-0` [W6-93]. */
function n(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded === 0 ? 0 : rounded);
}

function entry(estimate: Estimate, seat: Player): number {
  return estimate.kind === 'chance' ? estimate.chance[seat] : estimate.lead[seat];
}

/** [W6-87]: 1, every multiple of 10 up to `last`, and `last`. */
function xTicks(last: number): number[] {
  const at = [1];
  for (let m = 10; m <= last; m += 10) at.push(m);
  if (at[at.length - 1] !== last) at.push(last);
  return at;
}

/** Whose estimates these are, in [W6-58]'s names and seat order [W6-90]. */
function estimators(plotted: readonly PlyRecord[], players: Players): string[] {
  const names: string[] = [];
  for (const seat of SEATS) {
    const levels: Level[] = [];
    for (const record of plotted) {
      const e = record.estimate as Estimate;
      if (e.by === seat && !levels.includes(e.level)) levels.push(e.level);
    }
    for (const level of levels) {
      names.push(estimatorName(seat, level, players));
    }
  }
  return names;
}

function graphOf(kind: Kind, history: readonly PlyRecord[], players: Players): Graph | null {
  const plotted = history.filter((r) => r.estimate !== null && r.estimate.kind === kind);
  if (plotted.length === 0) return null;
  const count = history.length;
  const xMax = Math.max(2, count);
  const xOf = (ply: number): number => LEFT + ((ply - 1) / (xMax - 1)) * (RIGHT - LEFT);

  let low: number;
  let high: number;
  let yLabels: [string, string, string];
  if (kind === 'chance') {
    low = 0;
    high = 100;
    yLabels = ['0', '50', '100'];
  } else {
    let widest = 0;
    for (const r of plotted) {
      for (const seat of SEATS) widest = Math.max(widest, Math.abs(entry(r.estimate as Estimate, seat)));
    }
    high = Math.max(5, Math.ceil(widest / 5) * 5);
    low = -high;
    yLabels = [signed(low), '0', signed(high)];
  }
  const yOf = (v: number): number => BOTTOM - ((v - low) / (high - low)) * (BOTTOM - TOP);
  const middle = (low + high) / 2;

  const series: Series[] = SEATS.map((seat) => {
    const points = plotted.map((r) => ({ x: xOf(r.ply), y: yOf(entry(r.estimate as Estimate, seat)) }));
    const path =
      points.length < 2 ? null : points.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(p.x)},${n(p.y)}`).join(' ');
    const last = points[points.length - 1];
    return { seat, path, points, label: { x: last.x + 8, y: last.y } };
  });

  // [W6-89]: two end labels never overlap. The higher series' label goes
  // above; level series put Player 1's above.
  const [a, b] = [series[0].label, series[1].label];
  if (Math.abs(a.y - b.y) < LABEL_HEIGHT) {
    const centre = (a.y + b.y) / 2;
    const firstAbove = a.y <= b.y;
    a.y = centre + (firstAbove ? -1 : 1) * (LABEL_HEIGHT / 2);
    b.y = centre + (firstAbove ? 1 : -1) * (LABEL_HEIGHT / 2);
  }

  const lastPlotted = plotted[plotted.length - 1].estimate as Estimate;
  const shorts = SEATS.map((seat) => estimateWords(lastPlotted, seat, players).short);
  const names = estimators(plotted, players);
  const says = `as ${names.join(' and ')} saw it`;
  const title = kind === 'chance' ? 'Chance to win' : 'Lead in points';
  const moves = count === 1 ? '1 move' : `${count} moves`;

  return {
    kind,
    title: kind === 'chance' ? 'chance to win, %' : 'lead, points',
    name: `${title} over ${moves}; latest: Player 1 ${shorts[0]}, Player 2 ${shorts[1]}, ${says}`,
    tableCaption: `${title}, by move`,
    caption: `Each point is an estimate by ${names.join(' or ')}, made on its own move.`,
    yTicks: [low, middle, high].map((v, i) => ({ at: yOf(v), label: yLabels[i] })),
    reference: yOf(middle),
    xTicks: xTicks(count).map((ply) => ({
      at: xOf(ply),
      // A multiple of 10 just short of the last ply would collide with its label.
      label: ply !== count && ply !== 1 && count - ply <= 3 ? null : String(ply),
    })),
    series,
    rows: plotted.map((r) => {
      const e = r.estimate as Estimate;
      return {
        ply: r.ply,
        values: [estimateWords(e, 0, players).value, estimateWords(e, 1, players).value],
      };
    }),
  };
}

/** Every graph the history gives, the chance graph first [W6-87]. */
function layout(history: readonly PlyRecord[], players: Players): Graph[] {
  const out: Graph[] = [];
  for (const kind of ['chance', 'lead'] as const) {
    const graph = graphOf(kind, history, players);
    if (graph !== null) out.push(graph);
  }
  return out;
}

/** A seat's marker at a point: a filled circle for seat 0, a hollow square for seat 1 [W6-89]. */
function Marker(props: { seat: Player; at: Point }): JSX.Element {
  return (
    <Show
      when={props.seat === 0}
      fallback={
        <rect
          class="graph-marker graph-marker-1"
          x={n(props.at.x - 3.5)}
          y={n(props.at.y - 3.5)}
          width="7"
          height="7"
        />
      }
    >
      <circle class="graph-marker graph-marker-0" cx={n(props.at.x)} cy={n(props.at.y)} r="3.5" />
    </Show>
  );
}

function GraphFigure(props: { graph: Graph }): JSX.Element {
  const g = (): Graph => props.graph;
  return (
    <figure class="estimate-graph" data-kind={g().kind}>
      <figcaption class="estimate-graph-caption">{g().caption}</figcaption>
      <svg
        class="estimate-graph-svg"
        role="img"
        aria-label={g().name}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        font-size="13"
      >
        <text class="graph-title" x={LEFT} y="18">
          {g().title}
        </text>
        <For each={g().yTicks}>
          {(tick) => (
            <>
              <line class="graph-grid" x1={LEFT} x2={RIGHT} y1={n(tick.at)} y2={n(tick.at)} />
              <text class="graph-tick" x={LEFT - 6} y={n(tick.at + 4)} text-anchor="end">
                {tick.label}
              </text>
            </>
          )}
        </For>
        <line class="graph-reference" x1={LEFT} x2={RIGHT} y1={n(g().reference)} y2={n(g().reference)} />
        <For each={g().xTicks}>
          {(tick) => (
            <>
              <line class="graph-axis-tick" x1={n(tick.at)} x2={n(tick.at)} y1={BOTTOM} y2={BOTTOM + 4} />
              <Show when={tick.label}>
                {(label) => (
                  <text class="graph-tick" x={n(tick.at)} y={BOTTOM + 18} text-anchor="middle">
                    {label()}
                  </text>
                )}
              </Show>
            </>
          )}
        </For>
        <text class="graph-axis-title" x={(LEFT + RIGHT) / 2} y={HEIGHT - 6} text-anchor="middle">
          move
        </text>
        <For each={g().series}>
          {(s) => (
            <g class={`graph-series graph-series-${s.seat}`} data-seat={s.seat}>
              <Show when={s.path}>
                {(d) => (
                  <path
                    class="graph-line"
                    d={d()}
                    stroke-dasharray={s.seat === 1 ? '7 4' : undefined}
                  />
                )}
              </Show>
              <For each={s.points}>{(p) => <Marker seat={s.seat} at={p} />}</For>
              <text class="graph-end-label" x={n(s.label.x)} y={n(s.label.y + 4)}>
                Player {s.seat + 1}
              </text>
            </g>
          )}
        </For>
      </svg>
      {/* Hidden by a wrapper, not on the table itself: a table's clip and
          overflow stop at its grid, and its caption is drawn outside it. */}
      <div class="sr-only">
        <table>
          <caption>{g().tableCaption}</caption>
          <thead>
            <tr>
              <th scope="col">move</th>
              <th scope="col">Player 1</th>
              <th scope="col">Player 2</th>
            </tr>
          </thead>
          <tbody>
            <For each={g().rows}>
              {(row) => (
                <tr>
                  <th scope="row">{row.ply}</th>
                  <td>{row.values[0]}</td>
                  <td>{row.values[1]}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/**
 * The estimate over the game so far [W6-85]: one graph per kind the history
 * holds, or a sentence when it holds none [W6-91].
 */
export function EstimateGraph(props: { history: readonly PlyRecord[]; seating: Seating }): JSX.Element {
  const graphs = createMemo(() => layout(props.history, props.seating.players));
  return (
    <Show
      when={graphs().length > 0}
      fallback={
        <p class="estimate-graph-empty">
          {props.seating.players[0] === null && props.seating.players[1] === null
            ? 'No estimates in a game of two people.'
            : 'No estimates yet.'}
        </p>
      }
    >
      <div class="estimate-graphs">
        <For each={graphs()}>{(graph) => <GraphFigure graph={graph} />}</For>
      </div>
    </Show>
  );
}
