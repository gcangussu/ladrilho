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
| `packages/ui` | done | Solid.js v2 client, hot seat or against the bot |
| `packages/bot` | done | The opponent: evaluation, search, three tiers, and the arena that measures it |

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
pnpm typecheck

pnpm -F engine test              # the engine suite
pnpm -F engine test vectors      # the oracle replays only
pnpm -F engine bench             # the [E1-58] / [E1-59] budgets, non-gating

pnpm -F ui dev                   # the client, on a local dev server
pnpm -F ui test                  # the fast suite: jsdom, under 30s
pnpm -F ui test:browser          # the [U3-73] lane: layout, reload and the real worker, in chromium
```

The engine's conformance fixtures are committed, so the suite needs neither network nor Python.
Regenerating them does — see [`tools/vectors/README.md`](tools/vectors/README.md).

The browser lane needs a browser: `pnpm -F ui exec playwright install chromium`, once.

## Playing it

`pnpm -F ui dev`, then choose who sits where. There is no server, no account and no storage; a
reload deals a fresh game. The URL reproduces one: `?seed=42&seating=human-sharp` pins both the
deal and the opponent, and because the bot is deterministic that replays its play too.

## The bot

Four commands, and they differ in what they cost and what they are allowed to claim.

```bash
pnpm -F bot test                 # the fast suite: seconds, gates the build
pnpm -F bot bench                # per-move budgets [B4-47]..[B4-50]; non-gating
pnpm -F bot ladder               # the strength gates [M5-13] / [M5-19]; ~2½ minutes
pnpm -F bot corpus               # regenerate the audit corpus; a deliberate act
node packages/bot/ladder/wide.mjs > packages/bot/arena/baseline.json   # hours
```

**`test`** is the ordinary suite and the only one that runs on save. It covers the search,
the tiers and the arena harness, all at small node budgets — it says nothing about how *strong*
the opponent is, because a winrate needs hundreds of games.

**`bench`** and **`ladder`** both run against an esbuild bundle rather than the sources, and that
is not an optimisation. Through Vitest's module runner every cross-package import is a getter call,
and the bot crosses into the engine on every node it expands, so measured through the runner the
search reads about a tenth of its real throughput. Bundled it is ~319k nodes/sec; `sharp` at its
400 000-node budget is about 1.2 seconds a move. `pnpm -F ui dev` serves unbundled modules and will
also look slow — that is the tooling, not the bot.

**`ladder`** is the gating lane for strength. Each match is played against its **null** — the same
player against itself over the same seeds — and the lane asserts the result beats it, because a
threshold below its null gates nothing. Two identical deterministic players split 62.5% on seat
advantage alone, which is how a 60% bar once passed with the tier under test swapped out for the
one below it. Current numbers, 40 recorded seeds:

| Match | Null | Measured | Gate |
| --- | --- | --- | --- |
| `easy` vs uniform random | ~50% | 100.0% | ≥ 95% |
| `steady` vs `easy` | 62.5% | 90.0% | ≥ 70% |
| `sharp` vs `steady` | 52.5% | 75.0% | ≥ 55% |
| `sharp` vs `easy` | 62.5% | 97.5% | ≥ 80% |

`sharp` over `steady` is at the *same* node budget on both sides, so the whole 75.0% is the
horizon — the tiers differ in how far ahead they see, not in how long they are given.

**`corpus`** regenerates the blunder audit's reference values. It is deliberate and rare: the
reference is *stale by design*, because one regenerated alongside the bot measures the bot against
itself and reports every regression as a tie. It records the commit that produced it, marked dirty
if the tree was.

**`wide.mjs`** is the 200-seed run at shipped budgets that *would* produce the committed baseline.
It takes hours and is the only lane whose numbers may be quoted as a measurement of the opponent
that ships — `ladder` runs reduced budgets and pins the ordering on its recorded seeds, nothing
more. **No baseline is committed yet**: nobody has run it, so nothing in this repository cites a
number from it.

The search runs in a worker, so the page never blocks. It is handed the board as counts, never the
bag's order, so it plays with no information a person does not have.
