/**
 * The simulation behind [Z11-33]'s table ([Z11-56]), calling `due` and
 * `decide` themselves rather than a copy of the rule.
 *
 * The model: 100 games a rung; `uniformRandom` and `greedy` at 1.0 and
 * `steady` at 0.95; the player at `playSimulations` 0.05 stronger against
 * `sharp` than at `milestoneSimulations`; the gate 200 games, passing at
 * 0.60, its null and latency left out. A climbing run starts at 0.30 against
 * `sharp` at the milestone count and is followed until it reaches 0.60 there.
 *
 * Beside it, [Z11-90]'s patience rows and [0012 T12-34]'s ship match.
 *
 *   pnpm -F alphazero-bot stop-simulation
 */

import { ELO_SCALE } from './elo.js';
import {
  GATE_THRESHOLD,
  decide,
  due,
  measureOf,
  progress,
  type GateOutcome,
  type LogEntry,
  type MilestoneEntry,
  type MilestoneResults,
} from './decision.js';
import { SHIP_TEST, verdict, type Pentanomial, type ShipTest } from './ship.js';

/** `mulberry32`: seeded, so the table reproduces. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function binomial(random: () => number, n: number, p: number): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (random() < p) k++;
  return k;
}

export interface Scenario {
  /** `sharp`'s true winrate at the milestone count, at milestone `m`. */
  sharp: (m: number) => number;
  milestones: number;
}

export interface Outcome {
  stop: number;
  done: number;
  meanGates: number;
}

/** One scenario over `runs` simulated runs. */
export function simulate(s: Scenario, runs: number, seed = 20260929): Outcome {
  const random = generator(seed);
  let stops = 0;
  let dones = 0;
  let gates = 0;
  for (let r = 0; r < runs; r++) {
    const entries: LogEntry[] = [];
    for (let m = 0; m < s.milestones; m++) {
      const p = s.sharp(m);
      const results: MilestoneResults = {
        rungs: {
          uniformRandom: { winrate: 1 },
          greedy: { winrate: 1 },
          steady: { winrate: binomial(random, 100, 0.95) / 100 },
          sharp: { winrate: binomial(random, 100, p) / 100 },
        },
        ladderHash: 'model',
      };
      const isDue = due(entries, results);
      let gate: GateOutcome | null = null;
      if (isDue) {
        gates++;
        const w = binomial(random, 200, Math.min(1, p + 0.05)) / 200;
        gate = { passed: w >= GATE_THRESHOLD, winrate: w, nullWinrate: 0.5, latencyPassed: true, path: '' };
      }
      const decision = decide(entries, results, gate);
      const entry: MilestoneEntry = {
        kind: 'milestone',
        run: 'model',
        date: '',
        generation: m,
        results: results.rungs,
        ladderHash: results.ladderHash,
        progress: progress(results.rungs),
        previousProgress: null,
        freshStart: { fresh: false, why: null },
        gate: { due: isDue, ran: gate !== null, outcome: gate },
        decision,
        reason: '',
      };
      entries.push(entry);
      if (decision === 'done') {
        dones++;
        break;
      }
      if (decision === 'stop') {
        stops++;
        break;
      }
    }
  }
  return { stop: stops / runs, done: dones / runs, meanGates: gates / runs };
}

const climb = (step: number) => (m: number) => Math.min(0.6, 0.3 + step * m);
const flat = (p: number) => () => p;

/** [Z11-33]'s rows; a row with two lengths reports both, as `a / b`. */
export const ROWS: readonly { label: string; scenarios: Scenario[] }[] = [
  { label: 'climbs 0.05 a milestone, 7 milestones', scenarios: [{ sharp: climb(0.05), milestones: 7 }] },
  { label: 'climbs 0.03 a milestone, 11 milestones', scenarios: [{ sharp: climb(0.03), milestones: 11 }] },
  { label: 'climbs 0.02 a milestone, 16 milestones', scenarios: [{ sharp: climb(0.02), milestones: 16 }] },
  {
    label: 'flat at 0.45 (0.50 shipped), 5 / 10 milestones',
    scenarios: [{ sharp: flat(0.45), milestones: 5 }, { sharp: flat(0.45), milestones: 10 }],
  },
  {
    label: 'flat at 0.55 (0.60 shipped), 5 / 10 milestones',
    scenarios: [{ sharp: flat(0.55), milestones: 5 }, { sharp: flat(0.55), milestones: 10 }],
  },
];

/** The table, in the spec's own form. */
export function table(runs: number): string {
  const lines = ['| `sharp` at the milestone count | P(`stop`) | P(`done`) | mean gates run |', '| --- | --- | --- | --- |'];
  const p = (x: number): string => x.toFixed(2);
  for (const row of ROWS) {
    const o = row.scenarios.map((s) => simulate(s, runs));
    const col = (f: (x: Outcome) => string): string => o.map(f).join(' / ');
    lines.push(`| ${row.label} | ${col((x) => p(x.stop))} | ${col((x) => p(x.done))} | ${col((x) => x.meanGates.toFixed(1))} |`);
  }
  return lines.join('\n');
}

/**
 * [Z11-73]'s rows: the same rule on a pool rating. A milestone's rating is
 * its true rating plus normal noise of the standard error a challenger gets
 * from `gamesPerMember` games against each of three champions of about its
 * strength — `2 · ELO_SCALE / √(3 · gamesPerMember)` — and the true rating
 * climbs a fixed number of points a milestone.
 */
export function simulatePool(
  climbPerMilestone: number,
  milestones: number,
  gamesPerMember: number,
  runs: number,
  seed = 20261001,
  patience?: number,
): { stop: number; se: number } {
  const random = generator(seed);
  const se = (2 * ELO_SCALE) / Math.sqrt(3 * gamesPerMember);
  const normal = (): number => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  let stops = 0;
  for (let r = 0; r < runs; r++) {
    const entries: LogEntry[] = [];
    for (let m = 0; m < milestones; m++) {
      const results: MilestoneResults = { rating: climbPerMilestone * m + se * normal(), ladderHash: 'model' };
      const decision = decide(entries, results, null, patience);
      entries.push({
        kind: 'milestone',
        run: 'model',
        date: '',
        generation: m,
        results: {},
        ladderHash: 'model',
        progress: measureOf(results),
        previousProgress: null,
        freshStart: { fresh: false, why: null },
        gate: { due: false, ran: false, outcome: null },
        decision,
        reason: '',
      });
      if (decision === 'stop') {
        stops++;
        break;
      }
    }
  }
  return { stop: stops / runs, se };
}

/**
 * [Z11-90]'s rows: the patience rule on the anchors' rating, whose standard
 * error at `gamesPerMember` games against each of three anchors is the
 * pool's model's. P(`stop`) within 10, 20 and 40 milestones, flat and
 * climbing. None stops sooner than `patience + 1` milestones: the first is a
 * fresh start, and so the first best.
 *
 * With a milestone every `every` generations ([Z11-102]) other than 10, the
 * same climbs and horizons are counted in generations: a climb of `step` Elo
 * every 10 generations is `step · every / 10` a milestone, and 100, 200 and
 * 400 generations are `1000 / every` milestones and so on. At 10 it prints
 * [Z11-90]'s table as it stands.
 */
export function patienceTable(runs: number, gamesPerMember: number, patience: number, every = 10): string {
  const se = simulatePool(0, 1, gamesPerMember, 1).se;
  const tens = every === 10;
  const lines = [
    tens
      ? `| rating per milestone (σ ≈ ${se.toFixed(1)} Elo, ${gamesPerMember} games an anchor), patience ${patience} | P(\`stop\`) within 10 / 20 / 40 milestones |`
      : `| rating per milestone (σ ≈ ${se.toFixed(1)} Elo, ${gamesPerMember} games an anchor), patience ${patience}, a milestone every ${every} generations | P(\`stop\`) within 100 / 200 / 400 generations |`,
    '| --- | --- |',
  ];
  for (const step of [0, 2, 3, 5, 10, 20]) {
    const at = (n: number): string =>
      simulatePool((step * every) / 10, Math.floor((n * 10) / every), gamesPerMember, runs, 20261026, patience).stop.toFixed(2);
    const label = step === 0 ? 'flat' : tens ? `climbs ${step} Elo` : `climbs ${step} Elo every 10 generations`;
    lines.push(`| ${label} | ${at(10)} / ${at(20)} / ${at(40)} |`);
  }
  return lines.join('\n');
}

/** The pool's rows, in the spec's own form: P(`stop`) within 5 and within 10 milestones. */
export function poolTable(runs: number, gamesPerMember: number): string {
  const se = simulatePool(0, 1, gamesPerMember, 1).se;
  const lines = [
    `| rating per milestone (σ ≈ ${se.toFixed(1)} Elo, ${gamesPerMember} games a champion) | P(\`stop\`) within 5 / 10 milestones |`,
    '| --- | --- |',
  ];
  for (const step of [0, 5, 10, 20, 40]) {
    const five = simulatePool(step, 5, gamesPerMember, runs).stop.toFixed(2);
    const ten = simulatePool(step, 10, gamesPerMember, runs).stop.toFixed(2);
    lines.push(`| ${step === 0 ? 'flat' : `climbs ${step} Elo`} | ${five} / ${ten} |`);
  }
  return lines.join('\n');
}

/**
 * [0012 T12-34]'s rows: the ship match on a modelled pair of players, calling
 * `verdict` itself. The candidate's expected score is the logistic of its true
 * edge; each pair's first game, the candidate on the first seat, is won with
 * that score plus [SEAT_EDGE] and the second with it minus, so a pair carries
 * the first seat's advantage as a real pair does. No draws. One look every
 * `batchPairs` pairs, until the verdict is not `continue`.
 */
export const SEAT_EDGE = 0.084;

export function simulateShip(edge: number, runs: number, seed = 20261026, test: ShipTest = SHIP_TEST): { ships: number; meanGames: number; p90Games: number } {
  const random = generator(seed);
  const p = 1 / (1 + 10 ** (-edge / 400));
  const clamp = (x: number): number => Math.min(1, Math.max(0, x));
  let ships = 0;
  const games: number[] = [];
  for (let r = 0; r < runs; r++) {
    const counts: Pentanomial = [0, 0, 0, 0, 0];
    const looks: Pentanomial[] = [];
    while (verdict(looks, test) === 'continue') {
      for (let k = 0; k < test.batchPairs; k++) {
        const first = random() < clamp(p + SEAT_EDGE) ? 1 : 0;
        const second = random() < clamp(p - SEAT_EDGE) ? 1 : 0;
        counts[2 * (first + second)]++;
      }
      looks.push([...counts] as Pentanomial);
    }
    if (verdict(looks, test) === 'accept') ships++;
    games.push(2 * counts.reduce((a, b) => a + b, 0));
  }
  games.sort((a, b) => a - b);
  return { ships: ships / runs, meanGames: games.reduce((a, b) => a + b, 0) / runs, p90Games: games[Math.floor(0.9 * runs)] };
}

/** The ship match's rows, in the spec's own form. */
export function shipTable(runs: number): string {
  const lines = [
    `| True edge over \`master\` (first seat +${(100 * SEAT_EDGE).toFixed(1)} points, ${runs} matches a row) | Ships | Mean games | 90th percentile games |`,
    '| --- | --- | --- | --- |',
  ];
  for (const edge of [-15, 0, 7, 15, 25, 40]) {
    const s = simulateShip(edge, runs);
    lines.push(`| ${edge > 0 ? '+' : ''}${edge} Elo | ${s.ships.toFixed(2)} | ${Math.round(s.meanGames)} | ${s.p90Games} |`);
  }
  return lines.join('\n');
}
