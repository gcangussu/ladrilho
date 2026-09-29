# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TypeScript implementation of the board game Azul, delivered in three roadmap steps:

1. **Engine** (`packages/engine`) — fast, deterministic 2-player Azul rules engine. **Done.**
2. **UI** (`packages/ui`) — web client using Solid.js **v2**. **Done.**
3. **Bot** (`packages/bot`) — AI agent that plays through the engine, in-browser. **Done:** the
   player (spec 0004), the arena (0005), and the interface seam (0006). The search runs in a
   worker; `packages/ui` reaches it only through `src/opponent.ts`.

Since the three steps, three things have been added. The engine reports how it scored a round
(`applyExplained`, spec 0007) and the interface shows it; `apply` is untouched and is still what
the vectors and the bot drive. And a fourth package, **`packages/ai-bot`** (spec 0008), ports a
published AlphaZero-style player — network, search, and the deal it guesses — onto our engine as
the `expert` difficulty. It sits beside `bot` rather than inside it: `bot` is code we can read and
explain, and that is worth keeping separate from weights we cannot. `packages/ui` offers the
setting only while the committed `packages/ai-bot/gate/baseline.json` says `passed: true`, and
**today it does not**: the gate (`pnpm -F ai-bot gate`) first passed at 72% of 200 games against
`sharp`, but that `sharp` had a root tie-break bug ([0004 B4-30]); against the fixed `sharp` the
expert wins 45% and is withdrawn. Anything that changes `sharp`'s play — its search, evaluation
or budget — moves the expert's gate too, so rerun it and commit the result either way ([A8-32]).

Two things about `ai-bot` cost real time if discovered late. Its fixtures are recorded from the
original Python program by `pnpm -F ai-bot fixtures`, which needs `uv` and pinned wheels — and its
generator asserts, as it records, that it captured the non-`fastmath` build, because numba can
leak `fastmath` across compilations in one process while its cache is cold. And the exactness of
[0008 A8-38] rests on arithmetic order: the search reproduces NumPy 2's float32 `Qs` rounding by
rounding after every step, and `src/exp.ts` is a hand-written fdlibm `exp` because `Math.exp` may
differ in the last bit between browsers.

A fifth package, **`packages/engine-rs`** (spec 0009), is a second implementation of the engine
in Rust: a synchronous library crate, no async anywhere, held to the same conformance vectors,
which it reads in place from `packages/engine/test/vectors`. It is not a replacement and nothing
drives it yet; it exists to be fast and to be a second opinion. It classifies every requirement of
0001, 0002 and 0007 in 0009's *Adopted requirements* table, and its build fails until a
requirement added to any of them is classified there — so a rule change is a change to both
engines. Its throughput gate is the committed `packages/engine-rs/bench/baseline.json` (8.1× the
TypeScript engine when it was written); rerun `pnpm -F engine-rs compare` on a quiet machine,
because a busy one slows the TypeScript runs and flatters the ratio.

A sixth package, **`packages/crosscheck`** (spec 0010), plays invented games through both engines
with the same bag orders and moves and stops at the first ply where they disagree about anything —
board, legal moves, score, the round's record, the observation vector. The TypeScript engine runs
in-process; the crate runs in `checker/`, a dependency-free Rust binary that replays each game and
answers in a fixed word layout. A disagreement is written as a report that replays without a seed.
When one is found, the rules decide, not either engine and not the Python oracle: the order of
authority, the register of rulings, and how a ruling becomes a permanent `found-NN` vector —
recorded from the oracle, *corrected in the open* where the oracle is wrong — are all in 0010. The
pinned rulebook is Next Move's English web PDF, identified by its SHA-256 in [0010 C10-26].

A seventh, **`packages/alphazero-bot`** (spec 0011), is a player we train ourselves, from scratch,
by self-play on the Rust engine. It is three languages, each where it is strongest: a Rust crate,
`azul_alphazero`, holds the network's forward pass, the search and self-play; a Python trainer
under `train/` (PyTorch 2.2.2 and NumPy 1.26, pinned for this x86_64 Mac, CPU only) trains on the
samples the crate writes and exports weights; and TypeScript lanes under `eval/` measure each
milestone against `bot`'s ladder, apply the stop rule and run the gate against `sharp`. Nothing is
taken from `ai-bot`, and a source check says so. The player itself is written on the engine alone;
general-purpose plumbing (JSON, hashing, the random generator, arguments) comes from the crates
[0011 Z11-2] lists, and adding one is a spec change. The search stops at the round boundary and
values it on a *pre-deal view*, so no dealt tile is ever read ([0011 Z11-15], [Z11-21]). Two things
cost time if forgotten. Every checkpoint loads only beside a parity file of PyTorch's own outputs,
checked on every load ([Z11-13]); a checkpoint without one is not a checkpoint. And the loop
writes, but never commits: `milestones/log.json`, the milestone checkpoints, `gate/` and `latency/`
are for a person to commit, while `runs/` is git-ignored scratch. Like `ai-bot`'s gate, its
milestones and gate play `sharp`, so a change to `sharp`'s play starts every run's comparison
afresh ([Z11-63]). Nothing offers it in the interface yet.

The repo is a **pnpm monorepo** of the seven packages above. `pnpm test` and `pnpm typecheck` run
`cargo` for `engine-rs`, for the cross-check's checker and for `azul_alphazero`, so a Rust
toolchain is a prerequisite; `rust-toolchain.toml` pins it, and the checker's and
`alphazero-bot`'s copies must stay byte-identical to the engine's.

Determinism matters: the only randomness is bag shuffling, which must be seedable so games replay
exactly.

## When a change adds a caller

Two user-visible bugs shipped into review here, and neither was in the new code. Both were in the
*interaction* between new code and an old requirement: [0003 U3-42] published one view model per
ply until something else started publishing too, and [0003 U3-7]'s one-request guard held because
nothing had ever asked twice. Both were invisible to a suite of 142 tests, because every existing
test of the old requirement predated the new caller — `transition` was only ever exercised hot-seat,
and nothing provoked the race.

So: **when a change adds a caller to an existing seam, the existing seam's own tests need a case in
the new configuration.** That is a question to ask of a diff, not a habit to remember.

The related one, learned the same way: a test that claims to catch something specific is worth
nothing until it has been seen to fail. Three tests here asserted nothing and all three had been
reasoned about correctly in prose — a horizon check that passed with the horizon deleted, an
anytime check that passed under the bug it named, a sign check standing on the one position where
its subject is invisible. Mutate the code, watch the test fail, then keep it.

## Mutation testing

**Mutation** here means deliberately breaking the source for a moment — flipping a sign, deleting
a clamp, adding a bonus twice — to watch one specific test go red, then restoring it. It has
nothing to do with the in-place state mutation `packages/engine` talks about everywhere else.

It is how "a test that claims to catch something specific is worth nothing until it has been seen
to fail" is actually carried out, and three rules separate evidence from theatre:

- **Confirm the mutation landed.** If the anchor you edit no longer matches — a refactor
  reindented it, the code moved to another function — nothing breaks, the suite stays green, and
  you read that as "my check misses this" when in truth you never broke anything. Assert the anchor
  matched *before* writing the file.
- **Mutate a copy, not the tree.** `git archive HEAD` into a scratch directory. `git checkout --`
  compares against the index, so a mutation that reached the index reverts to itself and reports a
  clean tree; that is how one got committed here, in a commit whose message said it only touched a
  stylesheet.
- **Re-run a recorded mutation when the code it names moves.** [0007 S7-31] keeps mutation records
  beside the assertions they justify, naming a function and a line. A record pointing at code that
  has since moved is worse than no record: the next person finds nothing to mutate and concludes
  the table was fiction.

And the rule the mutations kept proving: **a check whose description outruns its behaviour is the
defect, not the gap it misses.** [0001 E1-71] shipped claiming it would fail on a second
implementation of the fusion rule "anywhere in `packages/engine/src`", and review defeated it three
times running. What fixed it was not the fourth clause but the sentence — it now claims only the
forms it plausibly catches, and requires every clause to carry the sources it rejects as fixtures,
so coverage is legible rather than asserted. Read that twice about any requirement saying what a
test MUST fail on.

## Intent and spec

- `intent/` — plain-language documents saying what we want and why, written before the code. Never
  technical; frozen once written.
- `spec/` — the technical counterparts: numbered, testable requirements (`[E1-14]`, `[U3-42]`) you
  build from and cite in tests. Living documents; revised in place.

Before implementing a package, read its spec. When code and spec disagree, one of them is a bug —
fix it, don't silently diverge. New requirement identifiers are append-only.

Each package's suite enforces this itself: a requirement must be cited by a test, by identifier, or
listed with a reason in its spec's *Traceability exemptions* table, or the build fails. See
`packages/*/test/traceability.test.ts`.

## The engine/bot seam

`packages/engine/src/observe.ts` exports the observation encoding — a fixed-length normalized float
vector from the current player's perspective, which `packages/engine-rs` reproduces bit for bit.
`alphazero-bot` consumes it: the Rust engine's `encode()` is its network's input, unmodified but
for the pre-deal view ([0011 Z11-8], [Z11-9]). (`bot` does not use it, and `ai-bot` encodes its
own board in `src/board.ts`.) So a change to the layout now invalidates trained models that
exist: keep it stable and documented, and treat [0001 E1-57] as meaning it.

## Commands

```bash
pnpm install
pnpm test                        # every package
pnpm typecheck

pnpm -F engine test              # the engine suite
pnpm -F engine test vectors      # the oracle replays only
pnpm -F engine bench             # the [E1-58] / [E1-59] budgets, non-gating

pnpm -F ai-bot test              # the expert: board, network, search, sessions, the gate result
pnpm -F ai-bot gate              # the [A8-30] lane: 400 games, ~50 minutes. Only a full run
                                 # writes gate/baseline.json; `gate 8` prints and leaves it alone
pnpm -F ai-bot fixtures          # re-record from the original; needs uv. A deliberate act
pnpm -F ai-bot weights           # regenerate src/weights.ts from the checkpoint. Likewise

pnpm -F engine-rs test           # the Rust engine: vectors, rules, record, allocation, traceability
pnpm -F engine-rs typecheck      # clippy, warnings as errors
pnpm -F engine-rs bench          # the [R9-18] figures, non-gating
pnpm -F engine-rs compare        # the [R9-19] gate run against the TypeScript engine: minutes.
                                 # Writes bench/baseline.json; run it with the machine idle

pnpm -F crosscheck test          # the cross-check: record, checker, the everyday run, mutations
pnpm -F crosscheck check --games 100000 --seed 7   # the long run, on purpose: [C10-20]
pnpm -F crosscheck check --steer floor --cap 600   # steering: mix, floor, prefer-lines, …
pnpm -F crosscheck check --start short:40          # short census: reaches an empty bag and lid
pnpm -F crosscheck replay <report.json>            # [C10-24]: exit 0 means it no longer reproduces

pnpm -F alphazero-bot test       # the crate (search, network, self-play, formats) and the lanes
pnpm -F alphazero-bot test:train # the trainer's pytest suite; needs uv. Not in the root suite
pnpm -F alphazero-bot train init --run <name>  # [Z11-58]: checkpoint 0 and the config
pnpm -F alphazero-bot latency --run <name>     # [Z11-57]: sets playSimulations; idle machine, hours
pnpm -F alphazero-bot throughput --run <name>  # [Z11-53]: minutes per generation
pnpm -F alphazero-bot train --run <name>       # [Z11-28]: the loop, over days; resumes where it stopped
pnpm -F alphazero-bot milestone <checkpoint>   # [Z11-31] on one logged milestone, printed
pnpm -F alphazero-bot gate <checkpoint>        # [Z11-35]: hours; writes gate/<run>/<generation>.json
pnpm -F alphazero-bot stop-simulation          # [Z11-56]: the stop rule's table
pnpm -F alphazero-bot latency-corpus           # [Z11-38]: re-record latency/corpus.bin; deliberate act

pnpm -F bot test                 # the move chooser: evaluation, search, tiers
pnpm -F bot bench                # the [B4-47]..[B4-50] budgets, non-gating, bundled
pnpm -F bot ladder               # the [M5-13] / [M5-19] gates: minutes, bundled
pnpm -F bot corpus               # regenerate the audit corpus [M5-31]; deliberate act

pnpm -F ui dev                   # the client, on a local dev server
pnpm -F ui test                  # the fast suite: jsdom, budgeted at 30s
pnpm -F ui test:browser          # the [U3-73] lane: layout and reload, in chromium
```

Test runner: Vitest 5, one version across the monorepo. Single file:
`pnpm -F <pkg> test <path>`; single test by name: add `-t "<name>"`.

The browser lane needs `pnpm -F ui exec playwright install chromium`, once.
