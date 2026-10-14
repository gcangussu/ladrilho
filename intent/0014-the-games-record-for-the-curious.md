---
title: The game's record, for the curious
author: Gabriel Cangussu
date: 2026-10-14
status: done
depends-on: 0012 — How the opponent sees it
summary: >
  Behind a control that is closed by default, keep a move-by-move record of
  the game — every move, and for each of the computer's moves everything it
  reported as it chose — and draw each player's chance over the moves as a
  graph. A feature for the curious, out of the way of everyone else.
---

# The game's record, for the curious

## The idea

*0012 — How the opponent sees it* shows the computer's latest estimate beside the scores. Some
players want the whole story: what was played, move by move, what the computer thought at each
of its moves, and how its view of the game moved as the game went on.

We want a record of the game that stays out of sight until asked for. A control in the top bar
opens it; closed is the default, every game. Open, it may be as big as it needs to be and scroll
both ways, because whoever opened it wants the detail.

It holds two things.

A **log**, one line per move: the round, who moved, and the move in the same words the board
uses. For a move the computer made, the line also carries its estimate from both sides, as 0012
shows it, and everything else the computer reported as it chose and we have been throwing away —
for "master", how many times it looked ahead; for "gentle", "steady" and "ruthless", the lead in
points it reckoned, how many moves deep it saw, how many positions it looked at, and whether the
clock cut it short; for "expert", should it return, what it reports. When a round is scored, the
log says what each player scored.

A **graph** of each player's chance of winning, as the computer estimated it, over the moves of
the game: two lines, one per player, that mirror each other. Where the computer thinks in points
rather than chances, the graph plots its lead instead, and says so; a game with both kinds of
opponent gets a graph of each kind.

## Why

A game against the computer is a conversation nobody is writing down. The record lets a curious
player see where the game turned, go back over a surprising move with the numbers in front of
them, and learn what the computer counts as a swing. It is also the honest companion of 0012:
the estimate beside the score is one number, and a number is easier to trust when you can see the
series it came from.

Nothing here is for most players, which is why it is closed by default and costs nothing to
leave closed.

## What good looks like

- Nothing about the game looks or works differently until the record is opened.
- Open it after a few moves against "master" and you can read each move in order, see its
  estimate at each of its moves and how many times it looked ahead, and see both players' chances
  rise and fall across the moves in the graph.
- Against "ruthless", the lines are leads in points, the log says what it saw and how deep, and
  nobody could mistake the points for a chance.
- In a game between two people the log is still there, with the moves and the round scores,
  and the graph says there is nothing to draw.
- Open the same link twice and the two records are identical, line for line.
- It can be opened and read with the keyboard and with a screen reader, and closed from where
  it was opened.
- The page stays alive while it is open, and the computer keeps playing beneath it.

## Constraints

- **Recorded, not computed.** Every number in the record is one the computer already reported to
  choose a move, or one the game already keeps. Nothing thinks again, nothing on a person's turn,
  and the opponents play exactly as before.
- **Closed by default, every time.** Opening it is a thing you do, not a setting that is kept.
- **Only what crosses the table.** The record holds what the computer reports and the game's
  public position. The bag's order is never in it.
- **Everything the earlier intents promised stays true**: no rule in the interface, no judging a
  move before it is made, no undo, no network, and a new game starts a new record.

## Not in scope

- Keeping the record across a reload, or saving or exporting it. A link to the deal recreates it.
- Estimates on a person's moves. The lines move only where the computer moved.
- Notes, comments, or any analysis of a position by the opponent.
- Showing the record on the board itself; it stays behind its control.
