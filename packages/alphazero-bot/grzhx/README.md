# Our master against grzhx's AlphaZero

`pnpm -F alphazero-bot grzhx <command>` plays our trained player (spec 0011) against generation 2300
of [grzhx/azul-alpha-zero](https://github.com/grzhx/azul-alpha-zero), another AlphaZero-style Azul
player trained by self-play, on our own engine as referee. Spec
[0013](../../../spec/0013-master-against-grzhx.md) is the description of record; intent 0015 says why.

```bash
pnpm -F alphazero-bot grzhx play --games 200 --us 1000,11300 --them 512,2048
pnpm -F alphazero-bot grzhx play --us ms:1000 --them ms:1000 --them-set chunk=512
pnpm -F alphazero-bot grzhx info --them 2048 --them-set trees=4
```

[`FAIRNESS.md`](FAIRNESS.md) audits whether a match gives their player the game it plays in its own
programs.

## Their player

Their repository has no licence, so nothing of theirs is in ours. `fetch` clones it at the commit
`pinned.json` names and downloads release `v2300.1` into `~/.cache/azul-grzhx` (`--cache` or
`$XDG_CACHE_HOME` to move it); every file is checked against the pin, and the release's files also
against their own `SHA256SUMS.txt`, before anything is built or loaded. `play`, `verify`, `replay`,
`info` and `timing` fetch when the cache is missing. `check-updates` asks GitHub whether their
branch or release moved, and `pin <commit> <tag>` moves the pin, which is a spec change as well:
spec 0013's *Definitions* name the commit.

Their native library is built from the cached tree with the cmake wheel in the host's own
environment (`host/.venv`, built by `host/venv.sh` from hashed wheels: Python 3.12, torch 2.2.2,
NumPy 1.26.4). On a Mac whose Command Line Tools ship a partial `include/c++/v1`, the build names the
SDK's C++ headers explicitly, and every result records that flag.

Their player runs in the **host** (`host/host.py`), our own Python program that imports their
modules from the cache unchanged. For each game it keeps a **lockstep game**: their manual game,
dealt only the tiles our engine dealt and stepped only by the moves played. Their search plays on
it, as their own local player plays a manual game, so their tree reuse between moves works as it
does there. A count is searched by their `PipelineSearch` with the search and tuning the actor
records and `gumbel_scale` 0, as their `audit_ai.py` plays; `trees` > 1 votes over independent roots
as their `evaluate_tree_counts.py` does; a clock borrows their local player's advice mode.

## Settings

Every setting of both sides is on the command line; `info` prints them all, resolved, and where each
came from.

| | budget (`--us`, `--them`) | everything else (`--us-set`, `--them-set`) |
| --- | --- | --- |
| ours | `<n>` simulations, or `ms:<n>` a clock | `checkpoint` (a logged milestone), `cpuct`, `fpu`, `endgame` (the proof's node cap; 0 off), `ceiling` (a clocked move's most simulations) |
| theirs | `<n>` simulations, or `ms:<n>` a clock | `candidates`, `maxDepth`, `chanceInitial`, `chanceCap`, `valueScale`, `maxvisitInit`, `gumbelScale`, `qMode`, `subtreeReuse`, `cacheCapacity`, `symmetricCache`, `qFloor`, `chanceCoefficient`, `chanceExponent`, `chanceSensitivity`, `afterstatePrior`, `trees`, `threads`, `torchThreads`, `chunk` (a clocked chunk's simulations), `build` (`native`, `anytime`) |

Ours defaults to the shipped milestone's logged settings and `web/shipped.json`'s endgame cap; theirs
to what the actor records (2048 simulations, 16 candidates, depth 96, …) and their dataclasses.

**Counts, not clocks, by default.** A clock depends on what else the machine is doing, so a match
on a clock does not repeat. A match with no clock and `torchThreads` 1 replays move for move,
whatever `--workers` is; the summary says whether a match was repeatable. The two programs count a
look-ahead differently, so pick counts from the table below.

- **Our clock** stops our search after the first whole simulation past the clock, the endgame
  proof following outside it; the move is exactly the search of the count it reached.
- **Their clock** searches chunks of `chunk` simulations, fresh each time, and plays the vote over
  the chunks that finished; the chunk running at the clock is abandoned, the first always runs to
  its end (`overrun` records by how much). Their search checks the clock only between requests to
  the network, and a hit in their evaluation cache is answered without one, so with the cache on, as
  by default, a chunk is usually answered between checks and runs whole: the move then overruns its
  clock by up to a chunk, and `overrun` shows by how much. Their evaluation cache lives across chunks and moves, so
  a clocked move of theirs is not guaranteed to replay even from its count of chunks.

## Timing

How long each player takes per move here, from `grzhx timing`, which rewrites `timing.json` and this
table. Our times are the search's alone: our endgame proof, which their player has no counterpart
of, runs after it, outside any clock. In a match with one tree and a count, their search reuses its
tree across a game's moves, and our `serve` keeps its memo of evaluations across a round (spec 0011,
Z11-69), while `timing` searches each position fresh on both sides, so a match's moves may cost less
than the table says; and a clocked move of theirs is not the search of the
count it reached.

<!-- timing -->
| side | simulations | median ms | p90 ms | mean ms |
| --- | ---: | ---: | ---: | ---: |
| ours | 500 | 18.0 | 29.0 | 15.8 |
| ours | 1,000 | 30.0 | 55.0 | 28.4 |
| ours | 2,000 | 42.0 | 108 | 50.7 |
| ours | 4,000 | 60.0 | 208 | 85.7 |
| ours | 8,000 | 74.0 | 380 | 139 |
| ours | 11,300 | 101 | 549 | 205 |
| ours | 16,000 | 106 | 786 | 260 |
| theirs | 128 | 183 | 262 | 190 |
| theirs | 256 | 328 | 474 | 334 |
| theirs | 512 | 631 | 752 | 585 |
| theirs | 1,024 | 1137 | 1382 | 1036 |
| theirs | 2,048 | 1870 | 2259 | 1695 |
| theirs | 4,096 | 3980 | 4749 | 3517 |
| theirs | 8,192 | 7569 | 9679 | 6821 |

A player makes 28.0 moves in a game on average, 31 at most (20 games).
Measured 2026-10-19 on Intel(R) Core(TM) i7-1068NG7 CPU @ 2.30GHz, 8 logical cores, darwin 25.6.0: 198 positions of the latency corpus, one move at a time, each search fresh, single-threaded.
Ours is `twelfth/120`; theirs is generation 2300 at `b1d5f5dc5cbe`.

A cell takes about `games × moves per game × (our mean + their mean) ÷ workers`.
<!-- /timing -->

## How a match is played and judged

- **Our engine is the referee.** It deals, decides what is legal, applies every move and scores
  the game, ties included.
- **Paired deals.** Seed `seed + k` is played twice in every cell, once from each seat, and every
  cell plays the same seeds. `--games` is per cell, rounded up to even.
- **Every ply is compared.** Before each move the host imports our position and compares it with
  the lockstep game: observation, legal moves, mover, scores; after each move the totals and the
  ends of rounds and games are compared. A difference ends that game, writes a report to
  `<out>.disagreements/`, and leaves its deal pair out of the result; the match plays on. The report
  says which comparison failed, not whose fault it is: that is a ruling, as in spec 0010.
- **Information.** Ours is handed each position rebuilt from counts on seed 0; theirs only what
  their public import takes. Neither ever sees the bag's order.

Output: `<out>.jsonl`, a header line and one line per game as it finishes, and `<out>.json`, the
summary per cell, computed from those lines alone: W-D-L, our score with a Wilson 95% interval, the
Elo difference it implies, our mean margin, our score from each seat, and each side's ms per move
(mean and p90), our proof's ms, and simulations per move. `<out>` defaults to `runs/grzhx/<time>`
(git-ignored). A stopped match still writes its summary, saying so.

## Checking the translation

`verify` plays random games through the lockstep game, every comparison at every ply, with one
search of theirs per ply so the import is exercised as play uses it. It exits 1 on any disagreement,
or if its games never refilled the bag inside a factory or overflowed a floor. Run it after a new
pin. `replay <report>` replays a disagreement report and exits 0 once it no longer reproduces.
`fixtures` re-records `fixtures/convert.json`, which holds `convert.ts` to what their engine
accepted, in the suite that needs no cache.

When the pin was checked (2026-10-19): 200 games, 13,911 plies, 1,294 round ends, 0 disagreements;
11 deals refilled the bag inside a factory, and 524 plies overflowed a floor.

## Tests

`pnpm -F alphazero-bot test` runs what needs no cache. `pnpm -F alphazero-bot test:grzhx` runs what
needs the cache, the host's environment and their build: the host, the lockstep game, clocks and
votes against their own programs.
