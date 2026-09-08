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

The bot will need the observation encoding — a fixed-length normalized float vector from the current
player's perspective. `packages/engine/src/observe.ts` has it; keep the layout
stable and documented.

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
