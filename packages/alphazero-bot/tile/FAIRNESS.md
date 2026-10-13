# Is the match against danluu.com/game/tile fair?

An audit of the harness in this directory, made on 13 October 2026 against their files as fetched
on 3 October (`tile info` shows the hashes). The question was whether `tile play` gives their AI
the game it plays on its own page: the same rules, the same settings, the same budget, and no
information either player would not have at the table. The method was to read the harness beside
the page's own script and worker, to probe their WASM directly where reading could not settle a
point, and to load the live page in a browser for what only a browser can show.

The short answer: the harness is faithful, and where the two sides are not symmetric the
asymmetry is in their favour, with one exception that the last section measures.

## What each side is told

**Ours** is handed each position through `toJSON`, whose bag is counts and never an order, and
the process rebuilds the state with seed 0 ([Z11-15], [Z11-21]; `eval/chooser.ts`). It cannot
know what the next round deals.

**Theirs** is handed the position through `convert.ts`: counts for the bag too. Their game object
also carries `cfg.seed`, which the harness fills with our game's seed, and that seed does reach
their state bytes (two seeds give different `game_bytes()`). So the question was whether their
search reads it to deal ahead. It does not. Over eight positions with one to six tiles left in the
round, chosen so a search must reach the round's end, their minimax at 200,000 nodes and their
MCTS at 2,000 simulations, each from a fresh search object and the same search seed, returned
bit-identical values, visit counts and moves for `cfg.seed` 1 and 123456. Their evaluation does
read the bag's counts (permuting them changed a root value from 0.907 to 0.996), which is public
information and which the translation gets right.

The `human` argument of their `set_state` does not change `game_bytes()` either, so passing
`'P0'` for both seats, as the harness does, changes nothing their search sees.

## The settings

Every setting the page's move path uses was compared with the harness's call. All of them match:

| setting | the page | the harness |
| --- | --- | --- |
| pruning spec, Zobrist table, racy-verified shared table | worker defaults | read from the worker; `set_*` on each search |
| shared-tree virtual visits on, batched evaluation off, forced playouts off | page defaults | the same |
| MCTS constants, score weights, score scale | page constants | read from the page |
| minimax node cap on a clock | `0xffff_ffff`, stopped by cancel | the same |
| cancel safety margin | `min(60, max(2, clock / 4))` ms | the same |
| cancel poll interval | 64 at a 1 ms clock, else 4096 | the same |
| tail solver tried | round ≥ 5, clock ≥ 1 s, 3+ threads | the same |
| tail timeout, tail node cap | clock left − 120 ms, 2,000,000 | the same |
| tail threads in the race | `min(2, threads − 1)` | the same |
| tail score weight | the MCTS player's 0.1 with 3+ threads, else 0 | the same |
| forced moves | played without searching | the same |
| search object | one per game, table and tree kept between moves | the same |

The one path with no counterpart on the page is a node budget (`nnue:<nodes>`), which the page
never uses: it is the harness's repeatable stand-in, and the sweep's clock rows use `nnue-ms`.

## The page's default is threaded

danluu.com serves `cross-origin-opener-policy: same-origin` and
`cross-origin-embedder-policy: require-corp`, so a browser gives the page shared memory and it
starts in thread mode with `navigator.hardwareConcurrency` threads at 1 s per move, NNUE minimax,
on the race path. The live page in the desktop app's embedded browser confirmed thread mode on,
the standard model `nnue` and 1000 ms, with 4 threads: that browser reports 4 logical cores where
Chrome on the same machine reports 8. The thread count a visitor gets depends on their browser as
well as their machine. The sweep found 8 threads bought little over 1 at matched time, so this
moves the "page default" point by a little.

## Their endgame solver

The page's worker clamps the solver's share of the race to `min(2, threads − 1)` threads, and
their Rust refuses to solve on fewer than three. Probed on a round-5 position with eight tiles
out:

| call | result |
| --- | --- |
| race on 8 threads, 2 to the solver (the page's default) | `skip_tail_solver_web_threads_lt3:2` |
| `tail_solve_root_shared_tree_limited`, 2 threads | `skip_tail_solver_web_threads_lt3:2` |
| the same, 3 threads | solved, 23 ms |
| the same, 8 threads | solved, 20 ms |
| single-threaded `search_root` at 4,096 simulations (what the page's warm workers run) | `skip_tail_solver_web_threads_lt3:1` |
| shared-tree MCTS at 4,096 simulations on 8 threads | solved |

So on its own page the NNUE opponent never plays a solver move: the race declines on two threads,
and the solutions the page works out on the opponent's turn come from single-threaded searches
that decline too. This is the page's code, not a Node artefact. `--tail race` is the page as it
is; `--tail on` is their player as designed, with the solver given every thread first.

## The referee

Our engine judges, and `tile verify` checks the translation against their engine at every ply,
legal moves, resulting position and outcome code included: 200 games, 11,207 plies, 0
disagreements when written. Ties are broken by rows, as the rules say, on both.

## Where the comparison is generous

- **To them: time.** The page default spends 1 s on every logical core; the shipped master spends
  about 63 ms on one thread. Matching time would widen the gap.
- **To them: the clock.** On a clock, the harness arms the cancel from the move's start, as the
  page does, and gives their single-threaded fallback the whole clock where the page would also
  cap it at a conservative node estimate.
- **To us: the proof.** Our master plays with an exact endgame proof ([Z11-76]); their solver
  declines on the page's path. Every row of the October sweep ran `--tail race`. The last section
  below measures `--tail on` against the shipped master, which the sweep had not.
- **Not modelled: pondering.** The page searches on while its opponent thinks and warms its table
  on likely replies. Against our master that is at most our own thinking time, under two seconds
  in the browser, on a 1 s clock.
- **Not reproducible: the sweep's games.** The per-game files of the 6 October sweep were in a
  git-ignored directory of a worktree since removed. Its node-budget rows can be regenerated with
  `--seed 900`; its clock rows never could be, by design.

## The solver granted: `--tail on` against the shipped master

Run on 13 October 2026, the same machine as the sweep (4-core / 8-thread i7-1068NG7), one game
at a time, with the seeds the sweep used:

```bash
pnpm -F alphazero-bot tile play --us 10000 --endgame 300000 --them nnue-ms:1000@8 --tail on \
    --games 100 --seed 900 --workers 1
```

| their player | games | W–D–L | our score | 95% CI | Elo | margin | first / second | their ms/move | solved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `nnue-ms:1000@8`, `--tail on` | 100 | 81–3–16 | 82.5% | 73.9–88.7% | +269 | +5.8 | 93% / 72% | 779 | 15.8% |
| `nnue-ms:1000@8`, `--tail race` (the sweep, 6 Oct) | 200 | 169–3–28 | 85.3% | 79.7–89.5% | +305 | | 87% / 84% | 814 | 0% |

With the solver granted, it proved 15.8% of their moves and played at least one proven move in
every game, and our score moved from 85.3% to 82.5%: inside either interval, and the same
direction and size as the earlier probe measurement in the README (which cut our margin, not
our wins). The first 60 games of each row are the same 30 deals from both seats; the sweep's
per-game files are gone, so no paired test is possible. The machine was not idle for this run
(load average 9–12 on 4 cores, from other applications), which costs their 8 threads more than
our one; their main thread still searched about 500,000 nodes a move, in line with the README's
figure for 8 threads on this machine, so the harm looks small. Rerun it idle before quoting the
82.5% beside the sweep's rows.

The conclusion the sweep drew stands with their solver on: the shipped master beats the page's
default opponent at its own clock, by about 270 to 300 Elo, from both seats.
