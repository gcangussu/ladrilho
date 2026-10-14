---
title: Opponent in the interface
author: Gabriel Cangussu
date: 2026-09-06
status: implemented
intent:
  - 0003 — Computer opponent
  - 0010 — Playing the opponent we trained
  - 0012 — How the opponent sees it
  - 0014 — The game's record, for the curious
prefix: W6
depends-on: 0001 — Engine core, 0003 — Web interface, 0004 — Computer opponent
summary: >
  Where the opponent runs and what the player sees while it thinks: choosing an
  opponent, the worker that hosts the search, the thinking state, and what
  happens to the controls during a turn that is not yours; and, for intent 0012,
  the one thing shown of what it reckoned — its estimate, after each of its
  moves; and, for intent 0014, the game's record behind a closed control —
  every ply, and each computer ply's report. Amends 0003 — Web interface,
  which said it would need amending.
---

# Opponent in the interface

## Scope

Covers the changes to `packages/ui`: the opponent selector, the worker seam, the thinking state,
the turn loop that asks for a move and submits it, what the board does while a search is in
flight, the estimate shown after the computer moves (*The estimate*, [W6-55] onward), and the
game's record — the field, its control and dialog, and the log (*The record*, [W6-67] onward). The
record's graph is specified in its own section.

Does not cover how a move is chosen (*0004 — Computer opponent*), how good it is (*0005 — Opponent
strength*), or the rules (*0001 — Engine core*).

It **amends** *0003 — Web interface* rather than superseding it. 0003 remains the description of
record for everything about the board, and it anticipated this document in its own Scope:

> It also does not settle how a move arrives from something that has to think about it first.
> [U3-18] applies and publishes synchronously and [U3-20] propagates a synchronous throw; across
> the worker boundary intent 0003 wants, both become asynchronous […] [U3-31] keeps the seam narrow
> enough to widen — `submit` takes an action and learns nothing about who chose it — and the spec
> that serves *intent 0003* changes its signature, and this document with it.

The amendments are enumerated in *Amendments to 0003* below. Every one of them is a change to be
made **in** `spec/0003-web-interface.md`, which is a living document; this spec is where the
reasoning for each lives.

### Intent 0003's third open question, answered

> Should the player be able to watch two computer opponents play each other? It is a good way to
> spot bad play, and it costs almost nothing once the rest exists.

**Yes**, and the intent's own reasoning is why: once either seat can be a computer, both being one
is a value in the seat selector and a turn loop that does not stop. [W6-9] requires it. It costs a
third option and nothing else, and it is the only way to *watch* the play that *0005 — Opponent
strength* only counts.

### What stays true

The organising rule of 0003 — the interface contains no rule — is untouched, and this spec adds a
second of the same shape: **the interface contains no strategy**. It does not rank a move, does not
know why one was chosen, and cannot tell a good move from a bad one. It asks the bot for an action
the way it asks the engine for a legality, and submits the answer through the same `submit` a
person's move goes through ([0003 U3-31]).

That is also intent 0003's *Not in scope* — "Explaining its moves to the player, or coaching them"
— and intent 0004's, which rules out "Explaining why the computer opponent chose something". The
`Choice` of [0004 B4-40] carries a value, a depth and a node count; [W6-24] forbids showing any of
them as a judgement.

*(Amended for intent 0012.)* One of them is now shown, and only one: the value, as the
**estimate** of [W6-55] — after the computer's move, about the position its move left, attributed
to the opponent that produced it, in that opponent's own terms. It is not a judgement of a move:
nothing is shown before a move is made ([0003 U3-30] is untouched), nothing is shown of a
person's move, and nothing is computed to produce it. The interface still does not rank, explain
or suggest a move; it relays one number the opponent already reported, as the opponent's.

*(Amended for intent 0014.)* Behind a control closed by default, the game's **record** relays the
rest of what each reply reported — depth, nodes, simulations, visits, its flags and the raw
value — row by row ([W6-67] onward). [W6-24] stands everywhere else ([W6-80]). It is still not a
judgement: the record holds what the opponent said as it chose, computes nothing, and says nothing
of a person's move but the move.

## Definitions

Terms from *0003* — the view model, `submit`, `publish`, the state module — carry their meaning
there. Terms from *0004* — tier, `Choice`, `curtailed` — carry theirs.

| Term | Meaning |
| --- | --- |
| **Seating** | Who occupies each of the two seats for the current game — a person, a tier, *0008*'s expert or *0012*'s master — and each seat's simulations setting ([W6-44]). |
| **Request** | One `(position, options)` sent to the worker, and the `Choice` it returns. |
| **Generation** | A counter incremented whenever a game is dealt or the seating changes. A response whose generation is not current is stale ([W6-16]). |
| **Thinking** | A request is outstanding. The view model says so ([W6-19]); nothing else infers it. |
| **Estimator** | The seat whose request produced the current `lastChoice`, and the level that seat held when the request was made ([W6-56]). |
| **Estimate** | The published reading of the estimator's `lastChoice.value`, per seat ([W6-55]). |
| **Record** | `history`: one `PlyRecord` per ply of the game in progress ([W6-67]); and the dialog that shows it ([W6-71]). |
| **Log** | The record's table, one row per ply and one per round scored ([W6-74]). |

## Data model

Added to the view model of [0003 U3-6]:

```ts
/** *(Added by [0008 A8-33] and [0012 T12-18].)* A tier of `bot`, the expert of *0008*, or the master of *0012*. */
type Level = Tier | 'expert' | 'master';

interface Seating {
  /** `null` is a person; a level is the computer at that strength. */
  players: [Level | null, Level | null];
  /** *(Added by [0012 T12-19].)* Each seat's simulations setting, read only for a master seat [W6-44]. */
  simulations: [number, number];
}

type Thinking = { seat: Player } | null;

interface ViewModel {
  // …every field 0003 declares, unchanged…
  seating: Seating;                 // [W6-2]
  thinking: Thinking;               // [W6-19]
  /** The last search's own report. Read by the state module alone, to derive `estimate` [W6-25]. */
  lastChoice: Choice | ExpertChoice | MasterChoice | null;  // [W6-25]
  /** What the last computer to move reckoned, per seat; the only rendering of `lastChoice` [W6-55]. */
  estimate: Estimate | null;        // [W6-55]
  /** *(Added for intent 0014.)* Every ply of this game, in order; a fresh array each ply [W6-67]. */
  history: readonly PlyRecord[];    // [W6-67]
}

/** *(Added for intent 0014.)* One ply of this game [W6-68]. Plain data, replaced never mutated. */
interface PlyRecord {
  /** 1-based. */
  ply: number;
  /** The engine's round index when the ply was played. */
  round: number;
  seat: Player;
  action: number;
  level: Level | null;
  /** The reply's report as it crossed the seam; `null` for a person. */
  choice: Choice | ExpertChoice | MasterChoice | null;
  /** [W6-56]'s reading of `choice.value`; `null` for a person. */
  estimate: Estimate | null;
  /** The round's record when this ply resolved a round [0003 U3-82]. */
  scoring: RoundScoring | null;
}

/** *(Added for intent 0012.)* Indexed by seat: `[p]` is seat `p`'s side of it. */
type Estimate =
  | { kind: 'chance'; by: Player; level: 'expert' | 'master'; chance: [number, number] }
  | { kind: 'lead'; by: Player; level: Tier; lead: [number, number]; decided: Player | null };
```

The worker protocol, both directions structurally cloneable ([0001 E1-52], [0004 B4-40]):

```ts
type ToWorker =   // a master request carries its seat's setting [W6-44]
  | { generation: number; position: AzulJSON; tier: Tier | 'expert' }
  | { generation: number; position: AzulJSON; tier: 'master'; simulations: number };
type FromWorker =
  | { generation: number; ok: true;  choice: Choice | ExpertChoice | MasterChoice }
  | { generation: number; ok: false; message: string };
```

## Behaviour

### Choosing an opponent

- **[W6-1]** The interface MUST offer a seating choice: two people (which is 0003's game,
  unchanged), a person against a computer, or two computers ([W6-9]). It MUST offer each tier of
  [0004 B4-32] by a name a player can act on, and MUST NOT present them as numbers.

  *(Extended by [0008 A8-33].)* It MUST also offer `expert` as a fourth difficulty after `sharp`,
  if and only if the committed `packages/ai-bot/gate/baseline.json` records `passed: true`. The
  test reads that file. Intent 0006 asked for a learned opponent that ships only if it wins clearly
  more often than our hardest setting, so what decides whether the setting exists is the gate's
  recorded answer, not a flag anyone can set.

  *(Extended by [0012 T12-18].)* It MUST always offer `master`, last, as [W6-43] says.
- **[W6-2]** The seating MUST be a published view-model field, and MUST be the only thing that
  decides whether a seat's moves come from the worker.
- **[W6-3]** Changing the seating MUST start a new game with a freshly generated seed, per
  [0003 U3-13] and [0003 U3-47]. *(Extended by [0012 T12-19]: so does changing a seat's
  simulations setting, [W6-44].)* *(Amended by [W6-49]: a seating is changed by committing the
  new-game sheet, and the deal it starts takes the sheet's deal number when one was entered
  ([0003 U3-104]). Choosing in the sheet changes nothing until then.)*

  *Rather than swapping an opponent into a game in progress. [0003 U3-65] says the position only
  ever moves forward from a `newGame`, and a game half-played by a person and half by a program is
  a position whose history no longer describes a match — which is exactly what the seed in
  [0003 U3-14] is for showing.*

- **[W6-4]** The seating MUST be carried in the URL beside the seed, and a URL carrying both MUST
  reproduce the same deal and the same seating ([0003 U3-16]), discarding a malformed value the way
  [0003 U3-13] discards a malformed seed. *(Extended by [0008 A8-33]: the parameter accepts
  `expert` exactly when [W6-1] offers it — a setting the interface does not offer is not one a URL
  may name, or a link would seat an opponent nobody can choose.)* *(Extended by [0012 T12-19]:
  each seat's simulations setting travels beside it as `p1Simulations` and `p2Simulations`,
  [W6-44].)*

  *Which makes something new true and worth having: because [0004 B4-30] makes the bot
  deterministic, a seed plus a seating plus the person's own moves reproduce the **whole game**,
  the opponent's play included. That is intent 0003's "a surprising choice can be looked at again
  afterwards", and it is only reachable from the interface if the URL carries the seating too.*

- **[W6-5]** A person MUST be able to occupy either seat. The computer MUST NOT be fixed to seat 1.

- **[W6-54]** A page whose URL carries no seating, or one [W6-4] discards, MUST open with a person
  as Player 1 and `master` as Player 2, at the default simulations setting of [W6-44]. A URL that
  names a seating, `human-human` included, is unaffected.

  *Hot seat was the default until the client was published, because it was the first game there
  was. Intent 0003 gives the reason to change it: "the main reason anyone opens a board game
  implementation alone is to play against something", and someone following a bare link is
  almost always alone. `master` because it is the opponent we trained and the strongest we offer;
  the person as Player 1 because Player 1 opens, so the board waits for them rather than starting
  with a search. The cost is that a bare link now loads the master's worker and payload on the
  person's first move. Spec 0012's promise that a game without a `master` seat never loads it still
  holds, and `?seating=human-human` is still the link for two people.*

### The new-game sheet

*Added for intent 0011 — A table, not a page, which moved the seating out of the play area
([0003 U3-96]). A seat change ends the game in progress, so the choices are gathered in one place
and take effect together, when the player says so — and then the first deal is the one they
chose, not one dealt on the way to it.*

- **[W6-49]** The new-game control of [W6-23] MUST open a **new-game sheet**: a modal dialog named
  `New game`, rendered only while open — a closed sheet leaves no controls in the document, so
  [0003 U3-59]'s measure of every control is not taken over hidden ones. While it is open the page
  beneath is inert, focus moves into it, and focus returns to the control that opened it when it
  closes. The game beneath carries on: a computer to move keeps thinking and may move.
  - It opens **staged** with the current seating, both simulations settings and an empty deal
    number. Everything chosen in it is staged, and the view model is untouched until it is
    committed.
  - **Deal** commits it: one deal ([0003 U3-5]) with the staged seating and settings and the
    staged deal number, or a fresh seed when that is empty ([0003 U3-104]). A seating that equals
    the current one still deals — the sheet is how a new game is started, with or without a change.
  - **Close**, <kbd>Escape</kbd> and a press on the page outside the sheet discard every staged
    choice and leave the game as it was.
  - The sheet says, beside Deal, that dealing ends the game in progress.

- **[W6-50]** The sheet MUST show one card per seat — `Player 1` and `Player 2` — each naming who
  is staged there in the words of [W6-51], and saying of Player 1 that it opens the game. Choosing
  a card makes it the seat being edited, and the cards say which it is with `aria-pressed`. A
  **Swap** control MUST exchange the two seats' staged levels and simulations settings, so who
  opens can be chosen without re-choosing anyone ([W6-5]: Azul is not seat-symmetric).

- **[W6-51]** For the seat being edited the sheet MUST offer the choices of [W6-1] as one radio
  group named `Player 1 is` or `Player 2 is`: a person, then each level in [W6-1]'s order, each
  with a line saying what it is. The words are these, and none of them ranks one level above
  another or states a number ([W6-1], [W6-24]):

  | Choice | Name | Its line |
  | --- | --- | --- |
  | a person | `A person` | `Pass the device between turns` |
  | `easy` | `Gentle` | `Looks only at its own move` |
  | `steady` | `Steady` | `Looks at your reply, and its answer to it` |
  | `sharp` | `Ruthless` | `Looks as far ahead as it can, and times the round's end` |
  | `expert` | `Expert` | `A published player, learned rather than written` |
  | `master` | `Master` | `Taught itself by playing itself` |

  Each line is a fact about how the player is built — [0004 B4-33] through [0004 B4-35],
  intent 0006, intent 0009 — and not a claim about who beats whom: that is measured, it changes
  when `sharp` does ([0011 Z11-63]), and a sentence in a menu would not change with it. A board
  still names its seat as `Computer — gentle` and so on (`LABELS`); the sheet's shorter names
  are its own.

- **[W6-52]** When a game ends, the final result MUST offer three things beside the new-game
  control: **Rematch**, which deals at once with the current seating and a fresh seed; **Replay
  this deal**, which deals at once with the current seating and the current seed
  ([0003 U3-104]); and **Change seats**, which opens the sheet of [W6-49]. Each is a new game
  under [W6-13] and [0003 U3-83].

### The turn loop

- **[W6-6]** After every publish, if the game is not terminal and the seat to move is a tier, the
  interface MUST issue exactly one request for that position. It MUST also issue one for the
  **opening** position, which no publish follows.

  *The opening is a separate clause because it is a separate code path and was missed once: dealing
  a game publishes nothing, so a loop that only runs after a publish never starts. Issuing it a
  task later rather than synchronously is what lets the board paint first, and what leaves room for
  [W6-18]'s seam to be substituted before the first request.*
- **[W6-7]** There MUST be at most one request outstanding. A second MUST NOT be issued until the
  first has resolved or been abandoned ([W6-16]). *(Extended by [0012 T12-23]: across both
  workers, [W6-48].)*
- **[W6-8]** A `Choice` that arrives for the current generation MUST be submitted through
  `submit(choice.action)` — the same path a person's move takes ([0003 U3-18], [0003 U3-31]) — and
  MUST NOT reach the state by any other route.
- **[W6-9]** When both seats are tiers the loop MUST continue until the game is terminal, with
  every ply published as it is made.
- **[W6-10]** The loop MUST NOT run a search on the main thread, in any seating, ever.

### The worker

- **[W6-11]** The search MUST run in a dedicated worker, constructed from a module URL relative to
  the interface's own source. It MUST be the only thing in the client loaded at run time.
  *(Widened by [0012 T12-21]: one of two dedicated workers. A `master` seat's search runs in the
  master worker of [W6-46], every other level's in the first, and together they are the only
  things loaded at run time.)*
- **[W6-12]** The worker's module graph MUST reach `bot`, `ai-bot` and `engine`, and MUST NOT reach
  anything in `src/components/` or the state module. [W6-31]'s clause covers `ai-bot` as it covers
  `bot`.

  *Reachability rather than a list of imports, because the worker itself now imports neither
  player: which one answers a request is a decision, and it lives in a module the fast suite can
  call without a `Worker` ([W6-40]). Both halves of this requirement were already about what is
  reachable; only the first half was written as if it were about import statements.*

  *(Widened by [0008 A8-33].)* The worker's bundle therefore carries the expert's weights — about
  630 KB, which MUST stay under 1 MB — whatever setting it runs. Intent 0006's "plays exactly as
  it did before" is about play, and this cost to loading is accepted here, in writing.

  *(Extended by [0012 T12-21].)* The first worker's graph MUST NOT reach `alphazero-bot/web`,
  whose payload is the master worker's alone ([W6-46]); that bundle MUST stay under 5 MB.
- **[W6-13]** The worker MUST be created lazily — not at all in a two-person game — and MUST be
  terminated when the seating no longer needs it and when a new game is dealt. *(Widened by
  [0012 T12-21]: both workers, each created lazily, and both terminated on every deal.)*

  *Dealing is the one place both happen: a seating change deals ([W6-3]), so terminating on every
  deal covers both clauses. For a while nothing did. The comments said the worker ended with its
  game and [W6-40] was argued from it, but only the fast suite's seam substitution ever terminated
  anything, so a New Game queued its request behind the old search and the expert's sessions ran
  on into every later game. Every test of this requirement injected a seam, and none of them
  counted terminations.*
- **[W6-14]** The message in each direction MUST be exactly `ToWorker` / `FromWorker` above. The
  main thread MUST NOT send an `AzulState`, and the worker MUST NOT return one.

  *The barrier of [0004 B4-5] and the transport are the same object here: `postMessage` structurally
  clones, `AzulJSON` reports the bag as counts ([0001 E1-52]), and so the bag's order cannot cross
  even by accident. Intent 0003's "no private information" is enforced by the boundary rather than
  promised by the bot.*

- **[W6-15]** The worker MUST catch a throw from `chooseMove` and reply `{ ok: false, message }`,
  and the main thread MUST then throw rather than continue. A silent fallback move MUST NOT exist. *(Extended by [0008 A8-33]: a throw from `createExpert` or from a session's `choose` is caught and reported the same way. Extended by [0012 T12-22]: so is a rejection from `createMaster` or a throw from a `Master`'s `choose`.)*

  *[0003 U3-20]'s discipline, one boundary further out. A bot that cannot choose a move is a defect,
  and a client that quietly plays something else hides it in the one place nobody would look.*

- **[W6-16]** A response whose generation is not current MUST be discarded without submitting. A
  new game or a seating change MUST increment the generation before the worker is asked anything
  else.
- **[W6-17]** A `Choice` reporting `curtailed` ([0004 B4-29]) MUST still be submitted. It is a
  legal move chosen by a shortened search, not an error.
- **[W6-18]** The worker seam MUST be injectable, so the fast suite can substitute a chooser that
  answers immediately. The injected seam MUST be the same interface the real worker implements.

  *A requirement about testability, stated because it is load-bearing rather than convenient: jsdom
  has no `Worker`, so without this seam every requirement in this document would fall to the slow
  browser lane of [0003 U3-73], and [W6-29]'s property test would not exist.*

  *Substituting the seam MUST NOT do anything else — in particular it MUST NOT start the turn loop.
  An implementation that did hid a real defect for as long as it existed: the opening request of
  [W6-6] was missing altogether, so a page loaded with the computer on seat 0 sat still forever,
  and every test in the fast suite passed anyway because each one injected a seam and injecting
  started the loop. Only [W6-30]'s lane, which injects nothing, could see it. A seam that changes
  behaviour when it is substituted is a seam that tests something other than what ships.*

- **[W6-42]** The real seam MUST deliver each reply only to the request it answers: a reply MUST
  NOT settle a request carrying a different generation, and a reply nobody is waiting for MUST be
  dropped. The fast suite MUST exercise the real seam itself, against a stand-in `Worker`, with
  two requests outstanding at once.

  *Added after a freeze. The real seam put one listener per request on one shared worker, each
  settling on the first reply of any kind. New Game mid-search left two requests on the worker;
  the old reply settled both, so the new request got a stale generation and was dropped, and its
  own reply then arrived to nobody. `thinking` stayed set and the computer never moved again.
  [W6-13] now keeps two requests off one worker in the shipped client, and this requirement keeps
  that from being the only thing standing between the player and the freeze.

  *(Extended by [0012 T12-23]: a reply from either worker settles only a request that worker was
  sent, [W6-48].)* The fast suite
  cannot see any of it through [W6-18]'s injected seam, which answers each request by its own
  resolver and so cannot cross its wires.*

### While it thinks

- **[W6-19]** `thinking` MUST be non-null exactly while a request is outstanding, and MUST name the
  seat being thought for. Nothing else may be used to infer that a search is running.
- **[W6-20]** The interface MUST show that the computer is thinking, and MUST announce it in the
  live region of [0003 U3-56], naming the seat.
- **[W6-21]** The indicator MAY be delayed by up to 200 ms so a fast answer does not flash, and
  MUST NOT persist after the response arrives. It MUST NOT be shown when no request is outstanding.

  *The delay is not taken. It would need `thinking` to carry when the request started, and the
  flash it prevents does not occur: `easy` is the only tier fast enough to cause one and it is well
  under a frame. If a tier is ever added that lands in the awkward middle, this is where the
  permission already is.*

  *This is the whole of intent 0003's "the interface can say 'thinking…' honestly": shown when it
  is thinking and at no other time. A delay before showing it is still honest — it is thinking
  throughout — where a minimum display time after the answer would not be.*

- **[W6-22]** Every **move** control of [0003 U3-79] MUST be unavailable while the seat to move is
  a tier, under [0003 U3-29]'s discipline: present, focusable, carrying `aria-disabled`, doing
  nothing when activated. It MUST NOT be removed or `disabled`.
- **[W6-23]** The new-game control MUST remain available throughout, including mid-search. It is
  the player's way out of a long think, and [W6-13] MUST terminate the worker when it is used.
  *(Amended by [W6-49]: the control opens the new-game sheet, and the sheet's **Deal** control is
  the one that deals. Both stay available mid-search, and [W6-13] applies to Deal.)*
- **[W6-24]** The interface MUST NOT show the depth reached, a node count, a simulation or root-visit
  count, or any ranking or commentary on a move — the bot's or the player's. A choice's value
  MUST NOT be shown except as the estimate of [W6-55], in the form [W6-58] gives it. Intent 0003
  rules out explaining moves; [0003 U3-30] already rules out judging one before it is made, and
  this extends it to after. *(Amended for intent 0012: the value was forbidden outright; the
  estimate is now its one permitted rendering, and it is about the position the computer's move
  left, never about a move.)* *(Amended for intent 0014: inside the game's record, and only
  there, a computer ply's row MAY show what its reply reported — the depth, the node count, the
  simulation and root-visit counts, the `complete` and `curtailed` flags and the raw value — in
  the forms [W6-76] gives them. Everywhere else this requirement stands as written ([W6-80]), and
  the record ranks and comments on no move either.)*
- **[W6-25]** `lastChoice` MAY be published, and MUST NOT be rendered except through `estimate`
  ([W6-55]): no module under `src/components/` may read `lastChoice` at all. Every other field of
  a `Choice`, `ExpertChoice` or `MasterChoice` stays unrendered ([W6-24]).

  *(Unchanged by [0008 A8-33], and now covering `ExpertChoice.value` too: a number in [-1, 1] from
  the seat's perspective rather than points, which is if anything easier to mistake for a verdict
  on a move. And by [0012 T12-24], `MasterChoice.value`, which is the same kind of number.)*
  *(Amended for intent 0012: both values now reach the screen, but only as [W6-56] reads them —
  a chance for those two, a lead in points for a tier — and only through the state module, so a
  component cannot reach a depth or a visit count by the same road.)* *(Amended for intent
  0014: the record of [W6-67] carries each reply's `Choice` in `history`, which the state module
  publishes, and the record's log renders its fields as [W6-76] allows. That is the one road to
  them; the rule that no component reads `lastChoice` stands.)*

### Responsiveness

- **[W6-26]** The main thread MUST remain responsive throughout a search: the board scrolls,
  controls take focus, and the new-game control works. This is intent 0003's "nothing freezes", and
  [W6-10] is what makes it achievable rather than aspirational.

  *(Unchanged by [0008 A8-33], and applying to `expert`: however long it thinks, the page stays
  alive. Intent 0006 puts speed out of scope and exempts that setting alone from intent 0003's "a
  couple of seconds at most", so this is the one performance promise it does make.)* *(And to
  `master` at any simulations setting, [0012 T12-25]'s machine-of-record budget aside.)*
- **[W6-27]** A ply submitted from a worker response MUST reach the next paint within the same
  budget a person's ply has ([0003 U3-67], 50 ms) — measured from the response, not from the
  request.

### The estimate

*Added for intent 0012 — How the opponent sees it. Every opponent rates the position before it
moves and the interface threw the rating away; now it shows it, after the move, as the opponent's.
Nothing new is computed: the value already crosses the boundary in `lastChoice`, and these
requirements are about reading it honestly.*

- **[W6-55]** The view model MUST carry `estimate: Estimate | null`, of the shape in *Data model*,
  indexed by seat: `chance[p]` and `lead[p]` are seat `p`'s side of the estimate, so each board
  reads its own entry and no component negates or subtracts anything. `by` is the estimator's seat
  and `level` the level it held; `kind` is decided by that level alone — `'chance'` for `expert`
  and `master`, `'lead'` for a tier of `bot` — and never by the shape of the reply.
- **[W6-56]** `estimate` MUST be derived in the state module from `lastChoice.value` and the
  estimator, and from nothing else. The estimator's seat and level MUST be captured from the
  request when it is made — the seat is the position's `currentPlayer`, the level is its `tier` —
  and MUST NOT be re-derived when the reply arrives, when the move is submitted or when a later
  view is built. With `v` the value and `s` the estimator's seat:
  - **chance** (`expert`, `master`; `v` in [-1, 1] for the seat to move, a draw valued as 0):
    `chance[s] = clamp(round(50 × (v + 1)), 0, 100)`, rounding halves up, and
    `chance[1 − s] = 100 − chance[s]`. The other seat's is derived, never rounded on its own.
  - **lead** (`easy`, `steady`, `sharp`; `v` in points for the seat to move, [0004 B4-11]): when
    `|v| < WIN / 2` ([0004 B4-13]), `lead[s]` is `v` rounded to a whole point, halves away from
    zero, and `decided` is `null`. When `|v| ≥ WIN / 2` the search has reached a finished game and
    `v` is `±WIN` plus the margin it foresees: `decided` is the seat whose win it foresaw — `s`
    when `v > 0`, `1 − s` when `v < 0` — and `lead[s]` is that margin, `v − WIN` or `v + WIN`,
    rounded the same way. In both, `lead[1 − s] = −lead[s]`, and a zero is
    `0`, never `-0`. `WIN` is `bot`'s constant; the state module may not import `bot` ([W6-31]),
    so it holds a copy that a test pins to `bot`'s.
  - A chance MUST NOT be converted into points, nor a lead into a chance.
- **[W6-57]** `estimate` MUST change only on the publish that carries a computer's ply — the
  `submit` of a reply's action ([W6-8]) — and MUST then describe that reply. Every other publish
  MUST carry the estimate it found: a person's ply, the publish that marks `thinking`, a round
  transition, the end of the game, and a failed reply ([W6-15]). Every deal MUST clear it, whatever
  starts the deal ([W6-3], [W6-49], [W6-52]), and a stale reply ([W6-16]) MUST NOT set it. So:
  null until the first computer move of a game; never set in a game of two people; and with two
  computers, each move brings its mover's own estimate, in its own kind.

  *A person's move leaves it standing because nothing has rated the position since — and rating it
  would mean thinking on the person's turn, which intent 0012 rules out.*
- **[W6-58]** While `estimate` is set, each board MUST show its own seat's side of it beside that
  board's score, in the board's header, in these words:

  | Kind | Seat's entry | Shown |
  | --- | --- | --- |
  | chance | `c` | `c% to win` |
  | lead, not decided | `l > 0` / `l < 0` / `0` | `Ahead by l` / `Behind by −l` / `Even`, with `point` or `points` |
  | lead, decided | the seat is `decided` / is not | `A win by l` / `A loss by −l`, with `point(s)`; `A win on the tie-break` / `A loss on the tie-break` when `l` is 0, which only the engine's tie-break on completed rows can decide ([0001 E1-39]) |

  and, on both boards, an attribution saying whose estimate it is and when it was taken: `as
  <name> saw it on its move`, where `<name>` is the estimator's level in the board's own words
  (`gentle`, `steady`, `ruthless`, `expert`, `master`, as `LABELS` names them) — prefixed
  `Player N's` when both seats are computers, so two `master`s are told apart. Nothing else of the
  choice is shown ([W6-24]).

  That sentence — the seat's side and the attribution — MUST be the estimate's text on every
  board in every arrangement, for assistive technology ([W6-59]). What is **drawn** depends on the
  room the arrangement gives the board ([0003 U3-95], [0003 U3-103]), in one of two forms, and a
  board shown small draws neither:

  | Board | Drawn |
  | --- | --- |
  | `wide` | The sentence itself, whole, on a line under the header's row. |
  | docked (`side`, `stack`) | Two short lines in the row's free room beside the score: the **short value** over the estimator's **short name**. |
  | shown small (`side`, `stack`) | Nothing. The sentence is the board's text, visually hidden, and takes no room in the row, whose name, pill and score are drawn exactly as they were before the estimate existed. |

  The short value is `c%` for a chance; `+l pt`, `−l pt` or `even` for a lead; `win` or `loss`
  for a decided one — `pt` because the header already shows the round's score change as a bare
  signed number ([0003 U3-43]), and a lead must not be read as one. The short name is the level's
  word (`ruthless`, `master`), or `P1 master` / `P2 master` when both seats are computers. The
  compact form MUST be hidden from assistive technology, since the sentence is already there; and
  neither drawn form MAY wrap, end in an ellipsis, or overflow its header, at 390 × 844 and
  844 × 390 as at any other size.

  *A small board's row is its player's name, and the name is worth more there than a number: the
  docked board beside it carries the estimate for both seats, from its own side.*

  *Whose and when, every time, because a chance beside a score is otherwise easy to read as a fact
  about the position, or as a second score. The decided form is the tier's own reading of
  [0004 B4-13]: `WIN` is a flag its search raises on reaching a finished game, and showing it as a
  lead of a million points would be a number nobody reckoned.*
- **[W6-59]** The estimate MUST be plain text inside its board's region, read with the board as
  the score is: no `role="status"`, no `aria-live`, and no part of [0003 U3-56]'s announcement.
  A board in the shown configuration ([0003 U3-91]) shows it the same way, and it MUST NOT be or
  contain a control.
- **[W6-60]** In a game with a computer seat, each `wide` and docked board MUST hold room for the
  estimate from the deal on, so that its appearing, changing and clearing never changes the size
  of the board ([0003 U3-99]'s discipline for the strip beneath it). A board shown small MUST hold
  none: [W6-58] draws nothing there. In a game of two people no board holds that room, and nothing
  of the estimate is rendered.
- **[W6-61]** Showing the estimate MUST cost the game nothing: no request is issued for it, the
  requests and replies are exactly [W6-14]'s, the same deal and seating produce the same requests
  as before it existed, and nothing in `bot`, `ai-bot`, `alphazero-bot` or either worker changes
  for it.

### The record

*Added for intent 0014 — The game's record, for the curious. The estimate of [W6-55] is one number
about the latest computer move; the record keeps every ply of the game, and for each computer ply
everything its reply carried, behind a control that is closed by default. Nothing new is computed:
each figure is one the game already keeps or a reply already brought across the seam. The record
has two halves — the log, specified here, and the graph, specified in its own section. This
section owns the field, the control, the dialog and the log.*

- **[W6-67]** The view model MUST carry `history: readonly PlyRecord[]`, of the shape in *Data
  model*: one record per ply of the game in progress, in the order played. `submit` MUST append
  the ply's record in the same publish that carries the ply — one `setView` per ply, as
  [0003 U3-42] requires — and MUST do so by publishing a fresh array, never by pushing onto the
  one the previous view model holds, so that a view model published earlier still says what it
  said ([0003 U3-21]). A record, once published, MUST NOT be mutated. Every deal MUST clear it to
  an empty array, whatever starts the deal ([W6-3], [W6-49], [W6-52]), beside the resets
  [0003 U3-83] lists. No other publish changes it: the publish that marks `thinking`, a failed
  reply ([W6-15]) and a stale one ([W6-16]) all carry the array they found.
- **[W6-68]** Each record MUST hold, for its ply:
  - `ply`: its position in the game, from 1;
  - `round`: the engine's round index ([0001 E1-35]) of the position the ply was played from —
    before any round it resolved;
  - `seat`: the seat that was to move, which is the position's `currentPlayer` and not who chose
    the action ([0003 U3-31]);
  - `action`: the action submitted, as `lastMoves` records it ([0003 U3-101]);
  - `level`: what that seat held in the seating ([W6-2]), `null` for a person;
  - `choice`: for a ply submitted from a reply ([W6-8]), the reply's `Choice`, `ExpertChoice` or
    `MasterChoice` as it crossed the seam, unaltered, with no field added or dropped; otherwise
    `null`;
  - `estimate`: for such a ply, `estimateOf(choice.value, seat, level)` — [W6-56]'s reading, with
    the estimator's seat and level as [W6-56] captures them from the request; otherwise `null`;
  - `scoring`: the `RoundScoring` that `applyExplained` returned for this ply when it resolved a
    round ([0007 S7-1]) — the same record [0003 U3-82] publishes; otherwise `null`.

  The choice reaches the record from the turn loop, which hands it over beside the action.
  `submit` still takes an action and learns nothing about who chose it ([0003 U3-31]), and a
  person's ply carries `null` because nothing was reported for it.
- **[W6-69]** Keeping the record MUST cost the game nothing, as [W6-61] says of the estimate: no
  request is issued for it, the requests and replies are exactly [W6-14]'s, the same deal and
  seating produce the same requests as before it existed, nothing is computed on a person's ply
  beyond what [0003 U3-101] and [0003 U3-82] already record, and nothing in `bot`, `ai-bot`,
  `alphazero-bot` or either worker changes for it. The record holds only what a reply carried and
  what the published position shows; the bag's order is no part of it ([W6-14]).
- **[W6-70]** The top bar MUST carry a control named `Record`, beside the new-game control, that
  opens the dialog of [W6-71]. It MUST be present in every seating, two people included, from the
  deal on and at the end of a game. It is not a move control ([0003 U3-79]) and, like the
  new-game control, it stays available while a search is in flight ([W6-23]). It is a button with
  `aria-haspopup="dialog"`, reachable by keyboard, and meets [0003 U3-59]'s target size.
- **[W6-71]** The control MUST open a modal dialog named `Game record`, modelled on the new-game
  sheet of [W6-49]:
  - it is rendered only while open, and a closed record leaves nothing in the document but its
    control;
  - while it is open the page beneath is inert, and focus moves into it — to its **Close**
    control — and returns to the `Record` control when it closes;
  - **Close**, <kbd>Escape</kbd> and a press on the page outside it close it, and change nothing
    else;
  - the game beneath carries on: a computer to move keeps thinking and may move, the log gains
    that ply's row while the dialog is open, and a ply arriving while it is open MUST NOT move
    focus ([0003 U3-57] is about the page beneath, which is inert);
  - it holds the graph (*The estimate graph*, [W6-85] onward) above the log, and nothing
    else but its heading and Close.

  It is bounded by the viewport and MAY scroll within itself in both directions; the document
  beneath MUST NOT scroll because it is open.
- **[W6-72]** The record MUST be closed by default, every game, and opening it MUST NOT be kept:
  it is closed when the page loads and whenever a game is dealt, by whatever route. Whether it is
  open MUST NOT be part of the view model, the URL or storage ([0003 U3-15]).

  *The interface offers no deal while the record is open — every control that deals is beneath
  it, and inert — so the deal clause is reached only by code. It is kept so that nothing about an
  open record can outlive the game it was opened on, whatever deals next, and it is kept by the
  record's own emptying: the dialog closes whenever `history` empties after a ply was played. A
  deal before any ply leaves an empty record empty, and cannot be told apart from no deal.*
- **[W6-73]** While the record is closed it MUST change nothing about the document's own scroll
  or layout beyond its one control: [0003 U3-95]'s no-scroll rules, measured with nothing
  expanded, and [0003 U3-58]'s horizontal rule MUST hold at 1280 × 800, 844 × 390 and 390 × 844
  with the control in the top bar.
- **[W6-74]** The log MUST be a table with one row per record, in `history`'s order, under these
  column headers:

  | Header | Cell |
  | --- | --- |
  | `Ply` | the record's `ply`; the row's header cell |
  | `Round` | `round + 1` |
  | `Player` | `Player N` for seat `N − 1`, then who held the seat in parentheses: `Person`, or the level in a board's words as `levelName` gives them ([W6-58]) — `Player 1 (Person)`, `Player 2 (master)` |
  | `Move` | the action in exactly the words a board's strip uses for a last move ([0003 U3-101]), produced by the same function |
  | `Estimate` | [W6-75] |
  | `Search` | [W6-76] |

  Before the first ply the log MUST say `No moves yet` in place of its rows.
- **[W6-75]** For a record with an `estimate`, the `Estimate` cell MUST give both seats' sides,
  Player 1's first, separated by ` / `, each read from its own seat's entry as [W6-58] reads it
  and negating nothing ([W6-55]):

  | Kind | Cell |
  | --- | --- |
  | chance | each side's short value: `62% / 38%` |
  | lead, not decided | each side in [W6-58]'s full words: `Ahead by 2 points / Behind by 2 points`, `Even / Even` |
  | lead, decided | each side in [W6-58]'s full words: `A win by 3 points / A loss by 3 points`, `A win on the tie-break / A loss on the tie-break` |

  The words come from the function the boards use ([W6-58]), so a board and the log cannot word
  the same estimate two ways.
- **[W6-76]** For a record with a `choice`, the `Search` cell MUST give what the reply reported
  besides its action, by the record's `level`, and nothing else of it:

  | Level | Cell |
  | --- | --- |
  | `master` | `S simulations` |
  | `expert` | `S simulations, V root visits` |
  | a tier | `value X points, depth D, N nodes`, then `, complete` when `complete`, then `, curtailed` when `curtailed` |

  Counts are whole numbers grouped by thousands in English (`10,000`). `X` is the raw `value`
  ([0004 B4-11]) from the mover's side: a whole number as itself, grouped; any other to one
  decimal place; with `+` before a positive value and `−` (U+2212) before a negative one, and no
  sign on a value shown as zero. A decided search's value is shown raw too, `WIN` and all
  ([0004 B4-13]): the `Estimate` cell beside it gives the decided reading, and the record is where
  the number itself is read. An `expert` or `master` value is not repeated here: the `Estimate`
  cell is its reading, and [W6-56] is exact for both.
- **[W6-77]** A row for a person's ply MUST leave its `Estimate` and `Search` cells empty. So
  MUST every row of a game of two people, whose log still has a row per ply and the round rows of
  [W6-78].
- **[W6-78]** After the row of a ply whose record carries `scoring`, the log MUST have one more
  row saying `Round N scored`, with `N` the record's `scoring.round + 1`, and each player's score
  as that record states it: `Player 1: B to A; Player 2: B to A`, with `B` the player's
  `scoreBefore` and `A` its `scoreAfterRound`. When the record carries `bonuses`, each player's
  part continues `, bonuses ±T, final F` from that player's `bonuses.total` and
  `bonuses.scoreAfter`. Each seat's figures MUST be read from that seat's entry, and nothing is
  added, subtracted or compared ([0003 U3-84]). The row is one cell spanning the table and is not
  a ply: the `Ply` numbering does not count it.
- **[W6-79]** The log MUST be readable by assistive technology as a table: a `table` with a
  caption, column header cells for [W6-74]'s headers, and each ply row's `Ply` cell a row header.
  Nothing in the dialog is a live region or carries `role="status"`, and the record is no part of
  [0003 U3-56]'s announcement: a row added while the dialog is open is read when it is reached,
  not announced.
- **[W6-80]** Showing the report's fields in the record is the one exception [W6-24] makes for
  them, and it is the record's alone: no other part of the interface renders a depth, a node
  count, a simulation or root-visit count, a `complete` or `curtailed` flag, or a raw value. The
  log and the dialog MUST read the record from `history` and MUST NOT read `lastChoice`
  ([W6-25]).
- **[W6-81]** The record MUST be the same, row for row, whenever the same plies are played with
  the same replies: a record is a function of the deal, the seating, the moves and the replies,
  and holds nothing taken from a clock or from the page. *(So two loads of one link give
  identical records exactly when [W6-4] gives them identical games. A curtailed search
  ([0004 B4-29]) is the clock's, not the record's, and its row says it was curtailed.)*

## Amendments to 0003

Each row is an edit to `spec/0003-web-interface.md`. Identifiers there are append-only, so a
widened requirement is edited in place and a genuinely new one takes the next free number
([0003 U3-82] onward).

| 0003 requirement | Amendment |
| --- | --- |
| [0003 U3-7] | Widen: `ui` may also depend on `bot`, which knows how to play but asks the engine what is legal. The requirement's subject — that `engine` is the only dependency carrying knowledge of *the rules* — is unchanged, and its parenthetical already anticipates this. |
| [0003 U3-7] | *(Widened again by [0008 A8-33].)* `ui` may also depend on `ai-bot`, which, like `bot`, knows how to play and asks the engine what is legal. |
| [0003 U3-74] | Widen the allowlist to `@solidjs/web`, `ai-bot`, `bot`, `engine`, `solid-js`, and assert each of the three workspace packages is a `workspace:` range. *(`ai-bot` added by [0008 A8-33].)* |
| [0003 U3-8] | Widen: a same-origin module worker constructed from `new URL(…, import.meta.url)` is permitted, and is the **only** run-time load. `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, bare dynamic `import()` and absolute URLs stay forbidden. |
| [0003 U3-75] | Amend the source check to match [0003 U3-8] as widened: permit the one worker construction by its exact shape, keep every other clause, and add the clause of [W6-31]. |
| [0003 U3-18] | Widen: `submit` remains the single path and stays synchronous. What becomes asynchronous is *arrival* — the turn loop of [W6-6] — not `submit` itself. |
| [0003 U3-20] | Unchanged, and extended by [W6-15]: a throw from the worker propagates as a throw here. |
| [0003 U3-31] | Unchanged and now load-bearing: it is what lets [W6-8] use one path for both movers. |
| [0003 U3-6] | Extend the view model with `seating`, `thinking` and `lastChoice`. |
| [0003 U3-70] | Extend: the property test also plays complete games with one seat a tier, through the rendered interface, with the injected seam of [W6-18]. |
| [0003 U3-72] | Extend the throwing-stub list to permit the worker construction of [0003 U3-8] as widened, and nothing else. |
| [0003 U3-73] | Extend the browser lane with [W6-30]: the real worker, in a real browser. |
| [0003 U3-47] | Unchanged; [W6-3] and [W6-23] both route through it. |
| [0003 U3-6] | *(For intent 0012.)* Extend the view model with `estimate` ([W6-55]). |
| [0003 U3-30] | *(For intent 0012.)* Unchanged. A note says the estimate of [W6-55] is about a position after a computer's move and never about a move not yet made. |
| [0003 U3-6] | *(For intent 0014.)* Extend the view model with `history` ([W6-67]). |
| [0003 U3-95] | *(For intent 0014.)* Unchanged. The record's dialog ([W6-71]) is a sheet raised, so the no-scroll rule is measured with it closed, and [W6-73] holds the closed record to it. |

- **[W6-28]** These amendments MUST land in `spec/0003-web-interface.md` in the same change as the
  code that needs them. A spec that describes a client that no longer exists is worse than no spec.

## Invariants

- **[W6-32]** At most one request is outstanding at any moment ([W6-7]).
- **[W6-33]** `thinking !== null` if and only if a request is outstanding ([W6-19]).
- **[W6-34]** Every action submitted from a worker response was in `game.legalActions` of the
  position that request carried.
- **[W6-35]** No search has run on the main thread: over a whole game, the main thread's longest
  uninterrupted task stays within [W6-27]'s budget.
- **[W6-36]** The state module has been advanced only by `apply`, from one `newGame`, exactly as
  [0003 U3-65] requires — the opponent changes who calls `submit`, not what a ply is.
- **[W6-62]** Whenever `estimate` is set: of kind `chance`, both entries are integers in
  [0, 100] and `chance[0] + chance[1] === 100`; of kind `lead`, both are integers,
  `lead[0] + lead[1] === 0`, and neither is `-0`.
- **[W6-63]** `estimate` is null in every view model of a game in which no computer has yet moved
  — every view model of a game of two people included.
- **[W6-64]** Whenever `estimate` is set, `estimate.level === seating.players[estimate.by]`, and
  the last ply submitted from a worker reply was `estimate.by`'s.
- **[W6-82]** In every published view model, of `history` ([W6-67], [W6-68]):
  - its length is the number of plies played since the deal, and `history[i].ply === i + 1`;
  - `round` never decreases along it, and each record's `level` is `seating.players[seat]`;
  - for each seat, the `action` of its last record is `lastMoves[seat]` ([0003 U3-101]), and
    `null` there means the seat has no record;
  - `choice` and `estimate` are both `null` or both set, and where set, `estimate` deep-equals
    `estimateOf(choice.value, seat, level)` and `level` is a computer's; in a game played through
    the turn loop, `choice` is set exactly on the plies of computer seats;
  - the `estimate` of the last record that has one deep-equals `estimate` ([W6-55]), and `estimate`
    is `null` when no record has one;
  - the last record with a `scoring` holds the very object `scoring` publishes ([0003 U3-82]), and
    `scoring` is `null` when none has one;
  - the record of the ply that published a non-null `transition` ([0003 U3-42]) is the last
    record, and it carries a `scoring`.

## Verification

- **[W6-29]** The fast suite MUST include a property test that plays complete games through the
  *rendered* interface with one seat a computer and the seam of [W6-18] injected — including one
  run with that seat `expert` ([W6-41]) and one with that seat `master` ([0012 T12-18]) —
  asserting
  [0003 U3-61] and [0003 U3-62] at every human ply, [W6-22] at every computer ply, and [W6-32]
  through [W6-34] throughout. Seeds MUST be recorded and reported on failure, as [0003 U3-70]
  requires.
- **[W6-30]** The browser lane of [0003 U3-73] MUST play, against a **real worker**: at least one
  real ply from a tier, and at least one **complete game** from `expert` ([0008 A8-33]) while
  [W6-1] offers it — skipped, and reported as skipped, while the committed gate withdraws it,
  since a URL may not seat a level the interface does not offer ([W6-4]). It MUST
  assert [W6-26] and [W6-35] by measuring main-thread task durations while a search is in flight.
  *(Extended by [0012 T12-30]: a complete game with `master` on both seats against the real master
  worker, loaded with `p1Simulations=100` and `p2Simulations=200`; and a person-against-`sharp`
  ply that requests nothing of the master worker's chunk.)*

  *Corrected by [0008 A8-33], and the correction is an admission: the first clause used to demand a
  complete game from a tier, and the lane has never played one — three tests, two of which play a
  single ply and the third of which interrupts a search before one lands. Traceability could not
  see it, because [W6-30] is cited by name in every one of them and a clause inside a requirement
  is invisible to a scanner that works in identifiers.*

  *What the requirement should have asked for is what each player makes observable. A tier is
  stateless ([0004 B4-30]): one ply through a real worker proves the wiring, and every further ply
  re-proves it, which is why the fast suite's seam covers the rest. `expert` keeps a search tree for
  the length of a game ([0008 A8-26]), so its sessions, their per-seat lifetime and their end with
  the worker ([W6-40]) only appear over a whole game. That game is now in the lane and is the reason
  the clause could be narrowed honestly rather than quietly.*

  *In the browser lane because it is the only place any of it is real: jsdom has no `Worker`, no
  main thread to block, and no way to tell a search that ran off-thread from one that did not.*

- **[W6-31]** The source check of [0003 U3-75] MUST additionally fail on an import of `bot` from
  `src/components/` or from the state module, so the only thing that can ask for a move is the
  worker seam.
- **[W6-37]** The suite MUST assert [W6-16] by resolving a stale response after a new game and
  checking that no ply was made, and [W6-15] by making the injected seam throw and expecting the
  throw to propagate.
- **[W6-38]** The suite MUST assert [W6-4] by loading a URL carrying a seed and a seating and
  checking both are honoured, and by loading malformed values and checking both are discarded.
- **[W6-39]** Every requirement in this document MUST be either cited by at least one test, by
  identifier, or listed with a reason in the *Traceability exemptions* table, enforced exactly as
  [0003 U3-76], [0004 B4-59] and [0005 M5-30] are.

### The expert

*Added by [0008 A8-33]. `expert` is a fourth difficulty in this interface and not a fourth tier of
`bot`: it is a second package the worker reaches beside the first ([0004 B4-1]), and unlike a tier
it keeps state between requests, which is what these two requirements are about.*

- **[W6-40]** The worker MUST hold at most one `Expert` per seat, created on the first `expert`
  request for that seat, and MUST NOT let one outlive the worker. [W6-13]'s termination on a new
  game or a seating change is therefore also what ends every session. The per-seat logic MUST live
  in a module importable without a `Worker`.

  *A session is one seat of one game ([0008 A8-26]), because the original keeps its search tree for
  the length of a game. Two sessions sharing a table, or one carried into a second game, would make
  [0008 A8-27] false — and the module boundary is what lets the fast suite say so, since jsdom has
  no `Worker` and the alternative is leaving it to the browser lane.*

- **[W6-41]** The fast suite MUST assert [W6-40] with an `expert` on **both** seats: each seat's
  session is asked only about its own seat's positions, and a new game starts with none. [W6-29]'s
  property test MUST also run with one seat `expert`.

  *Two computer seats in one worker is exactly the configuration in which a session would first be
  shared by mistake, and nothing in this suite has ever held state between requests to find out.
  The same reasoning that produced [0001 E1-72].*

### The master

*Added by [0012 T12-18] through [0012 T12-23]. `master` is a fifth difficulty and not a tier of
`bot`: it is the player of *0011*, compiled to WebAssembly, in a worker of its own. Unlike
`expert` it keeps nothing between moves, so it needs no sessions; what it needs is a setting per
seat, and a worker that a game without it never builds.*

- **[W6-43]** The interface MUST always offer `master`, labelled `Computer — master`. In the order
  of [W6-1] it comes last: after `sharp`, and after `expert` when [0008 A8-33] offers that.
  Nothing gates it. *(Intent 0010 drops the pass-or-fail match against `sharp` that 0006's player
  needed.)*
- **[W6-44]** Each seat's simulations setting is part of the seating, and the two are
  independent. A request for a `master` seat carries that seat's setting.
  - Each MUST default to `MASTER_SIMULATIONS.default` ([0012 T12-16]).
  - A new game MUST keep both, as it keeps the seats.
  - Changing either MUST deal a new game with a fresh seed, as a seating change does ([W6-3]) —
    which since [W6-49] means when the sheet that changed it is committed.
  - They MUST be carried in the URL beside `seed` and `seating` ([W6-4]), as `p1Simulations` for
    seat 0 ("Player 1") and `p2Simulations` for seat 1 ("Player 2"). A parameter MUST be written
    only when its seat is `master` and its value is not the default. A value that fails
    `validSimulations` MUST be discarded for the default, the way [0003 U3-13] discards a seed,
    and that does not affect the other seat's.
  - They MUST NOT be written to storage ([0003 U3-15]): they last as long as the page or the URL.

  *Because the master's move is a pure function of position and setting ([0011 Z11-24]), a seed, a
  seating, both settings and the person's moves reproduce the whole game, `master`'s play
  included — [W6-4]'s promise, kept for the new level.*

- **[W6-45]** The master's setting MUST be offered inside the new-game sheet ([W6-49]), beside the
  seat it belongs to, and only while that seat is staged as `master`. *(It was a closed `Advanced`
  disclosure beside the seat selectors; [W6-49] moved both into the sheet.)*
  - It is one range slider and one number input, both bound to the seat's staged setting, so
    moving either moves the other. The slider is coarse and logarithmic — 100 at one end, 200 000
    at the other, with the default reachable exactly — and states its value in words through
    `aria-valuetext` ("10,000 simulations"). The number input sets any value in range exactly,
    which is intent 0010's "set the number themselves"; it is labelled `Player 1: simulations
    per move` or `Player 2: simulations per move`, with `min`, `max` and the staged value. One
    line states the default and the range.
  - A valid value, committed on `change`, MUST stage [W6-44] for that seat alone. An invalid one
    MUST leave both staged settings as they were, restore the input to the seat's staged setting,
    and say why — with the range — in a `role="status"` line inside the sheet. Nothing deals until
    the sheet is committed.
  - It stays available while a search is in flight, as the new-game control does ([W6-23]).

  *A status line of its own rather than [0003 U3-56]'s live region, which is derived from the view
  model alone: a refused entry changes nothing the view model holds, and giving it a place there
  would add state to the state module for a message about a form field.*

- **[W6-46]** `master` MUST run in its own dedicated module worker, `master-worker.ts`,
  constructed by the exact shape [0003 U3-8] permits.
  - It is created lazily, on the first `master` request, and terminated on every deal, as
    [W6-13] terminates the first worker.
  - Its module graph MUST reach `engine` and `alphazero-bot/web`, and MUST NOT reach `bot`,
    `ai-bot`, `src/components/` or the state module.
  - The first worker's graph, the main thread's graph and everything under `src/components/` MUST
    NOT reach `alphazero-bot/web` or its payload, except by a type-only import, which the compiler
    erases. They MAY reach `alphazero-bot/web/settings`.

  *Intent 0010's "only paid for by those who use it", kept simple: the payload is about 3.6 MB as
  base64, and only a worker nobody creates until a seat is `master` ever loads it.*

- **[W6-47]** The master worker MUST hold at most one `Master`, created by `createMaster()` on its
  first request and shared by both seats, and answer its requests in the order they arrive. A
  rejection from `createMaster` or a throw from `choose` MUST be reported as `{ ok: false,
  message }` ([W6-15]). The logic MUST live in a module importable without a `Worker`.

  *One instance for both seats is sound where [W6-40]'s sessions are not: `choose` keeps nothing
  between moves, so sharing it pays for instantiation and the parity check once.*

- **[W6-48]** The real seam MUST route each request to the worker its level runs on. [W6-7]'s
  single outstanding request and [W6-42]'s per-generation reply routing MUST hold **across both
  workers**: a reply from either worker settles only a request that worker was sent. The fast
  suite MUST exercise the real seam against two stand-in `Worker`s, with a `master` seat against
  a tier, across a deal mid-search, asserting that both workers are terminated and that no reply
  crosses.

  *[W6-42] exists because a seam once crossed its wires on one worker. Two workers are a new
  configuration of the same seam, so it gets a case in that configuration.*

- **[W6-53]** The fast suite MUST show, through the rendered sheet: that nothing deals until Deal,
  and that Close and Escape deal nothing and restore nothing they did not change; that Deal is a
  single deal carrying every staged choice, a typed deal number included; that Swap exchanges both
  seats' levels and settings; that the slider and the number input move together and the number
  input's refusal of [W6-45] holds; that the sheet leaves no control in the document when closed;
  and each of [W6-52]'s three offers. Tests that dealt by pressing the new-game control, or by
  changing a seat selector, deal through the sheet instead.

### The estimate

*Added for intent 0012. The estimate is a new reader of `lastChoice` and of `publish`, and both
of the bugs that shaped this document's turn loop ([0003 U3-42] lost to a second publish,
[W6-42]'s crossed replies) were in an old seam that gained a reader. So the tests below are about
the seam as much as the number: on which publish it changes, and on which it must not.*

- **[W6-65]** The fast suite MUST assert, through the injected seam of [W6-18] answering with
  chosen values and through the rendered boards:
  - [W6-56]'s arithmetic on both kinds and from **both** seats — a computer on seat 0 and one on
    seat 1, with a value whose two sides differ (not 0, not a chance of 50) — including the
    rounding edges (`v = ±1`, a chance landing on a half, a lead of a half point, a lead rounding
    to zero from below), and a decided lead each way;
  - [W6-57] in the configuration it reads: the estimate is null at the deal and through the
    computer's first `thinking` publish; set on exactly the publish that submits the reply; equal
    on the person's following ply; equal across a round transition made by the person's ply and
    across one made by the computer's, the transition itself still published ([0003 U3-42]); left
    standing by a failed reply; not set by a stale one; cleared by every kind of deal;
  - a game of two people, played through a round transition, in which `estimate` is null in every
    published view model and no board renders any of it or holds room for it ([W6-60], [W6-63]);
  - two computers with different kinds — a tier and `master` — where each ply's estimate is the
    mover's, in the mover's kind, attributed with `Player N's` ([W6-58]);
  - [W6-59], by finding the estimate inside each board's region by its text, outside every
    `role="status"` and `aria-live` element, and absent from the announcement;
  - [W6-61], by counting exactly one request per computer ply and none on a person's ply over a
    whole game, and by checking each `ToWorker`'s key set against *Data model* — a tier's and a
    `master`'s, `simulations` included;
  - a failed reply from the **other** computer, of the other kind, leaving the standing estimate
    as it was ([W6-57]) — from the same seat and level, a failure that wrote the estimator back
    could not be told from one that left it alone;
  - [W6-62] and [W6-64] over whole games in [W6-29]'s property test, at every published view;
  - [W6-25], by a source check that no module under `src/components/` mentions `lastChoice`;
  - that the state module's copy of `WIN` equals `bot`'s ([W6-56]).

  [W6-60]'s size half MUST be asserted in the browser lane of [0003 U3-73]: a board's box
  measured before the computer's first move and after it is the same. So MUST [W6-58]'s drawn
  forms: at 390 × 844 and 844 × 390, with one computer and with two (then the small board is
  thinking, its pill at its widest), the docked board draws the compact form, on one line per
  part, inside its own box, inside the header, overlapping nothing drawn there and with no text
  wider than its box — on the real estimate and on the widest text the form carries — and the
  small board draws nothing of the estimate, holds no place in its row, and draws its player's
  name.
- **[W6-66]** Each test of [W6-65] that guards a **sign**, a **perspective** or the **standing**
  rule MUST have been seen to fail, under the rules in `CLAUDE.md` (the anchor confirmed to match,
  the mutation made in a scratch copy, the copy's suite run), and each mutation is recorded here
  as [0007 S7-31] records them — the function and the edit, and the test that went red. At least:
  the seat taken from the reply's time rather than the request's; `chance[s]` and `chance[1 − s]`
  exchanged; the lead not negated for the other seat; `WIN` subtracted with the wrong sign; the
  estimate recomputed or cleared on a person's ply; and the estimate cleared on a transition.

  Re-run 2026-10-14 after [W6-58] settled on two drawn forms, against a copy of the worktree
  under this agent's own scratch directory: each anchor asserted to match exactly once and the
  mutation read back from the copy before the run; the fast lane runs `test/estimate.test.tsx`
  and `test/opponent.test.tsx`, the browser lane `test/browser/opponent.test.ts`. Unmutated, the
  copy is green in both (62 passed, 1 skipped; 11 passed, 1 skipped), and its `src` is identical
  to the tree's afterwards. Test names are abbreviated to their identifiers and first words.

  | Mutation (function: edit) | Test that went red |
  | --- | --- |
  | `game.ts` `nextView`: the estimator's seat read when the view is built (`state.currentPlayer`), not captured with the request | `estimate.test.tsx`: [W6-56] [W6-58] *takes the seat from the request*; [W6-57] [W6-63] [W6-58] *is set on the ply…*; [W6-57] [W6-61] [W6-62] [W6-64] *stands across round transitions…*; [W6-57] *stands through a failed reply*; [W6-57] *…from the other seat, of the other kind*; [W6-57] *is not set by a stale reply*; [W6-58] [W6-62] [W6-64] *with two computers…*; [W6-59] *is plain text…*. `opponent.test.tsx`: [W6-29] … *plays through against easy* and *against master* (10 red) |
  | `game.ts` `estimateOf`: `chance[s]` and `chance[1 − s]` exchanged | [W6-55] [W6-56] *gives master and expert a chance…*; [W6-58] *says each kind in its own words*; [W6-57] [W6-63] [W6-58] *is set on the ply…*; [W6-59] *is plain text…* (4 red) |
  | `game.ts` `estimateOf`: `lead[1 − s] = lead[s]`, the lead not negated | [W6-55] [W6-56] *gives a tier a lead…*; [W6-56] *reads a tier that reached the end…*; [W6-58] *says each kind…*; [W6-56] [W6-58] *takes the seat from the request*; [W6-57] [W6-61] [W6-62] [W6-64] *stands across round transitions…*; the stale-reply test and both failed-reply tests; [W6-58] [W6-62] [W6-64] *with two computers…* (9 red) |
  | `game.ts` `estimateOf`: `margin = value + WIN`, `WIN` with the wrong sign | [W6-56] *reads a tier that reached the end…*; [W6-58] *says each kind…* (2 red) |
  | `game.ts` `submit`: the estimate cleared on a person's ply (`estimator = null` when the mover is no computer) | [W6-57] [W6-63] [W6-58] *is set on the ply…, and stands on the person's next*; [W6-57] [W6-61] [W6-62] [W6-64] *stands across round transitions…*; [W6-57] *stands through a failed reply*; [W6-29] *plays through against easy* and *against master* (5 red) |
  | `game.ts` `submit`: the estimate cleared on a round transition (`estimator = null` beside `lastScoring`) | [W6-57] [W6-61] [W6-62] [W6-64] *stands across round transitions…*; [W6-29] *plays through against easy* and *against master* (3 red) |
  | `game.ts` `dispatch`: `estimator = asker` before the `ok` check, so a failed reply records its asker | [W6-57] *stands through a failed reply from the other seat, of the other kind* (1 red). The person-against-`easy` failed-reply test stays green under it, and could not do otherwise: its failed request is the same seat and level as the standing estimate, so the write is of an identical value. That is why the two-computer test exists |
  | `game.ts` `dispatch`: `estimator = null` in the failure branch | both failed-reply tests (2 red) |
  | `App.tsx` `board`: each board handed the other seat's side (`estimateWords(e, 1 − seat, …)`) | [W6-56] [W6-58] *takes the seat from the request*; [W6-57] [W6-63] [W6-58] *is set on the ply…*; [W6-59] *is plain text…* (3 red) |
  | `game.ts` `estimateOf`: the kind read off the value (a tier's value in [-1, 1] taken for a chance) | [W6-55] [W6-56] *gives a tier a lead…*; [W6-56] *reads a tier that reached the end…*; [W6-58] *says each kind…* (3 red) |
  | `App.tsx` `board`: room held in a game of two people too (`estimateRoom={true}`) | [W6-60] [W6-63] *shows nothing, and holds no room, in a game of two people* (1 red) |
  | `Estimate.tsx` `estimateWords`: a lead's short value without its unit (`+1`, not `+1 pt`) — the docked board's short value | [W6-58] *says each kind in its own words* (1 red) |
  | `PlayerBoard.tsx`: room held only once an estimate is set (`when={props.estimateRoom && props.estimate}`), browser lane | [W6-60] *keeps every board the same size…* at 1280 px (1 red). At 390 × 844 it stays green: there the docked form sits within the row's own height, and a small board holds no room to lose |
  | `styles.css`: both small-board rules removed, so a small board draws the compact form as a docked one does, browser lane | [W6-58] [W6-60] *draws the docked form whole, and nothing on a small board…*, all four cases (4 red) |
  | `styles.css`: the small board's estimate left in the row's flow, unclipped (its rule emptied), browser lane | the same, all four cases (4 red). Its box is empty there — the sentence is clipped by its own rule and the compact form not displayed — so what it takes is a gap's worth of the row; the test asks that it be out of the flow, which is what holding no room means for a flex row |

  Two mutations [W6-66] names have no observable form, and are recorded as such rather than
  claimed. Taking the seat when the **reply arrives**, in `dispatch` before `submit`, gives the
  same seat as the request — `state.currentPlayer` has not moved yet — so it is an equivalent
  mutant; the first row takes it at the next point it differs, when the view is built. And
  dropping the deal's `estimator = null` changes nothing, because the deal also clears
  `lastChoice` and the estimate needs both.

### The record

*Added for intent 0014. `history` is a new field on every publish and a new reader of `dispatch`'s
reply, so — as for the estimate — the tests are about the seam as much as the table: which publish
appends, which must not, and whether an old requirement still holds now that something else rides
on the same `setView`.*

- **[W6-83]** The fast suite MUST assert, in `test/record.test.tsx`, through the injected seam of
  [W6-18] answering with chosen choices and through the rendered dialog:
  - [W6-67] in the configuration it reads: `history` is empty at the deal and through the
    computer's first `thinking` publish; gains exactly one record on exactly the publish that
    carries each ply, a person's and a computer's; is a fresh array each time, with the arrays
    published before it unchanged; is unchanged by a failed reply and by a stale one; and is
    cleared by every kind of deal — the sheet's Deal, Rematch, Replay this deal;
  - a round transition made by a computer's ply and one made by a person's, each still publishing
    its `transition` ([0003 U3-42]) in the view model whose last record carries the round's
    `scoring`;
  - [W6-68] field by field, from **both** seats — a computer on seat 0 and one on seat 1 — and
    with each kind of reply: a tier's `Choice`, an `ExpertChoice` and a `MasterChoice`, each
    recorded with its every field and no other;
  - [W6-69], by counting exactly one request per computer ply and none on a person's ply over a
    whole game with the record open, and checking each `ToWorker`'s key set against *Data model*;
  - [W6-70] through [W6-73]: the control present in a game of two people, mid-search and at the
    end of a game; the dialog named, absent from the document when closed, focus moved in and
    returned; Close, Escape and a press outside each closing it; a computer's ply arriving while
    it is open adding its row without moving focus; the dialog closed by a deal made while it is
    open and closed on a fresh mount; and nothing written to the URL or to storage by opening it;
  - [W6-74] through [W6-78], by reading the rendered table: the headers; a person's row and a
    computer's row in each of the three report forms; a tier's value whole, fractional, negative,
    shown as zero and decided; the estimate in each of its kinds and a decided lead each way; the
    round row after its ply, with the seats' figures **different** so a row reading the wrong seat
    cannot pass, and with bonuses on the game's last round; and a game of two people played
    through a round transition;
  - [W6-79], by finding the log by role as a table with its column and row headers, and nothing in
    the dialog with `role="status"` or `aria-live`, and the announcement unchanged by a ply made
    while it is open;
  - [W6-80], by a source check that the record's components do not mention `lastChoice`, and that
    no component outside them renders a report field;
  - [W6-81], by playing one game twice from one seed and seating, with the seam answering both
    alike, and comparing the two records;
  - [W6-82] over whole games in [W6-29]'s property test, at every published view.

  [W6-73] MUST be asserted in the browser lane of [0003 U3-73], at 1280 × 800, 844 × 390 and
  390 × 844, with the `Record` control in the top bar and the record closed.
- **[W6-84]** Each test of [W6-83] that guards a **ply's place** in the record, a **seat**, the
  **clearing** on a deal, or a **field of the report** MUST have been seen to fail, under the rules
  in `CLAUDE.md`, and each mutation is recorded here as [W6-66] records them. At least: a ply
  dropped from the record; the estimate not recorded; the record not cleared on a deal; the dialog
  kept open across a deal; the round row reading the other seat's figures; and a report field left
  out of the `Search` cell.

  | Mutation (function: edit) | Test that went red |
  | --- | --- |
  | *to be filled when the record is built* | |

### Traceability exemptions

| Requirement | Why it is not testable |
| --- | --- |
| [W6-24] | The absence of any commentary anywhere, unbounded as stated — 0003 exempts [U3-30] for the same reason. [W6-31]'s source check and [W6-25]'s cover the decidable part, and [W6-58]'s tests pin the one permitted rendering. |
| [W6-27] | A budget, non-gating for the reason [0003 U3-67] is. |
| [W6-28] | A process promise about what lands in which commit. |

## Open questions

- **Should a person be able to hand their own seat to the computer mid-game** — "play this out for
  me"? [W6-3] says no, because it makes the seed no longer describe the match. But it is the
  natural way to ask the bot what it would have done, and intent 0003's "a surprising choice can be
  looked at again" is close to it. Answering yes means the view model carrying a record of who
  chose each ply, which is a bigger change than it sounds.
- **Does two-computer play ([W6-9]) need a pause or a step control?** As specified it runs to the
  end and the only control is a new game. Watching it to spot bad play — the intent's reason for
  wanting it — probably wants to stop on a particular ply. That is a real feature and it is
  deliberately not here.
- **What should the client do on a device where `sharp` is routinely curtailed** ([0004 B4-29])?
  Nothing, as specified: [W6-17] submits the move and says nothing. The alternatives are telling
  the player their device is slow, or silently demoting the tier, and both are worse than a move
  that took four seconds.

## References

- Intent [0003 — Computer opponent](../intent/0003-computer-opponent.md)
- Intent [0012 — How the opponent sees it](../intent/0012-how-the-opponent-sees-it.md) — the estimate, [W6-55] onward
- Intent [0014 — The game's record, for the curious](../intent/0014-the-games-record-for-the-curious.md) — the record, [W6-67] onward
- Spec [0001 — Engine core](0001-engine-core.md)
- Spec [0003 — Web interface](0003-web-interface.md) — amended here
- Spec [0004 — Computer opponent](0004-computer-opponent.md)
- Spec [0005 — Opponent strength](0005-opponent-strength.md)
- Spec [0012 — Master opponent](0012-master-opponent.md) — the master, [W6-43] through [W6-48]
