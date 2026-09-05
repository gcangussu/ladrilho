---
title: Scoring explained
author: Gabriel Cangussu
date: 2026-09-05
status: pending
summary: >
  Show how a score was arrived at — which tiles earned what when a round is
  scored, what the floor cost, and what the end-of-game bonuses came to —
  instead of only showing the number change.
---

# Scoring explained

## The idea

When a round is scored, say what happened: this tile finished a run of three across and two
down, so it was worth five; the four tiles on the floor cost three. At the end of the game,
itemise the bonuses — two rows, one column, no colours — and what each earned.

Today the score simply changes. You can see which tiles arrived on the wall, and you are left
to work out the rest yourself.

## Why

Scoring is the part of Azul people get wrong, and the part they most want to check. A player
who cannot see where the points came from cannot tell a good round from a lucky one, and
learns the game more slowly for it.

It is also the one thing *0002 — Web interface* deliberately could not do. That interface
knows the rules only by asking, and what it asks keeps no workings — the score arrives already
totalled, with the round's scoring, the floor penalty and the end-of-game bonuses folded
together past separating. Closing the gap means the part of the program that does the scoring
has to report how, not only how much.

## What good looks like

- After a round is scored, you can point at any tile that scored and see what it was worth.
- The floor penalty is its own number, not folded into the round's total.
- At the end of the game the bonuses are itemised — rows, columns, colours — each with what it
  earned.
- The explanation is the program's own working, not a second opinion. There is one place the
  arithmetic happens, and if the explanation could disagree with the score, one of them is a
  bug.
- It costs nothing when nobody is looking. A program playing thousands of games against itself
  should not pay for explanations no one reads.

## Constraints

- The scoring stays in one place. Whatever shows the workings gets them from whatever does the
  scoring, and never recomputes them.
- Games already recorded, and the way the rules are checked for correctness, must keep working
  unchanged.

## Not in scope

- Advice. Saying what a move earned is not saying it was a good move, and the interface still
  stays quiet about a move before it is made.
- Explaining why the computer opponent chose something — a different thing, and *0003 —
  Computer opponent* rules it out.
- Animating the scoring or replaying a round tile by tile. Showing the numbers is the ask.

## Open questions

- Does an explanation outlive the round it describes, or clear with the next move? Keeping
  every round's workings is a larger thing than a note that fades.
- Is a per-tile split of the floor penalty meaningful, given that the order tiles sit in on the
  floor is arbitrary?
