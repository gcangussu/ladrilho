/**
 * Does their endgame solver ever choose a worse move than their minimax?
 *
 * Positions come from their own play: games of their single-threaded minimax
 * against itself, every ply from round 5 on with more than one legal move.
 * At each, their threaded minimax picks a move (what the page plays when the
 * solver declines), their solver is probed as the page's tail-probe branch
 * probes it, and both moves are graded by an exact search of our own on our
 * engine.
 *
 * Exact here means: nothing is dealt until a round ends, so the rest of a
 * round is a game of perfect information, and a line that ends the game at
 * the round's end has an exact result. A line that goes on to another round
 * meets the bag, and has none. So each value is searched twice, once with
 * every such line scored as a win for player 0 and once as a loss; minimax is
 * monotone in its leaves, so when the two agree no continuing line can matter
 * and the value is exact. When they disagree the move is not graded.
 *
 * Values are from the mover's side: outcome (win 1, draw 0, loss -1, ties
 * broken on rows as the rules say) times 1000, plus the final margin.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { apply, clone, FLOOR, legalActions, newGame, outcome, type AzulState } from 'engine';
import { actionFromTheirs, toTheirs } from './convert.js';
import { TheirPlayer, type Theirs } from './theirs.js';

const BIG = 1_000_000;

export class Budget extends Error {}

/** Exact minimax to the round's end, alpha-beta with a transposition table. */
export class Exact {
  private readonly tt = new Map<string, { lo: number; hi: number }>();
  nodes = 0;

  constructor(
    /**
     * What a line that continues past the round is worth to player 0: a
     * constant here; a function of the position only in the search's own test,
     * where constant leaves would hide a table that mixes up its bounds.
     */
    private readonly cont: number | ((s: AzulState) => number),
    private readonly maxNodes: number,
  ) {}

  private static key(s: AzulState): string {
    return [
      s.factories.flat().join(''),
      s.center.join(','),
      s.markerInCenter ? 1 : 0,
      s.walls.flat().join(''),
      s.plColor.flat().join(','),
      s.plCount.flat().join(''),
      s.floor.flat().join(','),
      s.floorMarker.map((m) => (m ? 1 : 0)).join(''),
      s.scores.join(','),
      s.currentPlayer,
    ].join('|');
  }

  /** The value to player 0 of `s`, which is mid-round `round`. */
  value(s: AzulState, round: number, alpha = -Infinity, beta = Infinity): number {
    if (s.isTerminal) {
      const o = outcome(s)!;
      return o * 1000 + (s.scores[0] - s.scores[1]);
    }
    if (s.roundIndex !== round) return typeof this.cont === 'number' ? this.cont : this.cont(s);
    if (++this.nodes > this.maxNodes) throw new Budget();
    const key = Exact.key(s);
    const hit = this.tt.get(key);
    if (hit) {
      if (hit.lo === hit.hi) return hit.lo;
      if (hit.lo >= beta) return hit.lo;
      if (hit.hi <= alpha) return hit.hi;
      alpha = Math.max(alpha, hit.lo);
      beta = Math.min(beta, hit.hi);
    }
    const a0 = alpha;
    const b0 = beta;
    const max = s.currentPlayer === 0;
    // Pattern-line moves first: they are usually the better ones, and order is what alpha-beta lives on.
    const moves = legalActions(s).slice().sort((x, y) => Number(x % 6 === FLOOR) - Number(y % 6 === FLOOR));
    let best = max ? -Infinity : Infinity;
    for (const m of moves) {
      const c = clone(s);
      apply(c, m);
      const v = this.value(c, round, alpha, beta);
      if (max) {
        if (v > best) best = v;
        if (best > alpha) alpha = best;
      } else {
        if (v < best) best = v;
        if (best < beta) beta = best;
      }
      if (alpha >= beta) break;
    }
    const prev = this.tt.get(key) ?? { lo: -Infinity, hi: Infinity };
    if (best <= a0) prev.hi = Math.min(prev.hi, best);
    else if (best >= b0) prev.lo = Math.max(prev.lo, best);
    else prev.lo = prev.hi = best;
    this.tt.set(key, prev);
    return best;
  }
}

/** The exact value to the mover of playing `m` in `s`, or null when continuing lines decide it or the budget runs out. */
function grade(s: AzulState, m: number, optimistic: Exact, pessimistic: Exact): number | null {
  const mover = s.currentPlayer;
  const c = clone(s);
  apply(c, m);
  try {
    const hi = optimistic.value(c, s.roundIndex);
    const lo = pessimistic.value(c, s.roundIndex);
    if (hi !== lo) return null;
    return mover === 0 ? hi : -hi;
  } catch (e) {
    if (e instanceof Budget) return null;
    throw e;
  }
}

export interface CheckOptions {
  games: number;
  seed: number;
  /** Their minimax's budget in the self-play games that make the positions. */
  playNodes: number;
  /** Their threaded minimax's budget at each position. */
  nodes: number;
  threads: number;
  tailMs: number;
  maxNodes: number;
  out: string;
}

export interface Row {
  game: number;
  ply: number;
  round: number;
  legal: number;
  minimax: number;
  solverComplete: boolean;
  solverReason: string;
  solver: number | null;
  /** Exact values to the mover; null when not exact. */
  best: number | null;
  vMinimax: number | null;
  vSolver: number | null;
  ms: { minimax: number; solver: number; exact: number };
}

export function solverCheck(t: Theirs, o: CheckOptions, log: (s: string) => void): Row[] {
  if (t.threaded === null) throw new Error('solver-check needs their threaded build');
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(`${o.out}.jsonl`, `${JSON.stringify({ header: { ...o, settings: t.settings } })}\n`);
  const rows: Row[] = [];
  const tmod = t.threaded.mod as unknown as { AzulSearch: new () => any; AzulEngine: new () => any };
  const search = new tmod.AzulSearch();
  search.set_minimax_pruning_overrides(t.settings.pruning);
  search.set_minimax_tt_use_zobrist(true);
  search.set_minimax_threaded_shared_tt_racy_verify?.(true);
  search.load_nnue_bytes(t.nnue);
  search.use_nnue_model();
  const engine = new tmod.AzulEngine();
  const st = t.settings;
  for (let g = 0; g < o.games; g++) {
    const gameSeed = (o.seed + g) | 0;
    const players = [0, 1].map((p) => new TheirPlayer(t, { kind: 'nnue', nodes: o.playNodes, threads: 1 }, gameSeed * 2 + p));
    const s = newGame(gameSeed);
    let ply = 0;
    while (!s.isTerminal) {
      const legal = legalActions(s);
      if (s.roundIndex >= 4 && legal.length > 1) {
        engine.set_state(toTheirs(s, gameSeed), 'P0');
        const bytes = engine.game_bytes();
        const seed = BigInt.asUintN(64, (BigInt(gameSeed) << 20n) ^ BigInt(ply) ^ 0x51ed27n);
        let t0 = performance.now();
        const tail = search.tail_solve_root_shared_tree_limited_bytes(bytes, o.threads, seed, st.mctsScoreValueWeight, st.scoreValueScale, o.tailMs, 2_000_000);
        const solverMs = performance.now() - t0;
        const complete = tail.root?.solver_complete === true;
        let solver: number | null = null;
        if (complete) {
          const r = tail.root;
          let b = 0;
          for (let i = 1; i < r.actions.length; i++) if (r.visits[i] > r.visits[b]) b = i;
          solver = actionFromTheirs(r.actions[b]);
        }
        t0 = performance.now();
        const mm = search.minimax_root_threaded_bytes(bytes, o.nodes, seed, o.threads, st.minimaxScoreValueWeight, st.minimaxTerminalScoreValueWeight, st.scoreValueScale);
        const minimaxMs = performance.now() - t0;
        const minimax = actionFromTheirs(mm.best_action);
        t0 = performance.now();
        let best: number | null = null;
        let vMinimax: number | null = null;
        let vSolver: number | null = null;
        if (complete) {
          const up = new Exact(BIG, o.maxNodes);
          const down = new Exact(-BIG, o.maxNodes);
          vMinimax = grade(s, minimax, up, down);
          vSolver = solver === minimax ? vMinimax : grade(s, solver!, up, down);
          // The best move's exact value, when every move's is exact.
          const all = legal.map((m) => (m === minimax ? vMinimax : m === solver ? vSolver : grade(s, m, up, down)));
          best = all.every((v) => v !== null) ? Math.max(...(all as number[])) : null;
        }
        const row: Row = {
          game: g,
          ply,
          round: s.roundIndex + 1,
          legal: legal.length,
          minimax,
          solverComplete: complete,
          solverReason: String(tail.root?.tail_solver_reason ?? tail.reason ?? ''),
          solver,
          best,
          vMinimax,
          vSolver,
          ms: { minimax: Math.round(minimaxMs), solver: Math.round(solverMs), exact: Math.round(performance.now() - t0) },
        };
        rows.push(row);
        appendFileSync(`${o.out}.jsonl`, `${JSON.stringify(row)}\n`);
      }
      const p = players[s.currentPlayer].choose(s);
      apply(s, p.action);
      ply++;
    }
    for (const p of players) p.free();
    const done = rows.filter((r) => r.game === g);
    log(`solver-check: game ${g + 1}/${o.games}, ${done.length} positions, ${done.filter((r) => r.solverComplete).length} solved`);
  }
  search.free();
  engine.free();
  return rows;
}

export function summariseCheck(rows: Row[]): string {
  const solved = rows.filter((r) => r.solverComplete);
  const differ = solved.filter((r) => r.solver !== r.minimax);
  const graded = differ.filter((r) => r.vSolver !== null && r.vMinimax !== null);
  const outcomeOf = (v: number) => Math.round(v / 1000);
  const better = graded.filter((r) => r.vSolver! > r.vMinimax!);
  const worse = graded.filter((r) => r.vSolver! < r.vMinimax!);
  const lines = [
    `positions (round 5+, more than one move): ${rows.length}`,
    `solver completed: ${solved.length} (${((100 * solved.length) / rows.length).toFixed(1)}%)`,
    `solver and minimax agree: ${solved.length - differ.length}; differ: ${differ.length}`,
    `differences graded exactly: ${graded.length}`,
    `  solver better: ${better.length} (of which the outcome changes: ${better.filter((r) => outcomeOf(r.vSolver!) !== outcomeOf(r.vMinimax!)).length})`,
    `  equal value:   ${graded.length - better.length - worse.length}`,
    `  solver worse:  ${worse.length} (of which the outcome changes: ${worse.filter((r) => outcomeOf(r.vSolver!) !== outcomeOf(r.vMinimax!)).length})`,
  ];
  const withBest = solved.filter((r) => r.best !== null && r.vSolver !== null && r.vMinimax !== null);
  if (withBest.length > 0) {
    lines.push(
      `positions with every move graded: ${withBest.length}`,
      `  solver optimal:  ${withBest.filter((r) => r.vSolver === r.best).length}`,
      `  minimax optimal: ${withBest.filter((r) => r.vMinimax === r.best).length}`,
    );
  }
  const reasons = new Map<string, number>();
  for (const r of rows) {
    const k = r.solverReason.replace(/:.*$/, '');
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  lines.push(`solver reasons: ${[...reasons].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  return lines.join('\n');
}
