---
title: Master thinks as long as it pays
author: Gabriel Cangussu
date: 2026-10-27
status: pending
depends-on: 0010 — Playing the opponent we trained
summary: >
  Let "master" take up to about three seconds a move on our laptop, but only
  where the extra thought wins games; offer a quick choice, a balanced default
  and, if it is shown stronger, a deep one; and in the round before the last,
  let it imagine the coming deal from the tiles left in the bag.
---

# Master thinks as long as it pays

## The idea

*0010 — Playing the opponent we trained* put "master" in the browser and promised that every move
at the default would take under a second on our laptop. That promise was set by what was cheap,
not by what plays well. We now want a looser one: on our laptop, with nothing else running, 19
moves in 20 take at most three seconds, and 99 in 100 at most five.

That is a ceiling, not a target. Master thinks longer only where thinking longer has been shown to
win more games. Where it does not, the default stays where it is, even if that is well under the
ceiling.

There are three choices instead of one default:

- **quick**, which keeps 0010's promise: every move under a second;
- **balanced**, the default, inside the new ceiling;
- **deep**, which may take longer than the ceiling, offered only when it has been shown to beat
  the balanced choice. If thinking longer stops paying, there is no deep choice at all, because
  it would only make people wait.

The advanced setting stays, for anyone who wants a number of their own.

Master also gets better at one moment of the game. At the end of the fourth round it has, until
now, judged the final round without knowing which tiles it will be dealt. That is where it
misjudges most. Now, in the fourth round, it imagines several possible deals of the final round,
drawn from the tiles it knows are left in the bag, plays each a little way forward, and uses what
it sees. It still never looks at the real deal.

## Why

Measured against itself, the trained player gets stronger with more thought, but not without
limit. A short match suggested that ten times 0010's default is clearly stronger, and a hundred
times no stronger than ten, but it was too short to build on: this asks for it to be measured
properly. In the fourth round, more thought stopped paying altogether: the trouble there is not
too little thought, but guessing the final round blind. Imagining the deal gained about 33 rating points, in a match where the player without
it was given more thinking time to make up the difference.

A ceiling of a few seconds is still a comfortable wait in a board game. A person playing at the
table often takes longer.

## What good looks like

- On our laptop, at the default, 19 moves in 20 take at most three seconds, and 99 in 100 at most
  five. No single move takes long enough to look like the page has stopped.
- The default is the cheapest choice that was measured to play as well as anything more
  expensive. If more thought did not pay, the default is unchanged.
- "quick" keeps every move under a second.
- "deep", if it exists, has won a match against the default. If it does not exist, the interface
  offers two choices, not three.
- The three choices are easy to find and pick, and the number underneath them is still there for
  anyone who wants it.
- The same choice plays the same on every machine. A link to a game still brings back the same
  opponent.
- Master never sees what is coming out of the bag. The deals it imagines are drawn from the tiles
  it knows are left, the same ones every time for the same position.
- When training produces a stronger player, the imagined-deal step is set up for it, or left out
  on purpose, before it ships. It is never lost without anyone noticing.

## Constraints

- **The player we trained is still the player we ship.** The imagined deals are worked out by the
  same code that plays, on the same knowledge, in the browser as on our machines.
- **No clock.** How much master thinks is a number, never a time. A slower machine waits longer;
  it does not play weaker.
- **Measured, then promised.** The ceiling is checked on our laptop with nothing else running, by
  timing many moves from real games twice and taking the slower result.
- **Shipping a new player stays routine.** What it costs is a match or two, not a project.

## Not in scope

- Promising any speed on any other machine, as before.
- Imagining deals in any round but the fourth. In earlier rounds there are too many rounds left
  for a guess at one deal to help, and after the fourth there is nothing left to deal.
- Changing how the other opponents play.
