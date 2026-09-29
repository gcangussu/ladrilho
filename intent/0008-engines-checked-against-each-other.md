---
title: Engines checked against each other
author: Gabriel Cangussu
date: 2026-09-25
status: done
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
same board, the same legal moves and the same score — and, since both can also say how a round
was scored and describe the board to a computer player, whether those agree too. The moment they
don't, one of them is wrong, and we know the exact move where it started.

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
- Comparing anything but the rules: not speed, and not the computer opponents.
- Long runs on every save. It can take as long as it likes, so it is run on purpose. A short,
  fixed run of a few dozen games does belong in the everyday checks, though — not to find
  anything, but so the tool can't quietly stop working between the times someone runs it on
  purpose, and so "it catches a real mistake" stays shown rather than having been shown once.

## Open questions

- ~~Everything so far treats the Python program as the answer key (*0001 — Rules engine* says a
  rule we can't check against it is probably wrong). If it turns out to be wrong somewhere, how do
  we record the correct answer as a test, when every test we have today is copied from it?~~
  **Answered: still from the Python program, corrected in the open.** Tests are never written
  out by hand. When the program is wrong, the correction is a small, named change to that one
  rule, made to the program while the test is being recorded — the same way the recording
  already reaches in to capture the shuffles. The test then says which corrections were in force,
  and each correction points to the written ruling that justifies it.

  The same position is also recorded *without* the correction, and the two must differ. If they
  ever stop differing — the program's author has fixed it, or the correction no longer lands
  where it was meant to — recording fails loudly, and the correction is retired rather than
  carried along doing nothing.

  Every such ruling is written down in one list: the position, what the rulebook says and why,
  what the Python program does instead, and the correction that makes it right. That list is
  where "we say so plainly" lives, and the program's author is told.

  To make all of this one step rather than a transcription, a disagreement is reported in the
  same form the recording takes in — the shuffles and the moves — so the position can be
  replayed in the Python program directly.
- ~~Which rulebook, exactly? The printed rules leave a few situations unclear, and the publisher's
  clarifications may need to count too.~~ **Answered: in order of authority —** the publisher's
  official clarifications, where one covers the case; then one named printing of the English
  rulebook, cited by section rather than quoted; then, where neither says, a ruling of our own,
  written into the same list as above and labelled as ours, not as the rulebook's.

  This will matter early. Some of what both referees do today sits exactly where the printed
  rules are vague — what happens to the first-player marker on a full floor, how many floor slots
  carry a penalty, and whether a score stops at zero per round or per tile — and those choices
  came from the Python program. The first real disagreement may well land on one of them, and the
  order of authority should be settled before it does, not argued from scratch when it arrives.
