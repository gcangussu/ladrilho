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
| `packages/engine` | planned | Azul rules engine + tests |
| `packages/ui` | planned | Solid.js v2 web client |
| `packages/bot` | planned | AI agent |

## Intent

Planned work is described in plain language under [`intent/`](intent/) — one file per idea,
written before the code exists. See [`intent/README.md`](intent/README.md) for the conventions.

## Development

```bash
pnpm install
pnpm test
```

This is an early-stage project; the sections above expand as each roadmap step lands.
