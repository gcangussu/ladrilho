/**
 * Writes the audit corpus of [M5-21] and its reference values [M5-31].
 *
 *   node arena/generate-corpus.mjs
 *
 * Run deliberately, never by a test and never in a lane. Regenerating it is an
 * act with a commit message: the reference is **stale by design**, because one
 * regenerated alongside the bot measures the bot against itself and reports
 * every regression as a tie.
 *
 * Positions come from the last two rounds of recorded games [M5-21], which is
 * where the intent says blunders matter and where the boundary horizon of
 * [0004 B4-6] is least forgiving — the position past the boundary it declines
 * to look at may be the last one of the game.
 *
 * Runs against the bundled build for the reason `bench/bundle.mjs` gives: the
 * reference search is millions of nodes and the module runner would make this
 * a ten-minute job for no reason.
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const HERE = new URL('.', import.meta.url).pathname;
const BUNDLE = new URL('../node_modules/.bench/arena.js', import.meta.url).pathname;
const OUT = new URL('./audit-corpus.json', import.meta.url).pathname;

/** How deep the reference looks: ten times `sharp`'s shipped budget [M5-18]. */
const REFERENCE_NODES = 4_000_000;
/** Games to sample from. Each recorded position costs ~12 s of reference. */
const SEEDS = [20260906, 4242, 77, 11, 500, 31337];
/** How many rounds from the end to sample [M5-21]. */
const ROUNDS_FROM_END = 2;
/** Every Nth ply within those rounds, so the corpus is minutes not hours. */
const SAMPLE_EVERY = 4;

await build({
  entryPoints: [`${HERE}bundle-entry.mjs`],
  outfile: BUNDLE,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2025',
});

const { apply, legalActions, newGame, toJSON, referenceValues, tier } = await import(BUNDLE);

// A dirty `src/` makes the recorded hash a lie about what produced these
// values, which is the one thing [M5-31] asks the file to be honest about.
const head = execSync('git rev-parse HEAD', { cwd: HERE }).toString().trim();
const dirty = execSync('git status --porcelain -- ../src', { cwd: HERE }).toString().trim();
const botCommit = dirty === '' ? head : `${head}-dirty`;
const play = tier({ tier: 'sharp', nodes: 20_000 });

const positions = [];
for (const seed of SEEDS) {
  // Play the whole game once to learn how many rounds it lasts, then replay it
  // and keep the positions from the last two. Playing it twice is cheaper than
  // holding every position of every game.
  const measure = newGame(seed);
  while (!measure.isTerminal) apply(measure, play(toJSON(measure)).action);
  const lastRound = measure.roundIndex;

  const s = newGame(seed);
  let ply = 0;
  while (!s.isTerminal) {
    const roundsFromEnd = lastRound - s.roundIndex;
    if (roundsFromEnd < ROUNDS_FROM_END && ply % SAMPLE_EVERY === 0) {
      const position = JSON.parse(JSON.stringify(toJSON(s)));
      process.stderr.write(`seed ${seed} ply ${ply} (${position.legalActions.length} moves)\n`);
      positions.push({
        seed,
        ply,
        roundsFromEnd,
        position,
        ...referenceValues(position, REFERENCE_NODES),
      });
    }
    apply(s, play(toJSON(s)).action);
    ply++;
  }
}

writeFileSync(
  OUT,
  `${JSON.stringify({ botCommit, referenceNodes: REFERENCE_NODES, positions }, null, 2)}\n`,
);
process.stderr.write(`\nwrote ${positions.length} positions to ${OUT}\n`);
process.stderr.write(`reference: ${REFERENCE_NODES} nodes, bot commit ${botCommit}\n`);
