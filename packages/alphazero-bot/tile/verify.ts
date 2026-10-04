/**
 * The translation, checked against their engine rather than trusted.
 *
 * Plays random games on our engine. At every ply the position goes to their
 * engine through `toTheirs`, which must agree on the legal moves; then the
 * same move is played on both, and their resulting game must equal
 * `toTheirs` of ours. Across a round boundary each side deals from its own
 * shuffle, so there only what dealing cannot change is compared: scores,
 * walls, pattern lines, floors, the marker, whose turn, the round, the
 * outcome, and the per-colour tile totals.
 *
 * A match is judged on our engine, so a disagreement here does not corrupt a
 * result; it means their player plans by rules that differ from the ones it is
 * scored by, and every disagreement is printed so it can be weighed.
 */

import { apply, clone, isLegal, legalActions, newGame, outcome, Rng, FLOOR, type AzulState } from 'engine';
import { actionFromTheirs, actionToTheirs, toTheirs, type TheirGame } from './convert.js';
import type { Theirs, TheirUi } from './theirs.js';

export interface VerifyReport {
  games: number;
  plies: number;
  roundEnds: number;
  terminals: number;
  disagreements: string[];
}

const DEALT = new Set(['bag', 'discards', 'centre', 'factories', 'cfg']);

function totals(g: TheirGame): number[] {
  const t = [0, 0, 0, 0, 0];
  for (let c = 0; c < 5; c++) {
    t[c] += g.bag[c] + g.discards[c] + g.centre[c];
    for (const f of g.factories) t[c] += f[c];
  }
  return t;
}

/**
 * Where the two engines say the same thing differently:
 * - a floor holds at most seven tiles on ours, the rest going to the lid;
 *   theirs keeps counting. The discards agree and slots past the seventh cost
 *   nothing on both, so only the count is capped before comparing;
 * - a finished game: theirs leaves the marker and the turn where the last ply
 *   put them and adds an `outcome`, which is compared separately.
 */
function normalise(g: TheirGame, terminal: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...g, pattern_counts: g.pattern_counts.map((r) => [...r.slice(0, 5), Math.min(7, r[5])]) };
  if (terminal) for (const k of ['to_play', 'token_in_centre', 'token_owner', 'outcome']) delete out[k];
  return out;
}

function compare(oursRaw: TheirGame, theirsRaw: TheirGame, dealt: boolean, terminal = false): string[] {
  const out: string[] = [];
  const ours = normalise(oursRaw, terminal);
  const theirs = normalise(theirsRaw, terminal);
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const k of keys) {
    if (k === 'cfg' || (dealt && DEALT.has(k))) continue;
    const a = JSON.stringify(ours[k]);
    const b = JSON.stringify(theirs[k]);
    if (a !== b) out.push(`${k}: ours ${a}, theirs ${b}`);
  }
  if (dealt) {
    // Walls and pattern lines hold the rest of the 100 tiles; those are compared above.
    const a = JSON.stringify(totals(oursRaw));
    const b = JSON.stringify(totals(theirsRaw));
    if (a !== b) out.push(`tile totals off the boards: ours ${a}, theirs ${b}`);
  }
  return out;
}

/** Mostly pattern-line moves, so games reach completed rows and the end. */
function pick(s: AzulState, rng: Rng): number {
  const legal = legalActions(s);
  const lines = legal.filter((a) => a % 6 !== FLOOR);
  const pool = lines.length > 0 && rng.below(10) < 8 ? lines : legal;
  return pool[rng.below(pool.length)];
}

export function verify(t: Theirs, games: number, seed: number, log: (s: string) => void): VerifyReport {
  const engine = new t.mod.AzulEngine();
  const report: VerifyReport = { games, plies: 0, roundEnds: 0, terminals: 0, disagreements: [] };
  const rng = new Rng(seed);
  for (let g = 0; g < games; g++) {
    const gameSeed = (seed * 7919 + g) | 0;
    const s = newGame(gameSeed);
    // Their own opening, beside ours: the one comparison that does not pass
    // through `toTheirs` on both sides, so it pins the conventions their
    // engine only echoes back — that `round` counts from 1, for one.
    const opening = engine.new_game(BigInt(gameSeed >>> 0), 'P0', 'P0');
    for (const d of compare(toTheirs(s, gameSeed), opening.game as unknown as TheirGame, true)) {
      report.disagreements.push(`game ${g} (seed ${gameSeed}), their new_game: ${d}`);
    }
    let ply = 0;
    while (!s.isTerminal) {
      const where = `game ${g} (seed ${gameSeed}) ply ${ply}`;
      const before = toTheirs(s, gameSeed);
      let ui: TheirUi;
      try {
        ui = engine.set_state(before, 'P0');
      } catch (e) {
        report.disagreements.push(`${where}: their engine refused the position: ${String(e)}`);
        break;
      }
      const echoed = compare(before, ui.game as unknown as TheirGame, false);
      for (const d of echoed) report.disagreements.push(`${where}, set_state echo: ${d}`);
      const theirLegal = ui.legal.map((l) => actionFromTheirs(l.id)).sort((a, b) => a - b);
      const ourLegal = legalActions(s).slice().sort((a, b) => a - b);
      if (JSON.stringify(theirLegal) !== JSON.stringify(ourLegal)) {
        report.disagreements.push(`${where}: legal moves differ: ours ${ourLegal.join(',')}, theirs ${theirLegal.join(',')}`);
      }
      const a = pick(s, rng);
      const round = s.roundIndex;
      const prior = clone(s);
      apply(s, a);
      let after: TheirUi;
      try {
        after = engine.play_action_id(actionToTheirs(a));
      } catch (e) {
        report.disagreements.push(`${where}: their engine refused ${a} (theirs ${actionToTheirs(a)}): ${String(e)}`);
        break;
      }
      const dealt = s.roundIndex !== round || s.isTerminal;
      if (dealt) report.roundEnds++;
      const diffs = compare(toTheirs(s, gameSeed), after.game as unknown as TheirGame, dealt, s.isTerminal);
      if (s.isTerminal) {
        report.terminals++;
        const code = engine.game_outcome_code();
        const o = outcome(s);
        const ourCode = o === 1 ? 1 : o === -1 ? 2 : 3;
        if (code !== ourCode) diffs.push(`outcome: ours ${ourCode}, theirs ${code} (scores ${s.scores.join(':')})`);
      }
      for (const d of diffs) report.disagreements.push(`${where}, after ${a}${isLegal(prior, a) ? '' : ' (illegal?)'}: ${d}`);
      ply++;
      report.plies++;
    }
    log(`verify: game ${g + 1}/${games}, ${ply} plies, ${s.scores.join(':')}, ${report.disagreements.length} disagreements so far`);
  }
  engine.free();
  return report;
}
