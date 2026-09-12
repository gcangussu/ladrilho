/**
 * The search against the original's [A8-38], [A8-39], [A8-53], [A8-50].
 *
 * [A8-38] is where exactness lives. The original compiles its selection and
 * its normalisation with `fastmath`, which licenses reassociation and fused
 * operations whose rounding no fixed-order loop can match; recompiled without
 * it — the **reference search** — the arithmetic is plain IEEE, [A8-50]
 * reproduces it, and nothing legitimate is left to differ. So the comparison
 * is exact: every root visit count, every chosen action.
 *
 * The network is replaced by a lookup of what the reference search's network
 * returned, which is what makes that possible: the port's float64 forward pass
 * against ONNX Runtime's float32 one moves outputs around the sixth decimal,
 * and that is [A8-39]'s business, not this one's.
 */

import { describe, expect, it } from 'vitest';
import { createNetwork } from '../src/network.js';
import { encodeBoard } from '../src/board.js';
import { normalise, simulate, visitCounts, type Evaluator } from '../src/search.js';
import { createSession } from '../src/session.js';
import { toTheirAction } from '../src/actions.js';
import { universeRoot } from '../src/universe.js';
import { apply, fromJSON, legalActions, newGame, outcome, toJSON, type AzulJSON } from 'engine';
import { boardKey } from '../src/search.js';
import { manifest } from './support/fixtures.js';
import { CUTTING, sequences, type Sequence } from './support/sequences.js';

const SEQUENCES = sequences();

/** The network replaced by what the reference search's network returned. */
function lookupEvaluator(sequence: Sequence): Evaluator {
  return {
    normalised: true,
    evaluate(board) {
      const node = sequence.lookup.get(boardKey(board));
      if (node === undefined) {
        // A key the lookup cannot find is a divergence, not a gap: our search
        // reached a node the original's never did.
        throw new Error(`${sequence.game} seat ${sequence.seat}: the reference search never saw this board`);
      }
      return { policy: node.normalised, value: node.value };
    },
  };
}

/** The root's visit counts by their action, after a call. */
function rootCounts(session: ReturnType<typeof createSession>, position: Parameters<typeof universeRoot>[0]): Int32Array {
  const board = encodeBoard(toJSON(universeRoot(position)));
  const counts = visitCounts(session.table, board);
  if (counts === null) throw new Error('the root was never expanded');
  return counts;
}

describe('the search, against the reference search [A8-38]', () => {
  let comparedCalls = 0;
  let recordedCalls = 0;

  for (const sequence of SEQUENCES) {
    const label = `${sequence.game} seat ${sequence.seat} (${sequence.kind})`;

    /**
     * Mutation records [A8-44]. Each was made in a copy of HEAD with its
     * anchor asserted, and turned this assertion red:
     *
     * | Mutation | in |
     * | --- | --- |
     * | forced playouts removed (`forced &&` dropped in `simulate`) | `src/search.ts` |
     * | forced playouts applied at every node, not only the root | `src/search.ts` |
     * | the swap of [A8-18] step 3 removed | `src/search.ts` |
     * | `>` replaced by `>=` in `select` | `src/search.ts` (uniform sequence) |
     * | selection iterating in our action order | `src/search.ts` |
     * | `Qs` rounded once instead of after each step | `src/search.ts` |
     * | the update order changed (`Nsa` before `Qsa`) | `src/search.ts` |
     *
     * [A8-44]'s row for "`Qs` kept in float64" is struck: [A8-34] found no
     * call whose counts move when `Qs` is held in float64, and the manifest's
     * statement is its record — see the [A8-50] test below.
     */
    it(`[A8-38] replays ${label} exactly`, () => {
      const session = createSession(lookupEvaluator(sequence));
      for (let i = 0; i < sequence.compared; i++) {
        const call = sequence.calls[i];
        const choice = session.choose(call.position);
        const counts = rootCounts(session, call.position);
        const ours = [...counts];
        const theirs = [...call.reference];
        expect(ours, `${label} call ${i} (ply ${call.ply}) visit counts`).toEqual(theirs);
        expect(toTheirAction(choice.action), `${label} call ${i} chosen action`).toBe(call.chosen);
        // The root's running value too, bit for bit: it is float32 and the
        // original's is NumPy 2's float32, so every intermediate rounding of
        // [A8-50]'s update has to land in the same place.
        expect(choice.value, `${label} call ${i} root Qs`).toBe(Math.fround(call.qs));
      }
      comparedCalls += sequence.compared;
      recordedCalls += sequence.calls.length;
    });
  }

  it('[A8-38] compares enough of what was recorded', () => {
    // The floor is one half. What the corpus actually gives is reported,
    // because it is the answer to the spec's open question about the prefix
    // rule, and because a fraction that quietly fell would otherwise look the
    // same as a suite that passed.
    const fraction = comparedCalls / recordedCalls;
    process.stdout.write(
      `[A8-38] compared ${comparedCalls} of ${recordedCalls} recorded calls (${(100 * fraction).toFixed(1)}%)\n`,
    );
    expect(fraction).toBeGreaterThan(0.5);
  });

  it('[A8-38] cuts each sequence at the first deviation the tree carries', () => {
    for (const sequence of SEQUENCES) {
      const cutAt = sequence.compared;
      // Every compared call is free of the three conditions...
      for (let i = 0; i < cutAt; i++) {
        expect(sequence.calls[i].deviations.filter((d) => CUTTING.includes(d))).toEqual([]);
      }
      // ...and the call it stopped at, if any, is not.
      if (cutAt < sequence.calls.length) {
        expect(sequence.calls[cutAt].deviations.some((d) => CUTTING.includes(d))).toBe(true);
      }
      // `terminal-deal` does not cut: a terminal node is valued before any
      // board is read.
      expect(CUTTING).not.toContain('terminal-deal');
    }
  });

  it('[A8-38] the uniform-prior sequence is among them, which is where ties are exact', () => {
    const uniform = SEQUENCES.filter((s) => s.kind === 'uniform');
    expect(uniform.length).toBeGreaterThan(0);
    for (const sequence of uniform) {
      expect(sequence.compared).toBe(sequence.calls.length);
      // Its priors are equal over legal actions, so `u` ties exactly and the
      // tie-break — lowest of their indices, strictly-greater comparison — is
      // what decides. That is the only place [A8-19]'s `>` is visible.
      const node = sequence.nodes[0];
      const values = new Set(node.legal.map((a) => node.normalised[a]));
      expect(values.size).toBe(1);
    }
  });
});

describe('one simulation, step by step [A8-18], [A8-20], [A8-10]', () => {
  /** Every board worth the same, asymmetric so a swapped sign is visible. */
  const constant = (me: number, them: number): Evaluator => ({
    normalised: true,
    evaluate(_board, legal) {
      const policy = new Float32Array(180);
      let count = 0;
      for (const bit of legal) count += bit;
      for (let a = 0; a < 180; a++) policy[a] = legal[a] === 1 ? 1 / count : 0;
      return { policy, value: new Float32Array([me, them]) };
    },
  });

  /** A ply after which the other seat moves, and one after which the same does. */
  function findPlies(): { changes: AzulJSON; keeps: AzulJSON } {
    let changes: AzulJSON | null = null;
    let keeps: AzulJSON | null = null;
    for (const seed of [3, 7, 11, 19, 23, 29]) {
      const s = newGame(seed);
      while (!s.isTerminal) {
        const before = toJSON(s);
        const seat = s.currentPlayer;
        apply(s, legalActions(s)[0]);
        if (s.isTerminal) break;
        if (s.currentPlayer === seat) keeps ??= before;
        else changes ??= before;
      }
      if (changes !== null && keeps !== null) break;
    }
    if (changes === null || keeps === null) throw new Error('no such plies in the scanned games');
    return { changes, keeps };
  }

  const PLIES = findPlies();

  it('[A8-19] breaks an exact tie by the lowest of their action indices', () => {
    // With uniform priors and a value of zero everywhere, every unvisited
    // action at a fresh root scores identically, so the comparison is the only
    // thing that decides. The second simulation is where it shows: the first
    // expands the root, and the forced-playout bound is still zero at i = 1.
    //
    // Mutation record [A8-44]: `>` replaced by `>=` in `select`
    // (`src/search.ts`) — red here. The uniform-prior sequence of [A8-38] does
    // not catch it, which is why this test exists.
    const session = createSession(constant(0, 0), { simulations: 2 });
    const start = PLIES.changes;
    session.choose(start);
    const counts = visitCounts(session.table, encodeBoard(toJSON(universeRoot(start))))!;
    const visited = [...counts.keys()].filter((a) => counts[a] > 0);
    expect(visited).toHaveLength(1);
    const legal = start.legalActions.map(toTheirAction).sort((a, b) => a - b);
    expect(legal.length).toBeGreaterThan(1);
    expect(visited[0]).toBe(legal[0]);
  });

  it('[A8-18] values a drawn game at the original’s 0.01, for both seats', () => {
    // No recorded game ends level, so the draw arm is reached here instead:
    // equal scores and equally many complete rows is what [0001 E1-39] calls a
    // draw, and `check_end_game` answers 0.01 to both seats rather than 0.
    const s = newGame(5);
    while (!s.isTerminal) apply(s, legalActions(s)[0]);
    const drawn = fromJSON({ ...toJSON(s), scores: [50, 50] }, 0);
    drawn.scores = [50, 50];
    drawn.walls = [drawn.walls[0], drawn.walls[0].slice()];
    expect(outcome(drawn)).toBe(0);
    const value = simulate(new Map(), constant(0.5, -0.5), drawn, 0);
    expect(value).toEqual([Math.fround(0.01), Math.fround(0.01)]);
    expect(value[0]).not.toBe(0);
  });

  it('[A8-18] values a finished game from the seat to move, drawn games included', () => {
    // Step 1: terminal before any board is read. A game played to its end and
    // then asked for a value is what the search sees at a leaf.
    const s = newGame(41);
    while (!s.isTerminal) apply(s, legalActions(s)[0]);
    const decided = outcome(s);
    const value = simulate(new Map(), constant(0.5, -0.5), s, 0);
    if (decided === 0) {
      expect(value).toEqual([Math.fround(0.01), Math.fround(0.01)]);
    } else {
      const winner = decided === 1 ? 0 : 1;
      expect(value).toEqual(winner === s.currentPlayer ? [1, -1] : [-1, 1]);
    }
  });

  it('[A8-20] swaps the value when the seat changes, and not when it does not', () => {
    // The trap of [0004 B4-18], handled the original's way: a boundary ply can
    // leave the same seat to move, so the sign follows `currentPlayer` and
    // never ply parity.
    //
    // Two simulations, by hand: the first expands the root (Qs = 0.6); the
    // second descends one ply to a fresh child worth 0.6 to *whoever moves
    // there*, and backs it up. When the seat changed, the root sees -0.6 and
    // Qs becomes ((0 + 1)·0.6 + −0.6) / 2 = 0. When it did not, the root sees
    // 0.6 and Qs stays 0.6.
    const changed = createSession(constant(0.6, -0.6), { simulations: 2 });
    expect(changed.choose(PLIES.changes).value).toBe(0);

    const kept = createSession(constant(0.6, -0.6), { simulations: 2 });
    expect(kept.choose(PLIES.keeps).value).toBeCloseTo(0.6, 6);
  });

  it('[A8-10] keys the node table by the board, so equal boards are one node', () => {
    // Two positions that encode alike are one node [A8-10]: this is the
    // original's transposition handling, and dropping it would merge fewer
    // visit counts, which is what [A8-38] would then catch.
    const position = PLIES.changes;
    const session = createSession(constant(0.2, -0.2), { simulations: 30 });
    session.choose(position);
    const board = encodeBoard(toJSON(universeRoot(position)));
    const copy = Int8Array.from(board);
    expect(boardKey(copy)).toBe(boardKey(board));
    expect(session.table.get(boardKey(copy))).toBe(session.table.get(boardKey(board)));
    // A board differing in one cell is a different node.
    copy[0] += 1;
    expect(boardKey(copy)).not.toBe(boardKey(board));
    expect(session.table.has(boardKey(copy))).toBe(false);
  });
});

describe('the search with the real network [A8-39]', () => {
  it('[A8-39] chooses the as-shipped search’s action on at least 99% of compared calls', () => {
    const network = createNetwork();
    const evaluator: Evaluator = {
      normalised: false,
      evaluate: (board, legal) => network.evaluate(board, legal),
    };
    let agreed = 0;
    let total = 0;
    let referenceDisagreements = 0;
    const disagreements: string[] = [];
    for (const sequence of SEQUENCES.filter((s) => s.kind === 'network')) {
      const session = createSession(evaluator);
      for (let i = 0; i < sequence.compared; i++) {
        const call = sequence.calls[i];
        const choice = session.choose(call.position);
        const ours = toTheirAction(choice.action);
        total++;
        if (ours === call.shippedChosen) agreed++;
        else {
          disagreements.push(
            `${sequence.game} seat ${sequence.seat} call ${i} (ply ${call.ply}): ` +
              `ours ${ours} visits ${[...rootCounts(session, call.position)].filter((n) => n > 0).length} nonzero, ` +
              `theirs ${call.shippedChosen}`,
          );
        }
        if (call.chosen !== call.shippedChosen) referenceDisagreements++;
      }
    }
    for (const line of disagreements) process.stdout.write(`[A8-39] ${line}\n`);
    process.stdout.write(
      `[A8-39] agreed on ${agreed}/${total}; the reference and as-shipped searches ` +
        `themselves disagree on ${referenceDisagreements}\n`,
    );
    expect(total).toBeGreaterThan(50);
    expect(agreed / total).toBeGreaterThanOrEqual(0.99);
    // Eight thousand forward passes at 100 simulations a call: the one test
    // here that costs seconds rather than milliseconds, and the reason
    // [A8-46]'s budget is a `SHOULD`.
  }, 30_000);
});

describe('normalisation [A8-53], and the number types [A8-50]', () => {
  // Mutation record [A8-44]: `normalise` in `src/search.ts` summing in
  // float64 and rounding once — red here, and green everywhere else, because
  // [A8-38] is handed priors that are already normalised.
  it('[A8-53] reproduces the recorded normalised prior bit for bit', () => {
    let checked = 0;
    for (const sequence of SEQUENCES.filter((s) => s.kind === 'network')) {
      for (const node of sequence.nodes) {
        const ours = normalise(node.raw);
        for (const a of node.legal) {
          expect(ours[a], `${sequence.game} action ${a}`).toBe(node.normalised[a]);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('[A8-50] the original held a node’s Qs in float32, and said so', () => {
    // [A8-34] asserts this type at generation time; this is the recorded
    // answer, which is what the NumPy 2 pin is for.
    for (const sequence of manifest().sequences) {
      for (const call of sequence.calls) expect(call.qsType).toBe('float32');
    }
    expect(manifest().versions['numpy']).toMatch(/^2\./);
  });

  it('[A8-50] records that a float64 Qs changed no visit count anywhere', () => {
    // [A8-44]'s row for "Qs kept in float64" is struck on exactly this
    // evidence: the generator reran every sequence with a float64 `Qs` and
    // found no call whose counts moved, so there is no witness to mutate
    // against. The statement is the record.
    const witnesses = manifest().sequences.map((s) => s.witness);
    expect(witnesses.every((w) => w === null)).toBe(true);
    process.stdout.write(
      `[A8-50] no float32 witness in ${witnesses.length} sequences: the float64-Qs mutation row is struck\n`,
    );
  });
});
