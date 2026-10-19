/**
 * A match's results ([G13-39] to [G13-42]): one line of `<out>.jsonl` per game
 * as it finishes, after a header line, and the summary computed from those
 * lines alone, whether the match finished or stopped.
 */

import type { GameRecord, Move } from './game.js';

export interface HeaderLine {
  kind: 'header';
  /** Everything [G13-40]'s header holds but `stopped`, which the summary adds. */
  [key: string]: unknown;
}

export interface GameLine {
  kind: 'game';
  cell: number;
  seed: number;
  ourSeat: number;
  /** A finished game's record, or, for one a disagreement ended, its ply and report. */
  record?: GameRecord;
  disagreement?: { ply: number; comparison: string; report: string };
}

export interface CellInfo {
  cell: number;
  us: string;
  them: string;
}

export interface CellSummary extends CellInfo {
  dealPairsCounted: number;
  dealPairsLeftOut: { seed: number; reports: string[] }[];
  wins: number;
  draws: number;
  losses: number;
  /** Our score over the counted games: a win 1, a draw ½. */
  score: number | null;
  /** Wilson 95% interval on `score`. */
  interval: [number, number] | null;
  /** The Elo difference `score` implies, ours minus theirs; clamped to ±800. */
  elo: number | null;
  /** Our mean margin, our final score minus theirs. */
  margin: number | null;
  /** Our score as player 0 and as player 1. */
  scoreBySeat: [number | null, number | null];
  ours: SideFigures;
  theirs: SideFigures;
}

export interface SideFigures {
  moves: number;
  meanMs: number | null;
  p90Ms: number | null;
  meanSimulations: number | null;
  /** Ours only: the endgame proof's mean milliseconds, outside the clock ([G13-29]). */
  meanProofMs?: number | null;
}

export interface Summary {
  header: Record<string, unknown>;
  stopped: boolean;
  cells: CellSummary[];
}

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}

/** Wilson 95% interval for `points` out of `n`. */
export function wilson(points: number, n: number): [number, number] {
  const z = 1.959963984540054;
  const p = points / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function eloOf(score: number): number {
  if (score <= 0) return -800;
  if (score >= 1) return 800;
  return Math.max(-800, Math.min(800, 400 * Math.log10(score / (1 - score))));
}

function figures(moves: readonly Move[], withProof: boolean): SideFigures {
  const ms = moves.map((m) => m.ms ?? 0);
  const out: SideFigures = {
    moves: moves.length,
    meanMs: mean(ms),
    p90Ms: quantile(ms, 0.9),
    meanSimulations: mean(moves.map((m) => m.simulations ?? 0)),
  };
  if (withProof) out.meanProofMs = mean(moves.map((m) => m.proofMs ?? 0));
  return out;
}

/** Our points from a game: a win 1, a draw ½, a loss 0. */
const points = (r: GameRecord): number => (r.winner === -1 ? 0.5 : r.winner === r.ourSeat ? 1 : 0);

/**
 * [G13-40], [G13-42]: the summary of the lines of a `.jsonl`. A deal pair
 * counts only when both its games finished with no disagreement, so every
 * counted deal was played from both seats.
 */
export function summarise(text: string, cells: readonly CellInfo[], stopped: boolean): Summary {
  const lines = text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as HeaderLine | GameLine);
  const header = lines.find((l): l is HeaderLine => l.kind === 'header');
  if (header === undefined) throw new Error('the results have no header line');
  const games = lines.filter((l): l is GameLine => l.kind === 'game');
  const out: CellSummary[] = [];
  for (const info of cells) {
    const mine = games.filter((g) => g.cell === info.cell);
    const bySeed = new Map<number, GameLine[]>();
    for (const g of mine) bySeed.set(g.seed, [...(bySeed.get(g.seed) ?? []), g]);
    const counted: GameRecord[] = [];
    const leftOut: CellSummary['dealPairsLeftOut'] = [];
    for (const [seed, pair] of [...bySeed].sort(([a], [b]) => a - b)) {
      const finished = pair.filter((g) => g.record !== undefined);
      const seats = new Set(finished.map((g) => g.ourSeat));
      if (finished.length === 2 && seats.size === 2) counted.push(...finished.map((g) => g.record!));
      else if (pair.some((g) => g.disagreement !== undefined)) {
        leftOut.push({ seed, reports: pair.flatMap((g) => (g.disagreement ? [g.disagreement.report] : [])) });
      }
      // A pair with one game unplayed (a stopped match) is neither counted nor a disagreement.
    }
    const pts = counted.map(points);
    const n = counted.length;
    const total = pts.reduce((a, b) => a + b, 0);
    const seatScore = (seat: number): number | null => mean(counted.filter((r) => r.ourSeat === seat).map(points));
    const ourMoves = counted.flatMap((r) => r.moves.filter((m) => m.side === 'ours'));
    const theirMoves = counted.flatMap((r) => r.moves.filter((m) => m.side === 'theirs'));
    out.push({
      ...info,
      dealPairsCounted: n / 2,
      dealPairsLeftOut: leftOut,
      wins: pts.filter((p) => p === 1).length,
      draws: pts.filter((p) => p === 0.5).length,
      losses: pts.filter((p) => p === 0).length,
      score: n === 0 ? null : total / n,
      interval: n === 0 ? null : wilson(total, n),
      elo: n === 0 ? null : eloOf(total / n),
      margin: mean(counted.map((r) => r.scores[r.ourSeat] - r.scores[1 - r.ourSeat])),
      scoreBySeat: [seatScore(0), seatScore(1)],
      ours: figures(ourMoves, true),
      theirs: figures(theirMoves, false),
    });
  }
  const { kind: _kind, ...rest } = header;
  return { header: rest, stopped, cells: out };
}

const pct = (x: number | null): string => (x === null ? '—' : `${(100 * x).toFixed(1)}%`);
const num = (x: number | null | undefined, d = 0): string => (x === null || x === undefined ? '—' : x.toFixed(d));

/** [G13-41]: the summary as a table, its first line saying their player ran on the CPU. */
export function table(s: Summary): string {
  const lines = [
    'Their player ran on the CPU, which is not how its author trained or measured it.',
    `${s.stopped ? 'STOPPED: ' : ''}${s.header.repeatable === true ? 'repeatable' : `not repeatable (${String(s.header.notRepeatable ?? '')})`}`,
    '',
    'us        them      pairs  W-D-L          score   95%             Elo    margin  ours ms/mv (p90) proof  sims/mv  theirs ms/mv (p90)  sims/mv  left out',
  ];
  for (const c of s.cells) {
    lines.push(
      [
        c.us.padEnd(9),
        c.them.padEnd(9),
        String(c.dealPairsCounted).padStart(5),
        `${c.wins}-${c.draws}-${c.losses}`.padEnd(14),
        pct(c.score).padStart(6),
        (c.interval ? `${pct(c.interval[0])}–${pct(c.interval[1])}` : '—').padEnd(15),
        num(c.elo).padStart(5),
        num(c.margin, 1).padStart(7),
        `${num(c.ours.meanMs)} (${num(c.ours.p90Ms)})`.padStart(16),
        num(c.ours.meanProofMs).padStart(5),
        num(c.ours.meanSimulations).padStart(8),
        `${num(c.theirs.meanMs)} (${num(c.theirs.p90Ms)})`.padStart(19),
        num(c.theirs.meanSimulations).padStart(8),
        String(c.dealPairsLeftOut.length).padStart(9),
      ].join(' '),
    );
  }
  return `${lines.join('\n')}\n`;
}
