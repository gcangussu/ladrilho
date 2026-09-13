---
title: A learned opponent
author: Gabriel Cangussu
date: 2026-09-11
status: done
depends-on: 0003 — Computer opponent
summary: >
  A fourth difficulty setting that plays like a player someone else has already
  trained to play Azul, kept apart from the opponent we have, and shipped only
  if it wins clearly more often than our hardest setting.
---

# A learned opponent

## The idea

Someone has already trained a computer to play two-player Azul by having it play itself
many times, and published the result openly
([alpha-zero-general](https://github.com/cestpasphoto/alpha-zero-general)). We want to bring
that player into our game as it is: a faithful copy of how it plays, not our own version
of it.

It shows up as one more difficulty setting, above the three we have. It sits beside the
opponent we built, not inside it. The three existing settings stay exactly as they are,
and this one either earns its place or doesn't.

## Why

*0003 — Computer opponent* left training out of scope on purpose, and said a learned
approach would become its own intent if it turned out to be the right answer. That has
become a real question, because a trained player now exists that we don't have to train.
Its author reports that it plays much stronger than a well-known online bot. That is an
impression, not a measurement, and we can measure it ourselves.

Keeping it separate means we can find out without risking what already works. The existing
opponent was designed to be understood: why it prefers one move to another can be read
and checked. A learned player can't be read the same way. If it lived inside the existing
opponent, that opponent would stop being something we fully understand.

## What good looks like

- Given the same position, it chooses the move the original would choose.
- It wins clearly more often than our hardest setting. "Clearly" means at least 10% more
  likely to win: 60 or more games in every 100 against it, where two equal players would
  each get 50. If it doesn't, it does not ship, and we write down that it didn't.
- Picking it is picking one more difficulty setting, next to the other three. Nothing else
  in the interface changes. Picking any other setting plays exactly as it did before.
- The same position gets the same move every time, and it never sees what is coming out of
  the bag.

## Constraints

- **It uses the already-trained player as it is.** We take what was published, credit its
  authors, and follow its open-source licence.
- **Our own rules engine decides what is legal and what happens.** The other project's
  rules are not used for playing, only for checking we feed the player what it expects.
- **It runs in the browser**, on the player's machine, like everything else. No server.
- **Thinking must not block the page.** However long it takes, the interface stays alive the
  whole time, exactly as it does for the existing opponent.
- **It is kept apart from the existing opponent.** Nothing about the existing opponent
  changes to make room for it.

## Not in scope

- Making it fast. It thinks as much as the original does, however long that takes, on a
  desktop or a phone. This setting alone is exempt from 0003's "a couple of seconds at
  most"; the other three settings still keep that promise. Speed can be its own intent once
  we know it is worth keeping.
- Improving on the original, whether by training, retraining, fine-tuning or thinking
  differently. If the copy is promising but not good enough, that is another intent.
- Replacing any of the existing settings.
- Explaining its moves. That was out of scope for the first opponent too.
- Any game other than the two-player base game, which is all it was trained for.
