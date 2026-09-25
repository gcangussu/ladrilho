---
title: Engines checked against each other
author: Gabriel Cangussu
date: 2026-09-25
status: pending
depends-on: 0007 — Rules engine in Rust
summary: >
  Play huge numbers of made-up games through both of our referees at once,
  feeding them the same shuffles and the same moves, and stop at the first
  move where they disagree about anything.
---

# Engines checked against each other

## The idea

Once we have two referees (*0001 — Rules engine* and *0007 — Rules engine in Rust*), each can
check the other. Invent a game: shuffle the bag at random, pick moves at random. Hand the same
shuffles and the same moves to both referees, and after every move ask whether they still see the
same board, the same legal moves and the same score. The moment they don't, one of them is wrong,
and we know the exact move where it started.

This can run for as long as we like, over as many games as we like, without anyone having to
record anything first.

## Why

Today both referees are judged by the same few dozen games recorded from the original Python
program, plus a handful of awkward positions built by hand. That is a good test and a small one.
A mistake that only shows up in a position none of those games reaches passes it, in either
referee.

Two referees written separately in different languages are unlikely to make the same mistake in
the same place. Comparing them directly turns that into a test that can cover millions of
positions, including strange ones that ordinary play almost never reaches.

## What good looks like

- One command runs as many invented games as asked for through both referees and reports either
  "no disagreement" or the first move where they disagreed.
- A disagreement comes with everything needed to reproduce it: the shuffles, the moves, and what
  each referee said. Re-running it gives the same disagreement.
- It can be steered towards unusual play, such as full floors, the bag running out, or games that
  go on for many rounds, not only uniformly random moves.
- It has been seen to catch a real mistake: break one rule in one referee on purpose, and it
  finds the disagreement.

## Constraints

- **Neither referee changes to make this possible.** Both already accept a shuffle from outside;
  that is how this reaches them.
- **The two referees still don't need to deal the same game from the same seed.** The shuffles
  come from this tool, not from either referee.
- **When they disagree, the printed rules decide who is right.** Not either referee, and not the
  original Python program, which can be wrong too. Someone works out what the rulebook says
  should happen in that exact position, and writes down why, before anything is fixed.
- **The answer is kept.** Each settled disagreement becomes a permanent test that both referees
  must pass from then on. If the Python program agrees with the rulebook, the test is recorded
  from it as usual. If it doesn't, we have found a mistake in the program we have trusted all
  along, and we say so plainly rather than copying it.

## Not in scope

- Replacing the recorded games. They remain the everyday check; this finds places to look, and
  the rulebook settles what is found.

## Open questions

- Everything so far treats the Python program as the answer key (*0001 — Rules engine* says a
  rule we can't check against it is probably wrong). If it turns out to be wrong somewhere, how do
  we record the correct answer as a test, when every test we have today is copied from it?
- Which rulebook, exactly? The printed rules leave a few situations unclear, and the publisher's
  clarifications may need to count too.
- Comparing anything but the rules: not speed, and not the computer opponents.
- Running it on every save. It can take as long as it likes, so it is run on purpose.
