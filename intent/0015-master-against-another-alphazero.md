---
title: Our master against another AlphaZero
author: Gabriel Cangussu
date: 2026-10-19
status: done
depends-on: 0009 — An opponent we train ourselves; 0010 — Playing the opponent we trained
summary: >
  A program that plays our trained player, "master", against the AlphaZero-style
  Azul player published at github.com/grzhx/azul-alpha-zero, on our own referee,
  with every setting either player has — how many times it looks ahead, how long
  it may think, and the rest — chosen by whoever runs the match.
---

# Our master against another AlphaZero

## The idea

Someone else has trained an Azul player the way we trained ours: from nothing, by self-play, in
the AlphaZero style ([azul-alpha-zero](https://github.com/grzhx/azul-alpha-zero)). They published
its trained knowledge as their "generation 2300", along with the program that thinks with it. It
is the closest thing to ours that exists, made by someone else.

We want a program that plays the two against each other, many games at a time, and says who won
and by how much. It should work like the match we already run against the AI of
danluu.com/game/tile: run from the command line on our own machine, the moves decided by each
player's own program, the game decided by our rules.

Whoever runs a match chooses how much each side thinks. Each side can be given a number of
look-aheads per move or an amount of time per move. Every other setting that changes how either
player plays can be set too: for theirs, how many moves it considers in full, how deep it looks,
how many possible deals it imagines, whether several separate searches vote on the move, how many
threads it uses; for ours, which milestone plays, whether the endgame proof is on, and anything else
it has. Left alone, each setting is what that player's own author would choose.

## Why

Until now we have measured our player against opponents built differently: our own "ruthless", a
learned player trained long ago, a minimax over a value network. This one learned the same way
ours did, on its own engine, with far more computing power behind it — hundreds of thousands of
games per generation, on a graphics card. Playing it tells us how far our player is from what that
approach can reach, and whether more training is likely to pay.

The settings matter because "who is stronger" has no answer without them. A player that thinks for
ten times longer usually wins, and the two programs spend time very differently. Being able to
match them at equal look-aheads, at counts that cost each about the same time, or at each
one's preferred setting — and to move
one setting while holding the others still — is what makes a result mean something.

## What good looks like

- One command plays a match of a chosen size and prints the result: wins, losses and draws, the
  share of games each side won with a range of how sure that is, and the average score.
- Every game is played once from each seat on the same deal, so neither side profits from going
  first or from a lucky shuffle.
- Every setting either player has can be given on that command, and the result records what each
  side was set to, so two results can be compared without guessing.
- A match with no clocks in it, rerun with the same settings, gives the same games, move for move.
  Where something cannot be repeated — a clock, threads racing each other — the program says so.
- The program's documentation has a table of how long each player takes per move, on this
  machine, at a range of look-ahead counts — from a few hundred to as many as either is likely to
  be given. The two programs count a look-ahead differently, so the same number is not the same
  work; the table lets someone pick counts that give each side about the same time, or a chosen
  multiple of it, and still get a match that repeats. It says when and on what machine it was
  measured, and the program can measure it again. With it, and how many moves a game usually
  takes, whoever sets up a match can work out roughly how long it will run before starting it.
  How big a match is worth that wait is their call, not the program's.
- Before trusting any result, a check shows that their player sees exactly the position our game
  is in: the same factories, centre, boards, scores and bag counts, and that every move it picks
  is one our rules allow. When a game turns up a disagreement — their player sees a different
  position, or wants a move our rules forbid — that game is reported, with enough to replay the
  spot, and left out of the result; the match carries on with the rest.
- A short note, like the one written for the danluu.com match, says whether the match is fair to
  their player: whether it plays as it would in its own program, with its own defaults, and
  where the two sides are not treated alike.

## Constraints

- **Look-aheads by default, not time.** A clock depends on what else the machine is doing, so a
  match played on time cannot be repeated. Thinking time stays available for whoever wants it,
  but a match is budgeted in look-aheads unless asked otherwise, and time enters through the
  measured table instead.
- **Our engine is the referee.** It deals, says what is legal and scores the game. Their program
  is asked only for its move.
- **Neither side sees the future.** Each is told only what a player at the table could see; the
  bag's order is never given to either.
- **Their player is used as published.** Their trained knowledge and their program, unchanged,
  at the release named. Their repository carries no licence, so nothing of theirs is copied into
  ours: it is downloaded and built on the machine that plays, kept outside the repository, and
  checked against the fingerprints they published.
- **On this Mac, on the processor.** Their program is written for a graphics card and Windows, but
  supports running on a processor; that is how it plays here. We say so beside every result,
  because it is not how its author ran it.
- **A tool, not a feature.** It is run on purpose, by a person, on a machine with time to spare.
  It is not part of the everyday test run, and nothing in the game in the browser changes.

## Not in scope

- Offering their player as a difficulty setting in the browser. If it turns out to be worth
  playing, that is another intent.
- Training either player, or learning anything from their player. *0009* said our player is
  built from scratch, and that holds: the match measures, it does not teach.
- Their three-player player, and any variant of the game other than two players on the coloured
  wall.
- Matches over a network, against their author's own interface, or against people.
