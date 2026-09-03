# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TypeScript implementation of the board game Azul, delivered in three roadmap steps:

1. **Engine** (`packages/engine`) — fast, deterministic 2-player Azul rules engine with a thorough test suite.
2. **UI** (`packages/ui`) — web client using Solid.js **v2** (note: v2 API differs from the widely-documented v1).
3. **Bot** (`packages/bot`) — AI agent that plays through the engine, in-browser.

The repo is a **pnpm monorepo**. Only the pieces described below exist yet; the rest is planned — check what is actually on disk before assuming a package is present.

## Intent and spec

- `intent/` — plain-language documents saying what we want and why, written before the code. Never technical; frozen once written.
- `spec/` — the technical counterparts: numbered, testable requirements (`[E1-14]`) you build from and cite in tests. Living documents; revised in place.

Before implementing a package, read its spec. When code and spec disagree, one of them is a bug — fix it, don't silently diverge. New requirement identifiers are append-only.

## Reference implementation

The engine is a TypeScript port of the Azul engine in [RemiFabre/ludometer](https://github.com/RemiFabre/ludometer) (`ludometer/azul/engine.py`, Python). Port the logic and, importantly, the **test vectors** — ludometer validates its engine by replaying ~30 seeded games plus ~5 handcrafted edge positions move-by-move, and checks tile conservation across full self-play games. Reuse that strategy.

Key shape of the ludometer engine to preserve:

- **State**: 5 factories (4 tiles each), center pool, bag, lid (discard); per-player 5×5 wall, 5 pattern lines, floor line; current player, first-player marker location, round index, scores.
- **Colors**: encoded 0–4.
- **Action encoding**: integer `source * 30 + color * 6 + destination`, where source is 0–4 (factories) or 5 (center), destination is 0–4 (pattern-line rows) or 5 (floor). 180 possible actions.
- **Core API**: legal-action generation (lookup-table / mask based), an `apply`/`step` that routes tiles and triggers round-end when the draw is exhausted, end-of-round wall-tiling + scoring + floor penalties, end-of-game bonuses (+2 per row, +7 per column, +10 per color).
- **Observation encoding**: a fixed-length normalized float vector (182 in ludometer) from the current player's perspective — needed by the bot. Keep it a stable, documented layout.

Determinism matters: the only randomness is bag shuffling, which must be seedable so games replay exactly.

## Commands

```bash
pnpm install
pnpm test          # all packages
pnpm -F engine test # single package (once packages exist)
```

Test runner: Vitest (planned). To run a single test file: `pnpm -F engine test <path>`; single test by name: add `-t "<name>"`.
