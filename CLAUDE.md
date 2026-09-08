# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TypeScript implementation of the board game Azul, delivered in three roadmap steps:

1. **Engine** (`packages/engine`) — fast, deterministic 2-player Azul rules engine. **Done.**
2. **UI** (`packages/ui`) — web client using Solid.js **v2**. **Done.**
3. **Bot** (`packages/bot`) — AI agent that plays through the engine, in-browser. **Done:** the
   player (spec 0004), the arena (0005), and the interface seam (0006). The search runs in a
   worker; `packages/ui` reaches it only through `src/opponent.ts`.

The repo is a **pnpm monorepo**. Check what is actually on disk before assuming a package is
present.

Determinism matters: the only randomness is bag shuffling, which must be seedable so games replay
exactly.

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

## Reference implementation

The engine is a TypeScript port of [RemiFabre/ludometer](https://github.com/RemiFabre/ludometer)'s
`ludometer/azul/engine.py`. Treat it as the oracle for correctness; `spec/0001-engine-core.md` is
the authority on what was actually built.

ludometer ships **no recorded test vectors** — its `tests/test_engine.py` is hand-written tests plus
self-play fuzz runs. Our move-by-move fixtures were *generated* by driving that engine, per spec
0002; they are committed, so the suite needs neither network nor Python. Don't go looking upstream
for files that aren't there.

The bot will need the observation encoding — a fixed-length normalized float vector from the current
player's perspective (182 in ludometer). `packages/engine/src/observe.ts` has it; keep the layout
stable and documented.

## The UI, and Solid v2

`packages/ui` implements `spec/0003-web-interface.md`. Its organising rule is that **the interface
contains no rule**: everything about legality and scoring is asked of the engine. Two structures
exist to keep that true, and both are enforced by tests — don't route around them.

- `src/game.ts` is the only module that holds an `AzulState` or calls `apply`. The state is not
  exported. Components read the published, plain-data view model and nothing else.
- `test/source.test.ts` fails the build on a list of forbidden shapes in `src/` (a hard-coded wall
  table, the penalty ladder, `% 5`, the action multipliers, `apply` outside the state module).
  `test/property.test.tsx` plays whole games through the rendered DOM against a parallel engine,
  which is what catches a re-implemented rule that the matcher cannot see.

Solid **v2** differs from the widely-documented v1, and the differences cause silent bugs rather
than errors. All of these bit this codebase:

- Writes are **staged**: reading a signal straight after setting it returns the previous value.
  `flush()` commits. Never derive state from a signal you just wrote; tests must `flush()` before
  asserting on the DOM.
- `<For keyed={false}>` hands its callback an **accessor**. Unwrap it inside JSX, not in the
  callback body — a read outside a tracking scope freezes the value forever, and only a multi-ply
  test notices.
- `<Repeat count={n}>` is the idiom for fixed-position cells.
- Gone: `onMount` (use `onSettled`), `batch`, `classList` (use `class={['a', {b: cond}]}`),
  `Index`, `createMutable`. `createEffect` is two-phase: `createEffect(() => dep(), v => {…})`.
- The web runtime is `@solidjs/web`, and `jsxImportSource` points there. Stores come from `solid-js`.
- Enumerated ARIA attributes (`aria-disabled`, `aria-pressed`) take string literals, not booleans.

When this section and <https://v2.solidjs.com> disagree, the documentation is right and this is
stale.

## Commands

```bash
pnpm install
pnpm test                        # every package
pnpm typecheck

pnpm -F engine test              # the engine suite
pnpm -F engine test vectors      # the oracle replays only
pnpm -F engine bench             # the [E1-58] / [E1-59] budgets, non-gating

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
