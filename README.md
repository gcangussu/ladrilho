# azul

A TypeScript implementation of the board game [Azul](https://en.wikipedia.org/wiki/Azul_(board_game)): a rules engine, a web UI, and an AI bot.

## Roadmap

1. **Engine** — a fast, deterministic 2-player Azul rules engine with a thorough test suite. Logic and test vectors are ported from [RemiFabre/ludometer](https://github.com/RemiFabre/ludometer)'s `ludometer/azul` engine.
2. **UI** — a web client built with [Solid.js](https://www.solidjs.com/) v2.
3. **AI bot** — an agent that plays via the engine, running in the browser alongside the UI.

## Structure

pnpm monorepo:

| Package | Status | Description |
| --- | --- | --- |
| `packages/engine` | done | Azul rules engine + conformance suite |
| `packages/ui` | done | Solid.js v2 hot-seat web client |
| `packages/bot` | planned | AI agent |

## Intent and spec

Planned work is described in plain language under [`intent/`](intent/) — one file per idea,
written before the code exists. See [`intent/README.md`](intent/README.md) for the conventions.

The technical counterparts live in [`spec/`](spec/): precise, numbered requirements you can build
from and test against, each linked to the intent it serves. See
[`spec/README.md`](spec/README.md).

## Development

```bash
pnpm install
pnpm test                        # every package
pnpm -F engine test              # the engine suite
pnpm -F engine test vectors      # the oracle replays only
pnpm -F engine bench             # the [E1-58] / [E1-59] budgets, non-gating
pnpm -F ui dev                   # the client, on a local dev server
pnpm -F ui test                  # the fast suite: jsdom, under 30s
pnpm -F ui test:browser          # the [U3-73] lane: layout and reload, in chromium
```

The engine's conformance fixtures are committed, so the suite needs neither network nor Python.
Regenerating them does — see [`tools/vectors/README.md`](tools/vectors/README.md).

The browser lane needs a browser: `pnpm -F ui exec playwright install chromium`, once.

The client is a two-player hot seat with no server, no accounts and no storage. A reload deals a
fresh game; `?seed=` in the URL reproduces a deal, not a position.
