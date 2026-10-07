# ladrilho

An unofficial implementation of the board game [Azul](https://en.wikipedia.org/wiki/Azul_(board_game)),
for two players, in three parts that check each other:

- **a rules engine in TypeScript**, fast and deterministic, held to recorded games from an
  independent implementation;
- **a second rules engine in Rust**, 8× faster for training by self-play, held to the same
  recorded games and cross-checked against the first;
- **`master`, an AlphaZero-style player we trained ourselves**, from random weights, by self-play
  on the Rust engine, on one laptop CPU. It needs no GPU to play either: about 60 ms a move in the
  browser as WebAssembly.

There is a web client to play it in, and two other opponents beside the master: a hand-written
search (`easy`, `steady`, `sharp`, see [`packages/bot`](packages/bot/README.md)) and a port of a
published trained player (`expert`, currently withdrawn, see
[`packages/ai-bot`](packages/ai-bot/README.md)).

## Playing it

```bash
pnpm install
pnpm -F ui dev
```

Then choose who sits where. There is no server, no account and no storage; everything, the
master included, runs in the page. A reload deals a fresh game, and the URL reproduces one:
`?seed=42&seating=human-master` pins the deal and the opponent. The master thinks 10,000
simulations a move by default (about 60 ms on one thread of a laptop); `p2Simulations=50000`
makes the second seat's master think longer, anywhere from 100 to 200,000.

## Packages

pnpm monorepo:

| Package | What it is | Spec |
| --- | --- | --- |
| [`packages/engine`](packages/engine) | The TypeScript rules engine and its conformance suite | 0001, 0002, 0007 |
| [`packages/engine-rs`](packages/engine-rs) | The Rust rules engine: same rules, same vectors, 8× faster | 0009 |
| [`packages/crosscheck`](packages/crosscheck) | Plays invented games through both engines and stops at the first disagreement | 0010 |
| [`packages/alphazero-bot`](packages/alphazero-bot) | The player we train: Rust search and self-play, PyTorch trainer, TypeScript evaluation, WebAssembly build | 0011, 0012 |
| [`packages/ui`](packages/ui) | The Solid.js v2 web client: hot seat or against any opponent | 0003, 0006, 0012 |
| [`packages/bot`](packages/bot/README.md) | The hand-written opponent: three tiers, and the arena that measures them | 0004, 0005 |
| [`packages/ai-bot`](packages/ai-bot/README.md) | The `expert`: a port of a published AlphaZero-style player; not offered | 0008 |

## The engine, in TypeScript

`packages/engine` is the reference implementation: the rules of 2-player Azul as a small,
allocation-conscious state machine. The only randomness is the bag's shuffle, from a seedable
generator, so every game replays exactly.

Its rules are pinned by **conformance vectors**: complete games recorded from
[ludometer](https://github.com/RemiFabre/ludometer)'s Python engine, replayed move by move with the
board, the legal moves and the scores compared at every ply. The vectors are committed, so the suite
needs neither network nor Python; regenerating them does, see
[`tools/vectors/README.md`](tools/vectors/README.md).

Beyond `apply`, the engine explains how it scored each round (`applyExplained`, which the interface
shows), and exports a fixed-length **observation vector** from the mover's perspective. That vector
is the master's input, so its layout is treated as a stable interface: changing it invalidates
trained networks.

## The engine, in Rust

`packages/engine-rs` is a second, independent implementation: a synchronous library crate with no
dependencies on the TypeScript code, reading the same vectors in place. Every requirement of the
TypeScript engine's specs is classified in spec 0009's *Adopted requirements* table, and the build
fails until a new one is, so a rule change is a change to both engines.

It exists to be fast and to be a second opinion. Its throughput gate, measured on an idle laptop,
is **8.1×** the TypeScript engine (11.8M plies a second against 1.5M); it is what self-play runs
on.

## Two engines, checked against each other

`packages/crosscheck` plays invented games through both engines with the same bag orders and the
same moves, and stops at the first ply where they disagree about anything: the board, the legal
moves, the score, the round's record, the observation vector. The Rust side runs as a small
dependency-free binary. A disagreement is written as a report that replays without a seed.

When the two disagree, neither engine decides who is right, and neither does ludometer: the
**rulebook** does, Next Move Games' English web edition, pinned by its SHA-256 in spec 0010. Each
ruling becomes a permanent vector, recorded from ludometer and corrected in the open where it is
wrong. Games can be steered towards rare corners (floors overflowing, an empty bag and lid) so the
check reaches what random play seldom does.

## The master: a player we trained

`packages/alphazero-bot` is an AlphaZero-style player trained **from scratch**, by self-play on the
Rust engine, on a 4-core Intel laptop with no GPU, between 29 September and 5 October 2026.
Training is split in three main parts:

- a Rust crate, `azul_alphazero`: the network's forward pass, the search, self-play;
- a Python trainer (PyTorch, CPU only) that learns from the samples the crate writes;
- TypeScript lanes that measure each milestone, apply the stop rule and run the gate.

The network is a small residual MLP (width 256, 4 blocks, about 640,000 weights) over the engine's
observation vector. The search stops at the end of a round and values the position *before* the
deal, so it never reads a tile it could not know.

**How it was trained.** Twelve runs, each starting from the last one's best checkpoint and changing
exactly one thing. The story, with every decision and its evidence, is in the
[training journal](packages/alphazero-bot/milestones/JOURNAL.md); in short:

| Runs | What changed | Where it got to |
| --- | --- | --- |
| `first`–`second` | from random weights; display permutations | plateaued below `sharp` |
| `third` | 3000 games a generation | **beat `sharp` 79%** at the shipped budget: the gate passed |
| `fourth`–`fifth` | the gate off; a pool of champions as the yardstick | +464 Elo over `third`/90 |
| `sixth` | auxiliary targets: final margin and final walls | +496 |
| `seventh`–`eighth` | learning rate ÷10; 400 self-play simulations | +689 |
| `ninth`–`tenth` | learning rate ÷10; playout-cap randomisation | +776 |
| `eleventh`–`twelfth` | learning rate halved, twice | **+856**, at `twelfth`/120 |

Ratings are Elo in the champions' pool, with `third`/90, the checkpoint that first beat `sharp`, at
0. Every checkpoint is loaded beside a parity file of PyTorch's own outputs and checked on every
load.

**What ships.** `twelfth`/120, named by [`web/shipped.json`](packages/alphazero-bot/web/shipped.json),
compiled with the crate's own search to WebAssembly and run in a worker of its own, so a game
without a master never loads it. After the search, once the game can end this round, an **endgame
proof** (alpha-beta over the rest of the round, capped at 300,000 nodes) overrides the search's
move only with a proven win, or a proven draw in place of a proven loss. Replayed over the pool's
3,201 games, the proof lifts the shipped player from +856 to **+897**.

**Against an outside opponent.** [danluu.com/game/tile](https://danluu.com/game/tile/) has a strong
browser Azul AI of its own: an NNUE alpha-beta minimax, and an MCTS player. Played offline over
paired deals at the master's browser defaults, the master scored **85%** against the page's
default (minimax, 1 s a move on 8 threads), 68% against single-threaded minimax given 6.4 million
nodes (about 200× the master's time), and 96–100% against its MCTS. How the match is run, how the
position translation was verified, and the full sweep are in
[`packages/alphazero-bot/tile/README.md`](packages/alphazero-bot/tile/README.md).

## Intent and spec

Planned work is described in plain language under [`intent/`](intent/), one file per idea, written
before the code exists; see [`intent/README.md`](intent/README.md). The technical counterparts live
in [`spec/`](spec/): numbered, testable requirements (`[E1-14]`, `[Z11-76]`), each linked to the
intent it serves; see [`spec/README.md`](spec/README.md). Every package's suite fails if a
requirement is neither cited by a test nor exempted with a reason.

## Development

`pnpm test` and `pnpm typecheck` also run `cargo`, so a Rust toolchain is a prerequisite;
`rust-toolchain.toml` pins it.

```bash
pnpm install
pnpm test                        # every package
pnpm typecheck

pnpm -F engine test              # the TypeScript engine
pnpm -F engine test vectors      # the recorded games only
pnpm -F engine-rs test           # the Rust engine: vectors, rules, record, traceability
pnpm -F engine-rs compare        # the throughput gate against TypeScript; run it idle
pnpm -F crosscheck test          # the cross-check's everyday run and its mutations
pnpm -F crosscheck check --games 100000 --seed 7   # the long run

pnpm -F alphazero-bot test       # the crate and the evaluation lanes
pnpm -F alphazero-bot test:train # the trainer's suite; needs uv
pnpm -F alphazero-bot train --run <name>       # the training loop; resumes where it stopped
pnpm -F alphazero-bot web        # build the master's WebAssembly payload (ui's scripts run it)
pnpm -F alphazero-bot tile play  # the master against danluu.com/game/tile's AI

pnpm -F ui dev                   # the client, on a local dev server
pnpm -F ui test                  # the fast suite: jsdom, under 30s
pnpm -F ui test:browser          # layout, reload and the real workers, in chromium
```

The browser lane needs a browser: `pnpm -F ui exec playwright install chromium`, once. The full
list of commands, and what each costs, is in [`CLAUDE.md`](CLAUDE.md); the `bot` and `ai-bot`
commands are in their own READMEs.

## Acknowledgements

- **[RemiFabre/ludometer](https://github.com/RemiFabre/ludometer)**: its Python Azul engine is the
  oracle our engines are held to. The conformance vectors are recorded from it, and the engine's
  logic was first ported from it.
- **[danluu.com/game/tile](https://danluu.com/game/tile/)**: the strongest outside opponent we
  found. Its endgame solver showed us what our search was missing, and we took its approach for
  the master's endgame proof: a proof search over the rest of the round once the game can end.
- **[cestpasphoto/alpha-zero-general](https://github.com/cestpasphoto/alpha-zero-general)**, and
  **[suragnair/alpha-zero-general](https://github.com/suragnair/alpha-zero-general)** it forks: the
  trained Azul player ported as the `expert` here, and the first demonstration that this approach
  plays Azul well.
- **AlphaZero** (Silver et al., *A general reinforcement learning algorithm that masters chess,
  shogi, and Go through self-play*, Science, 2018): the method the master is trained by.
- **[KataGo](https://github.com/lightvector/KataGo)** (David J. Wu): playout-cap randomisation and
  the auxiliary score and ownership targets, both adapted here.
- **Michael Kiesling**, who designed Azul, and **Next Move Games**, whose English rulebook is the
  final word when the engines disagree.

## Name and licence

*Ladrilho* is Portuguese for a floor or wall tile. The interface goes by that name because Azul is
a trademark; this project is not affiliated with or endorsed by Michael Kiesling or Next Move Games.
The code and docs still say `azul` where they mean the rules.

The code is under the [MIT licence](LICENSE). The `expert`'s ported network and code in
`packages/ai-bot` keep their own MIT licence, in
[`LICENSE.alpha-zero-general`](packages/ai-bot/LICENSE.alpha-zero-general).
