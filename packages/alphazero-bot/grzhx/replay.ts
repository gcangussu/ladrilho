/**
 * `grzhx replay <report>` ([G13-43]) and `grzhx fixtures` ([G13-46]).
 *
 * A replay plays a disagreement report's moves again from its seed, with our
 * engine and a fresh lockstep game, running every comparison of [G13-17], and
 * searches nothing. It exits 0 when the disagreement no longer reproduces, as
 * `crosscheck replay` does.
 */

import { readFileSync } from 'node:fs';
import { apply, newGame, Rng, toJSON } from 'engine';
import { writeAtomic } from '../eval/files.js';
import { dealTiles, importArgs } from './convert.js';
import { Disagreement, playGame, type DisagreementRecord, type Mover } from './game.js';
import type { HostLike as Host } from './processes.js';

/** The cell a replay configures: its search is never run. */
export const REPLAY_CELLS = [{ id: 0, budget: { kind: 'sims', n: 16 } }];

class ReplayEnd extends Error {}

export interface ReplayOutcome {
  reproduced: boolean;
  ply: number | null;
  comparison: string | null;
}

/** [G13-43]: the report's game again, its moves in order, every comparison run. */
export async function replay(host: Host, report: Pick<DisagreementRecord, 'seed' | 'ourSeat' | 'moves'> & { matchSeed?: number }, timeoutMs = 600_000): Promise<ReplayOutcome> {
  const end: Mover = async () => {
    throw new ReplayEnd('the report has no more moves');
  };
  try {
    await playGame({
      host, cell: 0, matchSeed: report.matchSeed ?? 0, seed: report.seed, ourSeat: report.ourSeat,
      ours: end, theirs: end, timeoutMs, replay: report.moves,
    });
    return { reproduced: false, ply: null, comparison: null };
  } catch (e) {
    if (e instanceof ReplayEnd) return { reproduced: false, ply: null, comparison: null };
    if (e instanceof Disagreement) return { reproduced: true, ply: e.ply, comparison: e.comparison };
    throw e;
  }
}

export function readReport(path: string): DisagreementRecord & { matchSeed?: number } {
  return JSON.parse(readFileSync(path, 'utf8')) as DisagreementRecord & { matchSeed?: number };
}

/** The fields of `toJSON`'s view `importArgs` reads: what a fixture keeps of a position. */
export type FixturePosition = Pick<ReturnType<typeof toJSON>, 'round' | 'currentPlayer' | 'firstPlayer' | 'factories' | 'center' | 'markerInCenter' | 'bag' | 'lid' | 'scores'> & {
  players: Pick<ReturnType<typeof toJSON>['players'][number], 'wall' | 'patternLines' | 'floor' | 'floorMarker'>[];
};

export function fixturePosition(j: ReturnType<typeof toJSON>): FixturePosition {
  return {
    round: j.round, currentPlayer: j.currentPlayer, firstPlayer: j.firstPlayer, factories: j.factories, center: j.center,
    markerInCenter: j.markerInCenter, bag: j.bag, lid: j.lid, scores: j.scores,
    players: j.players.map((p) => ({ wall: p.wall, patternLines: p.patternLines, floor: p.floor, floorMarker: p.floorMarker })),
  };
}

/** One recorded ply: our position, and what `convert.ts` made of it. */
export interface FixturePly {
  position: FixturePosition;
  imported: ReturnType<typeof importArgs>;
}

/** One recorded deal: the bag before it, the factories it dealt, and the order `dealTiles` gave. */
export interface FixtureDeal {
  bagBefore: number[];
  factories: number[][];
  tiles: number[];
}

export interface ConvertFixture {
  pin: string;
  plies: FixturePly[];
  deals: FixtureDeal[];
}

/**
 * [G13-46]: random games from fixed seeds, played through the host with every
 * comparison, recording every fourth ply's translation and every deal's
 * order. Writes nothing if any game disagrees: only a translation their
 * engine accepted and matched becomes a fixture.
 */
export async function recordFixtures(host: Host, pin: string, path: string, games = 8, seed = 7000, timeoutMs = 600_000): Promise<ConvertFixture> {
  const fixture: ConvertFixture = { pin, plies: [], deals: [] };
  for (let g = 0; g < games; g++) {
    const gameSeed = seed + g;
    const rng = new Rng(gameSeed ^ 0xf1c5);
    // The moves first, on our engine alone, so the fixture is what the game played.
    const s = newGame(gameSeed);
    const moves: number[] = [];
    let ply = 0;
    while (!s.isTerminal) {
      const j = toJSON(s);
      if (ply % 4 === 0) fixture.plies.push({ position: fixturePosition(j), imported: importArgs(j) });
      const a = j.legalActions[rng.below(j.legalActions.length)];
      const round = s.roundIndex;
      apply(s, a);
      moves.push(a);
      if (!s.isTerminal && s.roundIndex !== round) {
        fixture.deals.push({ bagBefore: j.bag, factories: s.factories.map((f) => f.slice()), tiles: dealTiles(j.bag, s.factories) });
      }
      ply++;
    }
    // Then the same game through the host: every comparison must pass.
    const out = await replay(host, { seed: gameSeed, ourSeat: 0, moves }, timeoutMs);
    if (out.reproduced) throw new Error(`fixture game seed ${gameSeed} disagrees at ply ${out.ply}: ${out.comparison}; nothing written`);
  }
  const refilling = fixture.deals.filter((d) => {
    const n = d.bagBefore.reduce((a, b) => a + b, 0);
    return n > 0 && n < 20 && n % 4 !== 0;
  }).length;
  if (refilling === 0) throw new Error('no fixture deal refilled the bag inside a factory: play more games; nothing written');
  writeAtomic(path, `${JSON.stringify(fixture)}\n`);
  return fixture;
}
