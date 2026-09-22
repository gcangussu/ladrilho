# azul

A TypeScript implementation of the board game [Azul](https://en.wikipedia.org/wiki/Azul_(board_game)): a rules engine, a web UI, and an AI bot.

## Roadmap

1. **Engine** — a fast, deterministic 2-player Azul rules engine with a thorough test suite. Logic and test vectors are ported from [RemiFabre/ludometer](https://github.com/RemiFabre/ludometer)'s `ludometer/azul` engine.
2. **UI** — a web client built with [Solid.js](https://www.solidjs.com/) v2.
3. **AI bot** — an agent that plays via the engine, running in the browser alongside the UI.

Since then: the engine reports how it scored each round and the UI shows it (spec 0007), and a
fourth package, `ai-bot`, ports a published trained player as an optional `expert` difficulty
(spec 0008) — currently **not offered**, see [The expert](#the-expert).

## Structure

pnpm monorepo:

| Package | Status | Description |
| --- | --- | --- |
| `packages/engine` | done | Azul rules engine + conformance suite |
| `packages/ui` | done | Solid.js v2 client, hot seat or against the bot |
| `packages/bot` | done | The opponent: evaluation, search, three tiers, and the arena that measures it |
| `packages/ai-bot` | done, not offered | The `expert`: a port of a published AlphaZero-style player; offered only while its gate passes |

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

pnpm -F ai-bot test              # the expert: board, network, search, sessions, the gate result
pnpm -F ai-bot gate              # the [A8-30] gate against `sharp`; ~50 minutes, writes the baseline
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
| `sharp` vs `steady` | 52.5% | 75.0% | ≥ 62.5% |
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

## The expert

`packages/ai-bot` is a port of the AlphaZero-style Azul player in
[cestpasphoto/alpha-zero-general](https://github.com/cestpasphoto/alpha-zero-general) — its
network, its trained weights, its search (100 simulations a move) and the tree it keeps for a
whole game — onto this engine, as a fourth difficulty called `expert`. It lives beside `bot`
rather than inside it: `bot` is code we can read and explain, and weights we cannot are kept
apart from it. Spec 0008 has the details, including the fixtures that prove the port matches the
original move for move.

```bash
pnpm -F ai-bot test              # fast suite, including parity with the original's recorded outputs
pnpm -F ai-bot gate              # 200 games against `sharp`, plus the expert-vs-expert null; ~50 minutes
pnpm -F ai-bot fixtures          # re-record from the original Python program; needs `uv`. Deliberate
pnpm -F ai-bot weights           # regenerate src/weights.ts from the checkpoint. Deliberate
```

**It ships only if it beats `sharp`.** The gate plays it against `sharp` at shipped budgets and
passes at a winrate of 60% or more; a full run writes `packages/ai-bot/gate/baseline.json`,
which is committed whether it passed or not, and the interface offers `expert` if and only if
that file says `passed: true`.

**It does not pass today.** Its first gate won 72% (143 of 200), but that was measured against a
`sharp` whose root search could break a tie on an alpha-beta bound and play a strictly worse
move ([B4-30]). With that fixed, the rerun over the same seeds reads:

| | Winrate | Lower bound | W / L / D | Mean score (expert – `sharp`) |
| --- | --- | --- | --- | --- |
| First gate, old `sharp` | 72.0% | 66.5% | 143 / 55 / 2 | 43.5 – 36.4 |
| Rerun, fixed `sharp` | **45.0%** | 39.3% | 88 / 108 / 4 | 41.0 – 45.4 |

The null (expert against itself) is 42.75% both times. The expert is deterministic and did not
change, so the same player on the same deals going from 72% to 45% is the measure of how much
stronger the fix made `sharp` at its shipped budget — which the ladder, at reduced budgets and
with the fix in both of its players, cannot say. So `expert` is currently withdrawn from the interface, and a URL naming it
is discarded like any other unknown setting. The package, its suite and its gate stay, so a
stronger expert can be measured the same way.
