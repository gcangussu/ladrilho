/**
 * The gate [A8-30], [A8-31], [A8-32]:
 *
 *   pnpm -F ai-bot gate            every seed of the wide list
 *   pnpm -F ai-bot gate -- 8       the first 8, for a smoke run
 *
 * Intent 0006 says the expert ships only if it wins clearly more often than
 * our hardest setting — "at least 10% more likely to win: 60 or more games in
 * every 100". This lane is what answers that, and its answer is committed
 * whether it passes or fails, because the intent asks that a copy which does
 * not clear the bar be written down.
 *
 * One `match` from the arena per game, unchanged: a single-seed match seats
 * `a` first, so putting `expert` on `a` for even-indexed seeds and on `b` for
 * odd ones alternates its seat across the list ([0005 M5-3]). The bookkeeping
 * that spans games is done here — one loop and a formula imported from the
 * arena — rather than by teaching `match` about a new kind of entrant, which
 * would change every gate that already runs through it.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { build } from 'esbuild';

const HERE = new URL('.', import.meta.url).pathname;
const PACKAGE = new URL('..', import.meta.url).pathname;
const BUNDLE = `${PACKAGE}node_modules/.bench/gate.mjs`;

/** Intent 0006's bar, and [A8-31]'s test. */
const THRESHOLD = 0.6;
/** `sharp` plays at its shipped budget, with the fail-safe out of reach [0005 M5-8]. */
const SHARP = { tier: 'sharp', milliseconds: 60 * 60 * 1000 };

await build({
  entryPoints: [`${HERE}entry.mjs`],
  outfile: BUNDLE,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2025',
});
const { match, wilsonLowerBound, tier, WIDE_SEEDS, createExpert } = await import(BUNDLE);

/**
 * `expert` as a chooser over a session built for this game alone [A8-30].
 *
 * Its work is reported as `nodes = simulations`, `depth = 0`, and neither
 * complete nor curtailed: the search is not depth-bounded and is never
 * curtailed, because this package has no clock to curtail it with [A8-2].
 */
function expert() {
  const session = createExpert();
  return (position) => {
    const choice = session.choose(position);
    return { action: choice.action, nodes: choice.simulations, curtailed: false, depth: 0, complete: false };
  };
}

/** One game per seed, `first` on seat 0 and `second` on seat 1. */
function playSeries(label, first, second, seeds) {
  let successes = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let plies = 0;
  const seats = [0, 0];
  const seatPoints = [0, 0];
  const totals = [0, 0];
  const lostSeeds = [];
  const started = Date.now();

  for (const [index, seed] of seeds.entries()) {
    // Even seeds: the subject is `a`, which a single-seed match seats first.
    // Odd seeds: it is `b`, and so plays seat 1.
    const subjectFirst = index % 2 === 0;
    const result = match({
      a: subjectFirst ? first() : second(),
      b: subjectFirst ? second() : first(),
      seeds: [seed],
    });
    const points = subjectFirst ? result.winrate : 1 - result.winrate;
    const seat = subjectFirst ? 0 : 1;
    successes += points;
    if (points === 1) wins++;
    else if (points === 0) {
      losses++;
      lostSeeds.push(seed);
    } else draws++;
    seats[seat]++;
    seatPoints[seat] += points;
    totals[0] += subjectFirst ? result.meanScore[0] : result.meanScore[1];
    totals[1] += subjectFirst ? result.meanScore[1] : result.meanScore[0];
    plies += result.plies;

    const done = index + 1;
    process.stderr.write(
      `${label} ${done}/${seeds.length} seed ${seed}: ${points === 1 ? 'win' : points === 0 ? 'loss' : 'draw'}` +
        ` — running ${(100 * (successes / done)).toFixed(1)}%` +
        ` (${((Date.now() - started) / 1000 / done).toFixed(1)}s/game)\n`,
    );
  }

  const games = seeds.length;
  return {
    games,
    wins,
    losses,
    draws,
    winrate: successes / games,
    lowerBound: wilsonLowerBound(successes, games),
    bySeat: [
      seats[0] === 0 ? 0 : seatPoints[0] / seats[0],
      seats[1] === 0 ? 0 : seatPoints[1] / seats[1],
    ],
    seats,
    meanScore: [totals[0] / games, totals[1] / games],
    plies,
    lostSeeds,
    seconds: (Date.now() - started) / 1000,
  };
}

const limit = Number(process.argv[2] ?? WIDE_SEEDS.length);
const seeds = WIDE_SEEDS.slice(0, limit);
process.stderr.write(`gate: ${seeds.length} games against sharp, then ${seeds.length} of the null\n`);

const against = playSeries('expert vs sharp', expert, () => tier(SHARP), seeds);
// The null [A8-31]: two identical players over the same seeds, played the same
// way. Two players that are the same can still split far from even on seat
// advantage alone, and a threshold the null already clears gates nothing.
const nullSeries = playSeries('expert vs expert', expert, expert, seeds);

const passed = against.winrate >= THRESHOLD && nullSeries.winrate < THRESHOLD;
const manifest = JSON.parse(readFileSync(`${PACKAGE}test/fixtures/manifest.json`, 'utf8'));
const head = execSync('git rev-parse HEAD', { cwd: PACKAGE }).toString().trim();
const dirty = execSync('git status --porcelain -- src gate', { cwd: PACKAGE }).toString().trim();

const baseline = {
  winrate: against.winrate,
  lowerBound: against.lowerBound,
  bySeat: against.bySeat,
  nullWinrate: nullSeries.winrate,
  threshold: THRESHOLD,
  passed,
  games: against.games,
  wins: against.wins,
  losses: against.losses,
  draws: against.draws,
  meanScore: against.meanScore,
  lostSeeds: against.lostSeeds,
  nullBySeat: nullSeries.bySeat,
  nullLowerBound: nullSeries.lowerBound,
  seeds: [...seeds],
  sharp: SHARP,
  simulations: 100,
  commit: dirty === '' ? head : `${head}-dirty`,
  checkpointSha256: manifest.checkpoint.sha256,
  upstreamCommit: manifest.upstream.commit,
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 1e9),
    node: process.version,
  },
  seconds: Math.round(against.seconds + nullSeries.seconds),
};
baseline.digest = createHash('sha256')
  .update(JSON.stringify([baseline.winrate, baseline.nullWinrate, baseline.seeds]))
  .digest('hex')
  .slice(0, 16);

mkdirSync(`${PACKAGE}gate`, { recursive: true });
writeFileSync(`${PACKAGE}gate/baseline.json`, `${JSON.stringify(baseline, null, 2)}\n`);

const pct = (n) => `${(100 * n).toFixed(1)}%`;
process.stdout.write(
  `\nexpert vs sharp: ${pct(against.winrate)} over ${against.games} games ` +
    `(lower bound ${pct(against.lowerBound)}), seat 0 ${pct(against.bySeat[0])} / seat 1 ${pct(against.bySeat[1])}\n` +
    `scores ${against.meanScore[0].toFixed(1)}–${against.meanScore[1].toFixed(1)}\n` +
    `null (expert vs expert): ${pct(nullSeries.winrate)}, seat 0 ${pct(nullSeries.bySeat[0])} / seat 1 ${pct(nullSeries.bySeat[1])}\n` +
    `threshold ${pct(THRESHOLD)}: ${passed ? 'PASSED' : 'FAILED'}\n` +
    `written to gate/baseline.json\n`,
);
