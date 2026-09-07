/**
 * An Azul move chooser. See `spec/0004-computer-opponent.md`; every exported
 * name here is pinned by a numbered requirement there.
 *
 * The package depends on `engine` and nothing else [B4-1], touches neither the
 * DOM, the network, storage nor the filesystem [B4-2], and holds no
 * module-level mutable state [B4-3] — so it runs unchanged in a worker, on the
 * main thread, and under Vitest in Node.
 *
 * It knows how to play Azul. It knows no rule of Azul that it did not ask the
 * engine for.
 */

export {
  BUDGETS,
  FAIL_SAFE_MS,
  TIERS,
  chooseMove,
  type Choice,
  type Options,
  type Tier,
} from './choose.js';
export { WIN, evaluate } from './evaluate.js';

/**
 * `search` is deliberately **not** exported [B4-5].
 *
 * It takes an `AzulState`, and a state carries the bag in order — the one
 * thing no player may see [0001 E1-52]. Exporting it would put a public door
 * in the barrier this package's design rests on: `chooseMove` cannot leak a
 * bag order because it was never handed one, and that argument only holds
 * while it is the only way in. The suite reaches `search` through
 * `../src/search.js` directly, which is a test reaching inside its own
 * package, not a caller.
 */
