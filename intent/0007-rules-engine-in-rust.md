---
title: Rules engine in Rust
author: Gabriel Cangussu
date: 2026-09-25
status: done
depends-on: 0001 — Rules engine
summary: >
  A second, independent copy of the Azul referee written in Rust, which agrees
  with the one we have on every game it is shown, and is fast enough to play
  far more games than the current one can in the same time.
---

# Rules engine in Rust

## The idea

We already have a referee for two-player Azul (*0001 — Rules engine*): it knows every rule,
lists the legal moves, plays them out and keeps score. We want a second one, written in
Rust, that does exactly the same job and gets exactly the same answers.

It is a sibling, not a replacement. The referee we have keeps running the game in the
browser, and nothing that uses it today has to change. The new one is for the work done away
from the page: measuring opponents against each other and replaying games.

## Why

The referee is the thing everything else leans on hardest. The computer opponents ask it
"what happens if I do this?" many thousands of times a move, and the work of measuring one
opponent against another is almost entirely the referee playing games out. That work is
now slow enough to change how we behave: deciding whether the expert setting earns its
place takes the best part of an hour, so we run it less often than we should.

A referee in a language built for this kind of speed could play many more games in the same
time. It would also be a second opinion. Two referees written separately and held to the
same recorded games catch mistakes that one referee checked against itself never will.

## What good looks like

- It passes every check the current referee passes: the same recorded games from the
  original Python program, replayed move by move, with agreement at every step, and the same
  hand-built awkward positions.
- It is clearly faster: many times more positions explored per second than the current
  referee on the same machine, measured, not assumed.
- Tiles are conserved and games are repeatable, exactly as 0001 promises.
- If it comes easily, it can also say how a round was scored, as the current referee does
  for *0004 — Scoring explained*. Nice to have, not a reason to hold it back.

## Constraints

- **Written in Rust.** It lives in this repository, next to the other packages.
- **The same rules and the same judge.** Two players, the base game only, checked against
  the same trusted Python engine the first referee was checked against.
- **The existing referee is untouched.** Nothing about it changes to make the two agree; if
  they disagree and the existing one is wrong, that is a fix to 0001's work in its own right.
- **Deterministic.** The only randomness is the shuffle, and it can be asked to repeat itself.
  Its shuffle does not have to match the current referee's: agreeing on the recorded games
  is the bar, not replaying the same game from the same starting point on both.

## Not in scope

- Running in the browser. Replacing the referee the page uses today, or rewriting the
  interface or either opponent around it, is not planned.
- Rewriting the opponents in Rust. If a faster referee makes that worth doing, it is its own
  intent.
- Three- and four-player games, rule variants, or expansions.
