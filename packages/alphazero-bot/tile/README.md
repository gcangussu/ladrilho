# Our master against danluu.com/game/tile

`pnpm -F alphazero-bot tile <command>` plays our trained player (spec 0011) against the AI of
[danluu.com/game/tile](https://danluu.com/game/tile/), locally and offline once their files are
cached, with the work per move fixed on both sides.

```bash
pnpm -F alphazero-bot tile play --games 200 --us 1000,11300 --them nnue:100000,nnue:600000,mcts:800
```

## Their player

Their page is a Rust engine compiled to WebAssembly (wasm-bindgen) that runs entirely in the
browser; nothing is computed on a server. It has two players:

| spec | what it is | budget |
| --- | --- | --- |
| `nnue:<nodes>` | the page's **default** opponent: alpha-beta minimax over an NNUE value net (`nnue.nnue`) | minimax nodes per move |
| `nnue-ms:<ms>` | the same, stopped on a clock as the page does it; not repeatable, and wall-clock depends on load | milliseconds per move |
| `mcts:<sims>` | the page's **alternate** opponent ("PJF98-like model with mcts"): PUCT over a policy/value net (`model.safetensors`), most-visited move played | simulations per move |

The page's AI-time setting is a clock (1 s/move by default). Without a suffix the search runs
single-threaded on a node or simulation budget, which is what the page itself does when it lacks
shared memory, and every game is reproducible. For scale: the minimax does roughly 600k nodes/s on
one thread of the machine this was written on, so `nnue:600000` is about the page's default on one
thread. MCTS keeps its tree between moves, as the page does, so `mcts:<sims>` is the root's visit
total, reused visits included.

### Threads, and the endgame solver

Any budget takes `@<threads>`: `nnue:600000@8`, `nnue-ms:1000@8` (the page as a browser runs it by
default, on an 8-core machine), `mcts:8000@8`. That runs the page's threaded mode on its threaded
build (wasm-bindgen-rayon over shared memory). The build's glue imports a rayon helper that starts
Web Workers. `threads.ts` copies their glue and module unchanged into `~/.cache/azul-tile/node/` and
puts a `worker_threads` version of that helper beside them. Threaded minimax is LazySMP. Its node budget
caps the main thread, and the helper threads search beside it until the main thread stops, so
`nnue:N@T` does roughly T times the work of `nnue:N`. The figure reported (`work/mv`) is the main
thread's count. On this machine 600,000 nodes took about 0.5 s on one thread and about 1.0 s on 8,
with 5–6.5 CPU-seconds used per second. Threaded MCTS grows one shared tree. A clock
(`nnue-ms:<ms>@<threads>`) is stopped the way the page stops it, through the cancel cell in the
module's shared memory, written from a timer thread. **Threaded games are not reproducible:** the
threads race.

Their endgame solver refuses to run on fewer than three threads, so it only runs at `@3` or more:

- **MCTS** runs it inside the search when the budget is at least 4096 simulations (below that it
  reports `skip_target_sims_lt_min`). The page does the same.
- **Minimax**, from round 5, probes the solver first. It plays the solver's move when one is
  proven, and minimax otherwise. The probe is limited to 2M nodes and to `--tail-ms` (default 1000)
  on a node budget, or to the clock less 120 ms, skipped below a 1 s clock, as on the page. This is
  the page's own tail-probe branch. The page's *default* threaded path instead races the solver
  against minimax on at most two threads, which the solver refuses
  (`skip_tail_solver_web_threads_lt3:2`), and minimax then has the other threads (6 of 8). The
  solutions the page works out ahead while its opponent thinks use a single-threaded search, which
  also declines here (`lt3:1`). So in practice the page's minimax appears not to solve endgames at
  all; this was measured in Node, not in a browser. `--tail off` leaves the probe out, which is
  closer to that, except that minimax keeps all its threads.

The `solved` column is the share of their moves the solver proved, and each game's line has
`theirSolved`. `--workers` defaults to cores ÷ their threads.

The search settings (pruning spec, PUCT constants, score weights) are read from the cached page and
worker, not copied into this code, so an update upstream is followed. `info` shows them.

## Our player

`alphazero serve` (the native release binary, built first unless `--no-build`) with the logged
config of the milestone it plays, `playSimulations` replaced by each `--us` value. The default
checkpoint is the one `web/shipped.json` names; `--checkpoint tenth/70` picks another milestone.
`--endgame <nodes>` turns on our endgame proof ([0011 Z11-76]) with that node cap.

## How a match is played and judged

- **Our engine is the referee.** Each of their moves starts from our position translated into their
  game object (`convert.ts`); their search returns an action id, translated back. The deal comes
  from our engine's seed, and the result, ties included, is decided by our rules.
- **Paired deals.** Game seed `seed + k` is played twice, once from each seat, and every cell of the
  `--us` × `--them` grid plays the same deals. `--games` is per cell, rounded up to even.
- **Reproducible**, single-threaded. Both searches are deterministic on a budget, and their search
  object is fresh each game (its transposition table and tree persist between moves, as on the
  page), so a rerun with the same seed replays the same games whatever `--workers` is. `nnue-ms` and
  anything `@<threads>` are the exceptions; the summary's header says `repeatable`.
- **Parallel.** `--workers` games at once (default: cores − 1, or cores ÷ their threads), each in a
  worker thread holding their WASM and one `serve` process per game.

Output: `<out>.jsonl` gets one line per game as it finishes (a stopped match keeps what it played),
and `<out>.json` the summary per cell: W-D-L, score with a Wilson 95% interval, the Elo difference
it implies, the mean margin, the score from each seat, ms/move and their nodes (or sims) per move.
`<out>` defaults to `runs/tile/<time>` (git-ignored). Each file's header records our checkpoint's
sha256, the sha256s of their WASM and both networks, and the settings read from their page.

## Their files

Nothing of theirs is in the repository. `fetch` downloads the page, the worker, three single-threaded
WASM builds (`--build scalar|simd|relaxed`, default `simd`), the two threaded ones (simd, relaxed)
and both networks into
`~/.cache/azul-tile` (`--cache` or `$XDG_CACHE_HOME` to move it), with a manifest of sha256s; `play`
and `verify` fetch when the cache is missing.

- `check-updates` asks the site for every file (conditional on its etag), compares by sha256,
  reports changed files and changed search settings, and exits 1 if anything changed. It writes
  nothing.
- `update` re-downloads everything. If their threaded glue stops importing the rayon helper from
  the path `threads.ts` expects, threaded play stops with a message saying so.

## Checking the translation

`verify` plays random games on our engine and, at every ply, hands the position to their engine:
the legal moves must agree, the same move is played on both, and the results must match, fully
within a round and in everything dealing cannot change across a round end, including the outcome
code at game end. It also compares their own `new_game` opening with ours, which fixes conventions
their engine only echoes back (that `round` counts from 1). Run it after an `update`.

```bash
pnpm -F alphazero-bot tile verify --games 200
```

When written: 200 games, 11,207 plies, 1,059 round ends, 0 disagreements. Each of these mutations
of `convert.ts` was seen to fail it: the floor count without the marker, transposed walls, the
centre not renumbered, floored tiles not counted in the discards, a 0-based round. Two differences
are representation only and normalised before comparing: their floor count keeps rising past seven
tiles (ours sends the excess to the lid at once; the discards and penalties agree), and at game end
their state keeps the marker and turn where the last ply left them.

## Grading their endgame solver

```bash
pnpm -F alphazero-bot tile solver-check --games 40
```

This asks whether their solver ever plays worse than their minimax, which is the question behind
`--tail`. It takes positions from games of their single-threaded minimax against itself: every ply
from round 5 on with more than one legal move. At each position it gets their threaded minimax's
move (`--nodes`, `--threads`), probes their solver as `--tail on` does, and grades both moves with
an exact search of our own on our engine (`solvercheck.ts`).

Exact means this: nothing is dealt until a round ends, so the rest of a round is a game of perfect
information. A line that ends the game at the round's end has an exact result. A line that
continues into another round meets the bag, so it doesn't. Each value is searched twice, once with
every continuing line scored as a win for player 0 and once as a loss. Minimax is monotone in its
leaves, so when the two agree the value is exact; otherwise the move is not graded. Values are
outcome × 1000 + final margin, from the mover's side.

The exact search was checked against plain unpruned minimax: 3,094 child positions with 0
mismatches. A smaller version runs in the package suite (`test/tile.test.ts`). Its test scores
continuing lines by their margin, because constant leaves hide a table that confuses its bounds.
Two mutations of the table's bound handling were seen to fail it.

## What was measured

Run in October 2026 on a 4-core/8-thread Intel i7-1068NG7, with their files as fetched on
2026-10-03 (`info` shows the hashes). Our player was tenth/20, the shipped `master` at the time (`--checkpoint tenth/20` replays it). Raw results
were in `runs/tile/`, which is git-ignored.

**The endgame solver** (`solver-check`, 212 positions from 16 games, their minimax at
`nnue:1000000@8`). In the 130 positions where every move could be graded exactly, both their
solver and their minimax chose a move with the best possible result (win or loss) in all 130. The
solver also had the best margin in all 130; minimax had it in 37, giving up 6 points on average
(16 at most). Of 124 graded positions where the two disagreed, none changed the result. Their
minimax values only win or loss (score weight 0), so it is indifferent to margin by design.

**Their players against ours.** Our master at 800 simulations took about 16 ms per move on one
thread. Each row is 60 games on the same 30 deals (seed 500), each deal from both seats:

| their player | their ms/move | our score | 95% CI |
| --- | --- | --- | --- |
| `nnue-ms:1000@8`, `--tail off` | 819 | 62.5% | 50–74% |
| `nnue:600000@8`, `--tail on` | 770 | 63.3% | 51–74% |
| `nnue:600000@8`, `--tail off` | 748 | 70.8% | 58–81% |
| `nnue-ms:1000@8`, `--tail on` | 779 | 73.3% | 61–83% |
| `mcts:8192@8` | 297 | 90.0% | 80–95% |
| `mcts:24576@8` | 747 | 91.7% | 82–96% |

Their strongest player is the minimax. The probe made no measurable difference to who wins: it
helped them on a node budget and hurt them on a clock, neither significantly (paired sign tests,
p ≈ 0.35 and 0.19); pooled, our score was 68.3% with it and 66.7% without. It did cut our average
margin, from about +17 to about +2. Single-threaded, our shipped 11,300 simulations beat
`nnue:600000` 18–2 in 20 games.

**Our endgame mistakes, and the proof that fixes them** ([0011 Z11-76]). Every round-5+ move of
ours was graded exactly in 42 games against their single-threaded `nnue:600000`, the same deals
each time:

| our master | positions graded exactly | moves with a worse result | games by score (W–T–L) |
| --- | --- | --- | --- |
| eleventh/130, 800 simulations | 168 | 2 (wins thrown into losses) | 33–0–9 |
| twelfth/120, 11,300 simulations | 169 | 2 (wins thrown into draws) | 28–5–9 |
| twelfth/120, 11,300 simulations, `--endgame 2000000` | 168 | **0** | 30–3–9 |

Their minimax made none in any run. Fourteen times the simulations did not fix it, which points at
the search's averaging rather than its budget. With the proof on, twelfth/120 played itself
without it over the 200 wide seeds, each from both seats: 184 deals split, and in the 16 the proof
changed it came out ahead every time (7 won both games, 9 won one and drew one), +11.5 points in
400 games (sign test p ≈ 3 × 10⁻⁵), for about 16% more thinking time.

