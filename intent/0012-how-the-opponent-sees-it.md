---
title: How the opponent sees it
author: Gabriel Cangussu
date: 2026-10-14
status: done
depends-on: 0003 — Computer opponent; 0010 — Playing the opponent we trained
summary: >
  After each move the computer makes, show what it reckoned its chances were as
  it moved — a chance of winning for "master", a lead in points for the three
  hand-written opponents — so a person can see how the game looks from the
  other side of the table.
---

# How the opponent sees it

## The idea

People playing against the computer want to know how it sees the game. Every one of our
opponents already works this out before it moves: it weighs the position and picks the move it
rates best, and the rating is thrown away. We want to show it.

After each move the computer makes, the screen shows what it reckoned as it chose: for "master"
(and "expert", should it ever be offered again) a chance of winning, since that is what it
thinks in; for "gentle", "steady" and "ruthless" a lead in points, since that is what *they*
think in. The number appears beside each player's score, from that player's side — your chance
and its chance add up to the whole; your lead is its deficit — and it always says whose estimate
it is and that it was taken as the computer moved.

It changes only when the computer moves. When you move, the number stands until the computer has
answered, and then it reflects the position after its reply. Before the computer has moved,
there is nothing to show, and a game between two people shows nothing at all. In a game between
two computers, each move brings the mover's own estimate, in that opponent's own terms.

## Why

The three earlier intents all said the opponent would not explain itself, and that is still
true: this is not a reason for a move, not a hint, and not a mark out of ten for the move you
are about to make. It is the one number the opponent already produced, shown instead of
discarded. People have asked for exactly that — "it would be interesting to see how your bot
sees things" — and it costs the game nothing: no extra thinking, no change to how the opponent
plays or how fast it answers.

It is also the most honest kind of feedback a learner can get. Watching the chance move after
each exchange says which of your moves the strongest player we have agreed with, without anyone
telling you what to do.

## What good looks like

- Playing "master", after each of its moves you can see your chance of winning as it saw it,
  next to your score, and its own chance next to its score. The two add up to the whole.
- Playing "ruthless", you see instead who it thinks is ahead and by how many points.
- The number says whose estimate it is. Nobody mistakes the computer's opinion for a fact about
  the position, or for the score.
- Nothing about it appears before the computer's first move, nothing appears in a game between
  two people, and a new game starts clean.
- It is readable by a screen reader like the score is, and it does not interrupt play to be
  read out.
- The opponent plays exactly the moves it played before, exactly as quickly. The same deal
  against the same opponent shows the same numbers every time, as surely as it plays the same
  moves: only a machine too slow to finish its thinking can change either.

## Constraints

- **Shown, not computed.** The number is the one the opponent produced to choose its move.
  Nothing thinks again to produce it, and nothing thinks on a person's turn.
- **Its own terms.** A chance is shown as a chance and a lead as a lead. We do not convert one
  into the other, because the conversion would be ours and not the opponent's.
- **A draw counts as half** when the chance is worked out, which is how "master" values one.
- **Nothing before a move is made.** The rule that the interface never judges a move before it is
  played stays exactly as it is. The estimate belongs to a position, after the computer's move,
  never to a move a person is considering.
- **No private information.** The estimate is made from what the opponent is allowed to see,
  which is what the person can see.

## Not in scope

- Explaining a move, suggesting one, or marking a person's move. The opponents still do not
  explain themselves.
- An estimate on every ply, which would mean thinking on the person's turn and slowing the
  computer's reply. If people want the number to move after their own move too, that is its own
  intent.
- Analysing a game between two people, or an opponent that watches without playing.
- A setting to hide it. If someone finds it discouraging, that is a small follow-up, and we would
  rather hear it first.
- A history of the estimate over the game, or a graph.
