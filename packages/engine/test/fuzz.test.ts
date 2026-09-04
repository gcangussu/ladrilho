/**
 * Randomised self-play [0002 V2-24].
 *
 * This is fuzz coverage, not oracle coverage: it catches crashes and broken
 * invariants in positions the vectors never reach. Nothing here compares
 * against a recording, so nothing here can tell you the rules are *right* —
 * only that the engine never contradicts itself or falls over.
 */

import { describe, expect, it } from 'vitest';
import { Rng, apply, legalActions, newGame, tileCensus, type AzulState } from '../src/index.js';
import { FULL_CENSUS, checkCensus, checkInvariants } from './support/invariants.js';

const GAMES = 200;
const PLY_CAP = 400;

describe('randomised self-play', () => {
  it('finishes 200 games without throwing, conserving tiles and never passing', () => {
    // The move picker uses the engine's own generator rather than
    // `Math.random`, so a failure names a seed that reproduces it exactly.
    const faults: string[] = [];
    let totalPlies = 0;
    let terminalGames = 0;

    for (let seed = 0; seed < GAMES; seed++) {
      const s: AzulState = newGame(seed);
      const picker = new Rng(seed ^ 0x5eed);
      let plies = 0;
      let previousShufflesUsed = s.shufflesUsed;

      const censusFault = checkCensus(s, FULL_CENSUS);
      if (censusFault !== null) faults.push(`seed ${seed} opening: ${censusFault}`);

      while (!s.isTerminal && plies < PLY_CAP) {
        const legal = legalActions(s);
        // [E1-12] a non-terminal position always has a move, so the engine
        // never deadlocks and never needs to pass.
        if (legal.length === 0) {
          faults.push(`seed ${seed} ply ${plies}: no legal action in a live position`);
          break;
        }
        // Legal by construction: the action came out of `legalActions`, so an
        // `apply` that throws here is a disagreement between the two.
        apply(s, legal[picker.below(legal.length)]);
        plies++;

        const fault =
          checkCensus(s, FULL_CENSUS) ??
          checkInvariants(s, null, previousShufflesUsed);
        if (fault !== null) {
          faults.push(`seed ${seed} ply ${plies}: ${fault}`);
          break;
        }
        previousShufflesUsed = s.shufflesUsed;
      }

      totalPlies += plies;
      if (s.isTerminal) terminalGames++;
      else faults.push(`seed ${seed}: still running after ${PLY_CAP} plies`);
      // Exhaustion is unreachable from a full census [E1-37], so a self-played
      // game must always end by wall row completion [E1-36].
      if (s.exhausted) faults.push(`seed ${seed}: ended exhausted from a full census`);
      if (tileCensus(s).some((n, i) => n !== FULL_CENSUS[i])) {
        faults.push(`seed ${seed}: final census ${tileCensus(s).join(',')}`);
      }
    }

    expect(faults.slice(0, 5)).toEqual([]);
    expect(terminalGames).toBe(GAMES);
    expect(totalPlies).toBeGreaterThan(GAMES * 40);
  });
});
