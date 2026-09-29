---
title: An opponent we train ourselves
author: Gabriel Cangussu
date: 2026-09-29
status: pending
depends-on: 0006 — A learned opponent; 0007 — Rules engine in Rust
summary: >
  Train our own Azul player from scratch the way AlphaZero learned chess and Go,
  by playing itself on our own rules engine, until it wins clearly more often
  than our hardest setting, "ruthless" — measured against our existing opponents
  at milestones along the way.
---

# An opponent we train ourselves

## The idea

Train our own player the way AlphaZero was trained. It starts knowing only the rules. It plays
itself over and over, looking ahead from each position before it moves, and learns two things
from how those games turn out: which moves are worth looking at, and how good a position is.
Each round of training should play better than the one before. We keep going until it beats our
hardest setting, "ruthless".

This intent is about the training and nothing else. The opponent we built ourselves in
*0003 — Computer opponent* becomes the measuring stick: at milestones during training, the new
player plays a batch of games against it, and that is how we know whether training is working.

## Why

*0006 — A learned opponent* brought in a player someone else had trained. It played well against
the version of "ruthless" it was first measured against. But that version had a bug, and once the
bug was fixed it won only 45 games in 100. It was withdrawn, so today there is nothing stronger
than "ruthless".

We could keep trying to improve on that player, but we can't retrain it, and the choices that
shaped it were made by someone else. A player we train ourselves, on our own referee, has none of
those limits: every choice that shapes it is ours, and it can be trained further whenever we like.

The fast referee from *0007 — Rules engine in Rust* makes this realistic. Training is almost
entirely the referee playing games, millions of them, and the Rust referee was built for that
kind of volume.

## What good looks like

- It beats "ruthless" clearly, by the same bar 0006 set: 60 or more games in every 100, where two
  equal players would each get 50. It is measured against "ruthless" as it is at the time.
- Training has milestones. At each one the current player is measured against our own opponent's
  settings, starting with "ruthless", and the result is written down next to the previous ones.
  Anyone can read that record and see whether training is getting anywhere.
- It is small enough to think fast without a graphics card. On an ordinary modern processor, half
  of its moves take under 3 seconds and all but one move in a thousand take under 5.
- It never sees what is coming out of the bag. It wins by playing better, not by knowing the
  shuffle.

## Constraints

- **Built from scratch.** It learns only by playing itself. Nothing is taken from 0006's player,
  whether its trained knowledge, its code or its way of seeing the board. Nothing is copied from
  recorded human games or from our own opponent's choices either.
- **Our referee is the only rulebook it learns from.** Training plays on our own engines, which
  are held to the same recorded games and to each other. No outside copy of the rules is used.
- **Trained on this machine.** Training may use whatever this machine has. Only the finished
  player has to think fast on a processor alone. Moving training somewhere bigger, such as
  Google Colab, may come later, but we don't prepare for it now.
- **Kept apart from the opponents we have.** It lives on its own, next to them. Our existing
  opponent was built to be read and understood, and it stays that way. It is used here only as the measuring stick, and nothing about it changes to make
  measuring easier.
- **We know when to stop.** If two training rounds in a row don't improve how it plays against
  "ruthless", we stop. Whether training stops or goes on, each decision is written down with the
  reasons for it, so a later reader never has to guess why it went the way it did.

## Not in scope

- Playing it in the browser, and adding it to the interface as a difficulty setting. That will
  be its own intent, once there is a player worth adding. What it is called there is decided then.
- Being able to repeat training and get the exact same player. Each milestone's player is kept
  and measured, and that is enough.
- Preparing for training anywhere but this machine.
- Explaining its moves, as with every opponent before it.
- Any game but the two-player base game.
- Deciding what happens to 0006's player. It stays withdrawn unless its own measurement changes.
