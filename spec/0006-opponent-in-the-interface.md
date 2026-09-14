---
title: Opponent in the interface
author: Gabriel Cangussu
date: 2026-09-06
status: implemented
intent: 0003 — Computer opponent
prefix: W6
depends-on: 0001 — Engine core, 0003 — Web interface, 0004 — Computer opponent
summary: >
  Where the opponent runs and what the player sees while it thinks: choosing an
  opponent, the worker that hosts the search, the thinking state, and what
  happens to the controls during a turn that is not yours. Amends 0003 — Web
  interface, which said it would need amending.
---

# Opponent in the interface

## Scope

Covers the changes to `packages/ui`: the opponent selector, the worker seam, the thinking state,
the turn loop that asks for a move and submits it, and what the board does while a search is in
flight.

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

## Definitions

Terms from *0003* — the view model, `submit`, `publish`, the state module — carry their meaning
there. Terms from *0004* — tier, `Choice`, `curtailed` — carry theirs.

| Term | Meaning |
| --- | --- |
| **Seating** | Who occupies each of the two seats for the current game: a person, a tier, or *0008*'s expert. |
| **Request** | One `(position, options)` sent to the worker, and the `Choice` it returns. |
| **Generation** | A counter incremented whenever a game is dealt or the seating changes. A response whose generation is not current is stale ([W6-16]). |
| **Thinking** | A request is outstanding. The view model says so ([W6-19]); nothing else infers it. |

## Data model

Added to the view model of [0003 U3-6]:

```ts
/** *(Added by [0008 A8-33].)* A tier of `bot`, or the expert of *0008*. */
type Level = Tier | 'expert';

interface Seating {
  /** `null` is a person; a level is the computer at that strength. */
  players: [Level | null, Level | null];
}

type Thinking = { seat: Player } | null;

interface ViewModel {
  // …every field 0003 declares, unchanged…
  seating: Seating;                 // [W6-2]
  thinking: Thinking;               // [W6-19]
  /** The last search's own report, for [W6-25] only. Never rendered as a judgement. */
  lastChoice: Choice | ExpertChoice | null;  // [W6-25]
}
```

The worker protocol, both directions structurally cloneable ([0001 E1-52], [0004 B4-40]):

```ts
type ToWorker   = { generation: number; position: AzulJSON; tier: Level };
type FromWorker =
  | { generation: number; ok: true;  choice: Choice | ExpertChoice }
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
- **[W6-2]** The seating MUST be a published view-model field, and MUST be the only thing that
  decides whether a seat's moves come from the worker.
- **[W6-3]** Changing the seating MUST start a new game with a freshly generated seed, per
  [0003 U3-13] and [0003 U3-47].

  *Rather than swapping an opponent into a game in progress. [0003 U3-65] says the position only
  ever moves forward from a `newGame`, and a game half-played by a person and half by a program is
  a position whose history no longer describes a match — which is exactly what the seed in
  [0003 U3-14] is for showing.*

- **[W6-4]** The seating MUST be carried in the URL beside the seed, and a URL carrying both MUST
  reproduce the same deal and the same seating ([0003 U3-16]), discarding a malformed value the way
  [0003 U3-13] discards a malformed seed. *(Extended by [0008 A8-33]: the parameter accepts
  `expert` exactly when [W6-1] offers it — a setting the interface does not offer is not one a URL
  may name, or a link would seat an opponent nobody can choose.)*

  *Which makes something new true and worth having: because [0004 B4-30] makes the bot
  deterministic, a seed plus a seating plus the person's own moves reproduce the **whole game**,
  the opponent's play included. That is intent 0003's "a surprising choice can be looked at again
  afterwards", and it is only reachable from the interface if the URL carries the seating too.*

- **[W6-5]** A person MUST be able to occupy either seat. The computer MUST NOT be fixed to seat 1.

### The turn loop

- **[W6-6]** After every publish, if the game is not terminal and the seat to move is a tier, the
  interface MUST issue exactly one request for that position. It MUST also issue one for the
  **opening** position, which no publish follows.

  *The opening is a separate clause because it is a separate code path and was missed once: dealing
  a game publishes nothing, so a loop that only runs after a publish never starts. Issuing it a
  task later rather than synchronously is what lets the board paint first, and what leaves room for
  [W6-18]'s seam to be substituted before the first request.*
- **[W6-7]** There MUST be at most one request outstanding. A second MUST NOT be issued until the
  first has resolved or been abandoned ([W6-16]).
- **[W6-8]** A `Choice` that arrives for the current generation MUST be submitted through
  `submit(choice.action)` — the same path a person's move takes ([0003 U3-18], [0003 U3-31]) — and
  MUST NOT reach the state by any other route.
- **[W6-9]** When both seats are tiers the loop MUST continue until the game is terminal, with
  every ply published as it is made.
- **[W6-10]** The loop MUST NOT run a search on the main thread, in any seating, ever.

### The worker

- **[W6-11]** The search MUST run in a dedicated worker, constructed from a module URL relative to
  the interface's own source. It MUST be the only thing in the client loaded at run time.
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
- **[W6-13]** The worker MUST be created lazily — not at all in a two-person game — and MUST be
  terminated when the seating no longer needs it and when a new game is dealt.
- **[W6-14]** The message in each direction MUST be exactly `ToWorker` / `FromWorker` above. The
  main thread MUST NOT send an `AzulState`, and the worker MUST NOT return one.

  *The barrier of [0004 B4-5] and the transport are the same object here: `postMessage` structurally
  clones, `AzulJSON` reports the bag as counts ([0001 E1-52]), and so the bag's order cannot cross
  even by accident. Intent 0003's "no private information" is enforced by the boundary rather than
  promised by the bot.*

- **[W6-15]** The worker MUST catch a throw from `chooseMove` and reply `{ ok: false, message }`,
  and the main thread MUST then throw rather than continue. A silent fallback move MUST NOT exist. *(Extended by [0008 A8-33]: a throw from `createExpert` or from a session's `choose` is caught and reported the same way.)*

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
- **[W6-24]** The interface MUST NOT show the chosen move's value, the depth reached, or any
  ranking or commentary on a move — the bot's or the player's. Intent 0003 rules out explaining
  moves; [0003 U3-30] already rules out judging one before it is made, and this extends it to after.
- **[W6-25]** `lastChoice` MAY be published for diagnostics and MUST NOT be rendered in the
  interface. If it is shown at all it is behind something the shipped client does not offer.

  *(Unchanged by [0008 A8-33], and now covering `ExpertChoice.value` too: a number in [-1, 1] from
  the seat's perspective rather than points, which is if anything easier to mistake for a verdict
  on a move.)*

### Responsiveness

- **[W6-26]** The main thread MUST remain responsive throughout a search: the board scrolls,
  controls take focus, and the new-game control works. This is intent 0003's "nothing freezes", and
  [W6-10] is what makes it achievable rather than aspirational.

  *(Unchanged by [0008 A8-33], and applying to `expert`: however long it thinks, the page stays
  alive. Intent 0006 puts speed out of scope and exempts that setting alone from intent 0003's "a
  couple of seconds at most", so this is the one performance promise it does make.)*
- **[W6-27]** A ply submitted from a worker response MUST reach the next paint within the same
  budget a person's ply has ([0003 U3-67], 50 ms) — measured from the response, not from the
  request.

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

## Verification

- **[W6-29]** The fast suite MUST include a property test that plays complete games through the
  *rendered* interface with one seat a computer and the seam of [W6-18] injected — including one
  run with that seat `expert` ([W6-41]) — asserting
  [0003 U3-61] and [0003 U3-62] at every human ply, [W6-22] at every computer ply, and [W6-32]
  through [W6-34] throughout. Seeds MUST be recorded and reported on failure, as [0003 U3-70]
  requires.
- **[W6-30]** The browser lane of [0003 U3-73] MUST play at least one complete game against a real
  worker running a real tier, and MUST assert [W6-26] and [W6-35] by measuring main-thread task
  durations while a search is in flight. *(Extended by [0008 A8-33]: it MUST also play one complete
  game against a real worker running `expert`, which is the only place the weights are really
  loaded and the only place its thinking is really off-thread.)*

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

### Traceability exemptions

| Requirement | Why it is not testable |
| --- | --- |
| [W6-1] | The naming half is a judgement about words a player can act on; the offering half is asserted by [W6-29] and [W6-38]. |
| [W6-24], [W6-25] | The absence of any commentary anywhere, unbounded as stated — 0003 exempts [U3-30] for the same reason, and [W6-31]'s source check covers the decidable part. |
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
- Spec [0001 — Engine core](0001-engine-core.md)
- Spec [0003 — Web interface](0003-web-interface.md) — amended here
- Spec [0004 — Computer opponent](0004-computer-opponent.md)
- Spec [0005 — Opponent strength](0005-opponent-strength.md)
