/**
 * Display permutation ([Z11-65]): the layout the trainer permutes by, and the
 * fixture its permutation is checked against, both read from the engine.
 *
 * The trainer is Python and cannot import the engine, so [Z11-8]'s "only
 * through the offsets the engine exports" is kept by writing them to
 * `train/layout.json` from here, and by a test that the committed file still
 * says what the engine does.
 */

import {
  ACTION_SPACE,
  CENTER,
  ENCODED_SIZE,
  NUM_COLORS,
  NUM_FACTORIES,
  OFF_FACTORIES,
  OFF_FACTORY_FLAGS,
  applyExplained,
  clone,
  encode,
  encodeAction,
  legalActions,
  newGame,
  type AzulState,
} from 'engine';
import { join } from 'node:path';
import { TRAIN } from './paths.js';

export const LAYOUT = join(TRAIN, 'layout.json');
export const DISPLAYS_FIXTURE = join(TRAIN, 'tests', 'fixtures', 'displays.json');

export interface DisplayLayout {
  encodedSize: number;
  actionSpace: number;
  displays: number;
  colors: number;
  /** The first display's count of colour `c` is at `offFactories + c`. */
  offFactories: number;
  offFactoryFlags: number;
  /** The action `source` of the centre, which a permutation leaves alone. */
  center: number;
  /** How far apart two sources' actions are: `encodeAction(1, 0, 0) - encodeAction(0, 0, 0)`. */
  perSource: number;
}

export function displayLayout(): DisplayLayout {
  return {
    encodedSize: ENCODED_SIZE,
    actionSpace: ACTION_SPACE,
    displays: NUM_FACTORIES,
    colors: NUM_COLORS,
    offFactories: OFF_FACTORIES,
    offFactoryFlags: OFF_FACTORY_FLAGS,
    center: CENTER,
    perSource: encodeAction(1, 0, 0) - encodeAction(0, 0, 0),
  };
}

/** `s` with display `i` holding what display `perm[i]` held. */
export function permuteDisplays(s: AzulState, perm: readonly number[]): AzulState {
  const t = clone(s);
  t.factories = perm.map((j) => [...s.factories[j]]);
  return t;
}

export interface DisplayCase {
  seed: number;
  ply: number;
  perm: number[];
  obs: number[];
  legal: number[];
  permutedObs: number[];
  permutedLegal: number[];
}

/** A small deterministic generator, so the fixture is the same on every machine. */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/**
 * Positions from games of uniformly random legal moves, each with two to four
 * displays still holding tiles, beside the engine's own encoding and
 * legal moves of the same position with its displays permuted.
 */
export function displayFixture(cases = 16): DisplayCase[] {
  const out: DisplayCase[] = [];
  for (let seed = 1; out.length < cases; seed++) {
    const next = lcg(seed);
    const s = newGame(seed);
    // A different ply into the game for each seed, so rounds and fill levels vary.
    const target = 3 + ((seed * 7) % 40);
    for (let ply = 0; !s.isTerminal; ply++) {
      const flags = s.factories.map((f) => f.some((n) => n > 0));
      const full = flags.filter(Boolean).length;
      if (ply >= target && full >= 2 && full <= 4) {
        const perm = [0, 1, 2, 3, 4];
        // A permutation that moves which displays are empty, so a case tests
        // the flags as well as the counts; never the identity.
        while (perm.every((v, i) => flags[v] === flags[i])) {
          for (let i = perm.length - 1; i > 0; i--) {
            const j = Math.floor(next() * (i + 1));
            [perm[i], perm[j]] = [perm[j], perm[i]];
          }
        }
        const p = permuteDisplays(s, perm);
        out.push({
          seed,
          ply,
          perm,
          obs: [...encode(s)],
          legal: legalActions(s),
          permutedObs: [...encode(p)],
          permutedLegal: legalActions(p),
        });
        break;
      }
      const moves = legalActions(s);
      applyExplained(s, moves[Math.floor(next() * moves.length)]);
    }
  }
  return out;
}
