---
title: Playing the opponent we trained
author: Gabriel Cangussu
date: 2026-10-02
status: pending
depends-on: 0009 — An opponent we train ourselves; 0003 — Computer opponent
summary: >
  Offer the player we trained by self-play as "master", a difficulty setting
  above "ruthless", playing in the browser on the player's own machine. By
  default it looks ahead 10 000 times before each move, which takes well under
  a second on our laptop. An advanced setting lets a person make it think more
  or less.
---

# Playing the opponent we trained

## The idea

*0009 — An opponent we train ourselves* gave us a player that learned Azul by playing itself, and
it now beats "ruthless" clearly. We want people to be able to play against it. It appears as
**master**, one more choice in the list of opponents, after "ruthless". Picking it is just
picking a setting, like any other.

It runs where everything else runs: in the browser, on the player's own machine, with no server.

Before each move it looks ahead at a number of possible continuations. Looking at more of them
makes it stronger and slower. By default it looks at 10 000. Someone who wants a different
amount can set the number themselves, under an advanced setting.

## Why

Today nothing in the game is stronger than "ruthless". The learned opponent of *0006 — A learned
opponent* was withdrawn when it stopped clearing the bar. 0009 deliberately left the interface
out, until there was a player worth adding. Now there is one: the first milestone to be measured
against "ruthless" won 79 games in 100, and training has improved on it since.

The player doesn't need long. Even looking at a small fraction of the default, it beats
"ruthless" by a wide margin. So there is no reason to make anyone wait several seconds a move.
10 000 is far stronger than "ruthless" and quick on most machines. It is a round number rather
than one tuned to a particular computer.

Before writing this down we tried three ways of getting the player into a browser. The first
uses the same code that trains and measures it, unchanged. The second is a simplified copy
rewritten for the browser. The third runs the network in a general-purpose runtime someone else
maintains. The unchanged code came out at least as fast as the other two, and much the smallest.
It also plays exactly as the trained player does, where the general-purpose runtime does its
arithmetic in its own order, so its moves could drift from the trained player's. So there is no second player to
keep in step with the first.

## What good looks like

- "master" is offered next to the other settings, and picking it is the only new thing.
  Choosing a person, "gentle", "steady" or "ruthless" plays exactly as it did before.
- On this laptop, in the browser, every move at the default takes under a second, and most take
  a small fraction of that.
- The advanced setting is easy to find for someone looking for it, and doesn't get in the way of
  someone who isn't. It accepts anything from 100, below which it plays carelessly, up to
  200 000, where its slowest moves take around a quarter of a minute on this laptop. Whatever
  number is set within that range is used as given.
- A number set there is kept from one game to the next, and a link to a game carries it, so
  whoever opens the link faces the same opponent.
- The page stays alive while it thinks, however much it has been told to think, exactly as it
  does for the other settings.
- It never sees what is coming out of the bag.
- When training produces a stronger player, putting it in place of the current one is a
  routine step, not a project. Which player is in place is written down too.

## Constraints

- **The player we trained is the player we ship.** The browser runs the same code that trained
  it, built for the browser. It is not rewritten in another language and not handed to someone
  else's runtime. A faster version that plays differently would be a different player.
- **The strongest player we have.** We ship the best milestone, as training's own record ranks
  them, not simply the latest one.
- **Simple limits.** The advanced setting's limits are round numbers, worked out once from
  measurements we already have. The top one is set by memory, not time: a search keeps what it
  has looked at, and at 200 000 that is already a few hundred megabytes. Thinking for a full
  minute would need over a gigabyte, more than a browser tab can be relied on to have.
- **One default for every machine.** It thinks the same amount on every device. Nothing changes
  depending on how fast the machine is, and we promise no particular speed anywhere but this
  laptop. On a phone or an older computer it is slower, and a person who minds can lower the
  amount under the advanced setting.
- **No server, as before.** The game makes no network requests, and adding "master" doesn't
  change that.
- **Only paid for by those who use it, if that stays simple.** Its trained knowledge is a few
  megabytes, much more than the rest of the game. Ideally someone who never picks "master"
  never downloads it. But if keeping it out of their way would make the game noticeably more
  complicated, everyone downloads it.
- **Kept apart from the opponents we have.** "gentle", "steady" and "ruthless" don't change, and
  nothing like the advanced setting is added to them. The learned opponent of 0006 stays
  withdrawn and untouched, and this intent doesn't decide its fate.
- **Training goes on undisturbed.** Shipping a player changes nothing about how training runs or
  what it measures.

## Not in scope

- Making it stronger. That is training, which is 0009's.
- Any promise about speed on phones or other machines, and any automatic adjustment for them.
- Offering more than one trained player, or letting someone choose a milestone.
- A pass-or-fail match against "ruthless" before it ships, like the one 0006's player needed.
  Training's milestones already show it is far stronger, and it keeps improving.
- Explaining its moves, hints, or analysing a game with it. No opponent explains itself yet.
- Any game but the two-player base game.
