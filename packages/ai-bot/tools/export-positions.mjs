/**
 * The position corpus [A8-34]: whole games, played by **our** code, written
 * where the fixture generator can feed them to the original.
 *
 *   node tools/export-positions.mjs
 *
 * Positions flow from us to the original and never the other way. The original
 * deals randomly in real play, and differently from our engine, so its games
 * could not be replayed here; feeding it ours sidesteps that.
 *
 * A game is recorded as a seed and the actions played, not as a list of
 * positions: the engine replays it exactly ([0001 E1-46]), so the committed
 * fixtures carry a few hundred bytes per game instead of a megabyte, and the
 * suite rebuilds each position with the same constructor the search uses.
 *
 * The output is intermediate and not committed; `generate_fixtures.py` reads
 * it and writes what is.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const HERE = new URL('.', import.meta.url).pathname;
const WORK = `${HERE}.work`;
const BUNDLE = `${WORK}/corpus.mjs`;

mkdirSync(WORK, { recursive: true });
await build({
  entryPoints: [`${HERE}corpus-entry.mjs`],
  outfile: BUNDLE,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2025',
});
const { Rng, apply, legalActions, newGame, toJSON, chooseMove } = await import(BUNDLE);

/** Uniform over the legal actions, from a seeded stream. */
function uniformRandom(seed) {
  const rng = new Rng(seed);
  return (position) => position.legalActions[rng.below(position.legalActions.length)];
}

/** A tier of `bot`, at a budget that keeps a whole game to seconds. */
function tier(name, nodes) {
  return (position) => chooseMove(position, nodes === undefined ? { tier: name } : { tier: name, nodes }).action;
}

function chooser(spec) {
  const [kind, argument] = spec.split(':');
  if (kind === 'random') return uniformRandom(Number(argument));
  return tier(kind, argument === undefined ? undefined : Number(argument));
}

/**
 * Plays one game and records every ply.
 *
 * `bagBefore` is the bag's size at each refill, which is how [A8-51]'s two
 * deals are found: 0 is the ordinary recycle after a round that emptied the
 * bag, and a value that is neither 0 nor a multiple of 4 is the rare one,
 * where the bag runs short partway through a display.
 */
function playGame(id, seed, specs, sink) {
  const play = specs.map(chooser);
  const s = newGame(seed);
  const actions = [];
  const deals = [];
  let ply = 0;
  while (!s.isTerminal && ply < 400) {
    const position = toJSON(s);
    sink.push({ game: id, ply, position });
    const action = play[s.currentPlayer](position);
    if (!legalActions(s).includes(action)) throw new Error(`${id}: illegal action ${action}`);
    const bagBefore = s.bag.length;
    const round = s.roundIndex;
    apply(s, action);
    if (s.roundIndex !== round && !s.isTerminal) deals.push({ ply, bagBefore });
    actions.push(action);
    ply++;
  }
  if (!s.isTerminal) throw new Error(`${id}: unfinished after ${ply} plies`);
  return { id, seed, players: specs, actions, deals, plies: ply };
}

/** Does this game deal a display that runs short of the bag partway through? */
function hasShortDisplay(game) {
  return game.deals.some((d) => d.bagBefore > 0 && d.bagBefore < 20 && d.bagBefore % 4 !== 0);
}

/** Does this game deal a round that follows one leaving the bag at exactly 0? */
function hasEmptyBagDeal(game) {
  return game.deals.some((d) => d.bagBefore === 0);
}

const sink = [];
const games = [
  playGame('steady-easy', 20260911, ['steady', 'easy'], sink),
  playGame('sharp-steady', 20260912, ['sharp:20000', 'steady'], sink),
  playGame('easy-random', 20260913, ['easy', 'random:31337'], sink),
];

// Floor-heavy random play is what reaches [A8-51]'s rare deal, so random games
// are scanned until both conditions are covered rather than hoped for.
let scanned = 0;
while (
  scanned < 60 &&
  (games.filter((g) => g.id.startsWith('random')).length < 2 ||
    !games.some(hasShortDisplay) ||
    !games.some(hasEmptyBagDeal))
) {
  const seed = 19910101 + scanned * 104729;
  const candidate = [];
  const game = playGame(`random-${scanned}`, seed, [`random:${seed}`, `random:${seed + 1}`], candidate);
  scanned++;
  const wantedShort = !games.some(hasShortDisplay) && hasShortDisplay(game);
  const wantedEmpty = !games.some(hasEmptyBagDeal) && hasEmptyBagDeal(game);
  if (wantedShort || wantedEmpty || games.filter((g) => g.id.startsWith('random')).length < 2) {
    games.push(game);
    sink.push(...candidate);
  }
}

if (!games.some(hasShortDisplay)) {
  throw new Error('no game deals a display short of the bag; [A8-51] cannot be satisfied');
}
if (!games.some(hasEmptyBagDeal)) throw new Error('no game recycles a bag left at exactly 0');

const kept = new Set(games.map((g) => g.id));
const positions = sink.filter((record) => kept.has(record.game));
writeFileSync(`${WORK}/positions.json`, `${JSON.stringify({ games, positions })}\n`);
process.stderr.write(
  `${games.length} games, ${positions.length} plies, ${scanned} random games scanned\n` +
    games
      .map(
        (g) =>
          `  ${g.id}: ${g.plies} plies, deals ${g.deals.map((d) => d.bagBefore).join(',')}` +
          `${hasShortDisplay(g) ? ' [short display]' : ''}${hasEmptyBagDeal(g) ? ' [empty bag]' : ''}`,
      )
      .join('\n') +
    '\n',
);
