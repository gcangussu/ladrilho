/**
 * The fixtures of [A8-34], loaded.
 *
 * The manifest records each game as a seed and the actions played; the
 * positions are rebuilt here by replaying them through the engine, which is
 * exact ([0001 E1-46]) and keeps the committed files small. Record `i` of
 * every binary file belongs to `manifest.records[i]`, which names the game and
 * the ply.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, newGame, toJSON, type AzulJSON } from 'engine';

const DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export interface FixtureGame {
  id: string;
  seed: number;
  players: string[];
  actions: number[];
  /** The bag's size at each refill, by ply [A8-51]. */
  deals: { ply: number; bagBefore: number }[];
}

export interface Manifest {
  upstream: { repository: string; commit: string };
  checkpoint: { path: string; sha256: string };
  licenseSha256: string;
  versions: Record<string, string>;
  constants: Record<string, number | boolean | number[] | string>;
  initialBoard: number[];
  games: FixtureGame[];
  /** Which of [A8-51]'s deals the corpus turned out to hold. */
  coverage: Record<string, boolean>;
  sequences: {
    game: string;
    seat: number;
    kind: string;
    witness: number | null;
    nodesFrom: number;
    nodesTo: number;
    calls: {
      index: number;
      ply: number;
      chosen: number;
      shippedChosen: number;
      qs: number;
      qsType: string;
      deviations: string[];
      nodesAdded: number;
    }[];
  }[];
  records: { game: string; ply: number; theirNextPlayer: number }[];
  files: Record<string, { name: string; stride: number; type: string }>;
}

export interface FixturePosition {
  game: string;
  ply: number;
  position: AzulJSON;
  /** The action our game played here, in our encoding. */
  action: number;
  /**
   * The original's board after that action, in canonical form — from the
   * perspective of whoever it has to move [A8-36].
   */
  theirs: Int8Array;
  /**
   * `0` when the original leaves the same seat to move. Compared against our
   * engine's answer, this is what recognises `no-centre-take`.
   */
  theirNextPlayer: number;
  /** The original's board, 138 int8. */
  board: Int8Array;
  /** Its `valid_moves`, by their action. */
  mask: Uint8Array;
  /** The raw policy its network returned, by their action. */
  policy: Float32Array;
  /** The value it returned, `[me, them]`. */
  value: Float32Array;
}

function read(name: string): Buffer {
  return readFileSync(join(DIRECTORY, name));
}

export function manifest(): Manifest {
  return JSON.parse(readFileSync(join(DIRECTORY, 'manifest.json'), 'utf8')) as Manifest;
}

/** What `tools/export_weights.py` recorded of the checkpoint [A8-16]. */
export function weightsRecord(): {
  commit: string;
  checkpointSha256: string;
  omittedSuffix: string;
  count: number;
  versions: Record<string, string>;
  stateDict: { name: string; shape: number[]; dtype: string }[];
} {
  return JSON.parse(readFileSync(join(DIRECTORY, 'weights.json'), 'utf8'));
}

/** Every recorded position, with what the original held and returned. */
export function fixtures(): FixturePosition[] {
  const data = manifest();
  const boards = read(data.files['boards'].name);
  const nexts = read(data.files['next'].name);
  const masks = read(data.files['masks'].name);
  const policy = read(data.files['policy'].name);
  const value = read(data.files['value'].name);

  const byGame = new Map<string, AzulJSON[]>();
  const actionsOf = new Map<string, number[]>();
  for (const game of data.games) {
    const positions: AzulJSON[] = [];
    const s = newGame(game.seed);
    for (const action of game.actions) {
      positions.push(toJSON(s));
      apply(s, action);
    }
    if (!s.isTerminal) throw new Error(`fixture game ${game.id} did not replay to its end`);
    byGame.set(game.id, positions);
    actionsOf.set(game.id, game.actions);
  }

  return data.records.map((record, i) => {
    const positions = byGame.get(record.game);
    if (positions === undefined) throw new Error(`no such fixture game: ${record.game}`);
    const position = positions[record.ply];
    if (position === undefined) {
      throw new Error(`fixture game ${record.game} has no ply ${record.ply}`);
    }
    return {
      game: record.game,
      ply: record.ply,
      position,
      action: actionsOf.get(record.game)![record.ply],
      theirs: new Int8Array(nexts.buffer, nexts.byteOffset + i * 138, 138),
      theirNextPlayer: record.theirNextPlayer,
      board: new Int8Array(boards.buffer, boards.byteOffset + i * 138, 138),
      mask: new Uint8Array(masks.buffer, masks.byteOffset + i * 180, 180),
      policy: new Float32Array(policy.buffer.slice(policy.byteOffset + i * 720, policy.byteOffset + (i + 1) * 720)),
      value: new Float32Array(value.buffer.slice(value.byteOffset + i * 8, value.byteOffset + (i + 1) * 8)),
    };
  });
}
