/**
 * The arena of *0005 — Opponent strength*: matches, reference opponents and
 * the blunder audit.
 *
 * Separate from `src/` because it measures the bot rather than being part of
 * it. Nothing under `src/` may import from here.
 */

export { greedy, tier, uniformRandom, type Chooser, type Play } from './chooser.js';
export {
  match,
  summarise,
  wilsonLowerBound,
  type MatchSpec,
  type Result,
  type Work,
} from './match.js';
export {
  audit,
  referenceValues,
  type AuditCorpus,
  type AuditPosition,
  type AuditReport,
  type Regret,
} from './audit.js';
export { GATING_SEEDS, RANDOM_CHOOSER_SEED, SMOKE_SEEDS, WIDE_SEEDS } from './seeds.js';
