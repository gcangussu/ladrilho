# Is the match against grzhx's AlphaZero fair?

An audit of this harness ([G13-49]), made on 19 October 2026 against their repository at commit
`b1d5f5dc5cbe14ae39fd96328b999dd87f92accb` and their release `v2300.1`, the ones `pinned.json`
names. The question is whether `grzhx play` gives their player the game it plays in its own
programs: the same rules, the same settings, no information either player would not have at the
table, and where the two sides are treated differently, in whose favour. The method was to read
the harness beside their source and beside the local player their release ships
(`azul-2300-local-play-windows-x64.zip`, its `python/azul_ai/web_game.py`, read from the cache as
data and never run), and to run `verify`.

The short answer: their player searches the way their own local player searches, on the same kind
of game object, with the settings their own match script uses; the rules agree on every ply
`verify` has played; and of the asymmetries that remain, listed below, the two that are not
neutral both favour us: our endgame proof runs outside a clock, and their player runs on a CPU.

## The rules

Our engine referees, and their engine is checked against it on every ply of every game: before
each move the host imports our position into their engine and compares it with the lockstep game
(observation, legal moves, mover, scores), and after each move the totals and the ends of rounds
and games are compared. A game where anything differs is reported and left out with its deal pair.

`verify`'s run for this pin: 200 games of random moves, 13,911 plies, 1,294 round ends, no
disagreement; 11 deals refilled the bag inside a factory and 524 plies overflowed a floor, the two
cases where translations of this kind usually go wrong. Both rule sets follow the same publisher's
English rulebook: their `docs/RULES.zh-CN.md` cites Next Move / Plan B Games' six-page English
rulebook (© 2018), read from a mirror, and ours is the web PDF spec 0010 pins by its SHA-256. That
the two files are the same edition was not checked. The tie-break is the same: complete rows.

One representation differs, and the translation absorbs it: our engine lets the first-player marker
land on a floor already holding seven tiles, counting eight; theirs stops its floor count at seven.
Both charge the same 14 points, and the import sends seven. `test:grzhx` steers a game to that case
and replays it through their engine.

## What each side is told

**Ours** is handed each position as `toCanonical(fromJSON(toJSON(state), 0))`: the bag rebuilt from
its counts in a fixed order, on seed 0, so neither the bag's order nor the shuffler can reach it
(0011's pre-deal view then keeps every dealt tile out of its search).

**Theirs** searches the lockstep game: their manual game, dealt each round the twenty tiles our
engine dealt, at the moment it dealt them, and stepped by the moves played. Its bag is counts, as in
every state of theirs; their search samples deals at round ends from those counts with its own
generator, which the harness seeds by a hash of the match's and game's seeds and the ply, never from
our shuffler. A game object of theirs carries a generator state of its own, but their search resets
its tree's generator and never reads the game's. So neither side can know what the bag will deal.

The imported state, our position as their `import_public` builds it, is compared and never
searched: an imported state has ply 0, and their subtree reuse matches a new root against the
previous tree by whole-state equality, ply included, so searching it would silently turn their tree
reuse off.

## The settings

By default the harness plays their actor with the search and tuning the actor itself records,
`gumbel_scale` 0, one `PipelineSearch` with one queue kept for the whole game: what their match
script `scripts/audit_ai.py` does. (Which script produced their README's equal-budget results, it
does not say.) Their local
player differs in five settings:

| setting | the actor's record (the harness's default) | their local player |
| --- | ---: | ---: |
| simulations | 2048 | 512 |
| candidates | 16 | 32 |
| max depth | 96 | 128 |
| cache capacity | 32768 | 4096 |
| `gumbel_scale` | 1.0, played as 0 (as `audit_ai.py` plays it) | 0 |

Everything else is the same: chance initial 4 and cap 256, value scale 0.1, max-visit init 50,
`q_mode` 1, `q_floor` 0.25, chance coefficient 2, exponent 0.5, sensitivity 1, the afterstate prior
0.25 (their local player applies it only to a checkpoint with an iteration, which this one has:
2300), subtree reuse on, the symmetric cache on for their equivariant network, one native thread,
float32 on the CPU (their local player turns bf16 on only under CUDA), one intra-op and one inter-op
torch thread. Every one of these is a setting of the harness (`--them-set`), so the local player's
values can be played instead: `--them 512 --them-set candidates=32 --them-set maxDepth=128 --them-set
cacheCapacity=4096`.

**After a deal.** Their local player bumps its actor's version after every manual deal, which
keeps any tree searched before the deal from being reused after it; the harness does the same.
`audit_ai.py` plays games their engine deals itself and never bumps it. The difference is
negligible: reuse across a deal would need the real deal to be among the at most 256 deals their
search sampled, and their evaluation cache keys on the round, so last round's entries never hit.

**Their clock.** Their local player's AI moves only on a fixed count; the one timed search their
author ships is its advice mode for the human player ("keep thinking"). The harness borrows it for
their clock: chunks of 1024 simulations (`chunk`, the local player's `fixed_budget or 1024`), each a
fresh search of the same root with subtree reuse off and candidates clamped to the chunk, voted by
their `rank_search_actions`; the vote counts finished chunks only, the chunk running at the clock is
abandoned as theirs is when the person stops, and the first chunk always runs to its end. The advice
mode builds its chunks' settings from the local player's configuration, where the harness, by
default, uses the actor's record; and it seeds its chunks with their `split_seed`, the harness with
its own hash. Neither changes what a chunk is.

## Where the two sides are treated differently

- **Our endgame proof is outside the clock** (in our favour). Under `ms:<n>` our search stops at
  the clock and then 0011's endgame proof runs, up to its node cap (300,000 by default), in time no
  clock counts; their player has no counterpart. The summary reports our proof's milliseconds apart,
  and `--us-set endgame=0` turns it off.
- **Their player runs on the CPU** (against them, by how much is not known). Their author trained
  and measured it on a GPU with bf16; here it runs in float32 on a laptop's CPU. The arithmetic is
  closer to exact, not further, but at a given clock it searches far less than on their hardware.
  Every summary's first line says so.
- **Their evaluation cache under a clock** (neutral, but unrepeatable). Their cache lives across
  chunks and moves, and an abandoned chunk has already written to it, so a clocked move of theirs
  depends on timing and does not replay; ours does, from its count. A clocked match says it is not
  repeatable.
- **Our memo and their tree reuse in a match** (neutral). Both make a match's moves cheaper than
  `timing`'s fresh searches; neither changes a move.
- **Their search's decision, never the policy's** (neutral). The harness plays the native
  sequential-halving action, or the vote, as every script of theirs does; it never plays the
  policy's most probable action, which their code refuses to execute.

## Not checked here

- That their local player, run itself on the same position and seed, makes the move the host makes.
  `test:grzhx` holds the host to their own `PipelineSearch` driven directly over the same manual
  game; the local player's own HTTP front end was not run.
- How their player's strength depends on the CPU against the GPU at equal counts.
