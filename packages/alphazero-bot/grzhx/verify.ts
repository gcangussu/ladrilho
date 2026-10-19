/**
 * `grzhx verify` ([G13-44]): games of uniformly random legal moves from
 * recorded seeds, every comparison of [G13-17] at every ply, and one search
 * of theirs on the lockstep game at 16 simulations per ply, so the import and
 * the search are exercised as play uses them.
 */

import { Rng } from 'engine';
import { disagreementRecord, Disagreement, emptyCensus, playGame, type Census, type DisagreementRecord, type Mover } from './game.js';
import type { Host } from './processes.js';

export const VERIFY_CELL = 0;
export const VERIFY_SIMULATIONS = 16;

export interface VerifyResult extends Census {
  games: number;
  disagreements: DisagreementRecord[];
  /** Positions the run passed, for `fixtures` ([G13-46]). */
  positions: { position: unknown; imported: unknown }[];
}

/** The cell `verify` configures: their search at 16 simulations, every other setting at its default. */
export const verifyCells = [{ id: VERIFY_CELL, budget: { kind: 'sims', n: VERIFY_SIMULATIONS } }];

export async function verify(host: Host, games: number, seed: number, log: (s: string) => void, timeoutMs = 600_000): Promise<VerifyResult> {
  const census = emptyCensus();
  const disagreements: DisagreementRecord[] = [];
  for (let g = 0; g < games; g++) {
    const gameSeed = seed + g;
    const rng = new Rng(gameSeed ^ 0x5eed);
    const random: Mover = async (position) => {
      // Their search runs on the lockstep game every ply; its move is not played.
      await host.ask({ type: 'move' }, timeoutMs, `verify seed ${gameSeed}: search`);
      return { side: 'other', action: position.legalActions[rng.below(position.legalActions.length)] };
    };
    try {
      await playGame({ host, cell: VERIFY_CELL, matchSeed: seed, seed: gameSeed, ourSeat: 0, ours: random, theirs: random, timeoutMs }, census);
    } catch (e) {
      if (!(e instanceof Disagreement)) throw e;
      const r = disagreementRecord({ seed: gameSeed, ourSeat: 0 }, e);
      disagreements.push(r);
      log(`seed ${gameSeed}: ${e.message}`);
    }
    if ((g + 1) % 10 === 0) log(`${g + 1}/${games} games, ${census.plies} plies, ${disagreements.length} disagreements`);
  }
  return { games, ...census, disagreements, positions: [] };
}
