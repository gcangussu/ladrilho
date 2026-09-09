---
title: Computer opponent
author: Gabriel Cangussu
date: 2026-09-03
status: done
summary: >
  An opponent to play against when there's nobody else around — one that runs
  inside the same web page, thinks for a couple of seconds, and is genuinely
  hard to beat.
---

# Computer opponent

## The idea

Pick "play against the computer" and get a real game. The opponent takes its turn while you
watch, in a moment or two, and plays well enough that beating it feels like something.

Azul rewards a particular kind of thinking — the good move is often the one that leaves your
opponent with nothing but tiles they'll be forced to throw on the floor. An opponent that
only maximises its own points misses half the game, and it should be obvious from playing
it that this one doesn't.

Ideally there is more than one of it: a beginner-friendly setting for a relaxed game, and
one that plays as hard as it can.

## Why

The main reason anyone opens a board game implementation alone is to play against something.
Without this, the project is a two-person hot-seat game and a test suite.

It is also the reason the engine was built to be fast and repeatable. This is what cashes
that in.

## What good looks like

- It beats a casual human player more often than not.
- It plays the denial side of Azul: it will take tiles it doesn't especially want in order
  to leave you a bad position, and it times the end of a round rather than stumbling into it.
- It doesn't blunder in the endgame — it knows when a row is worth completing and when it
  is worth eating a penalty to set up a bonus.
- Its turn takes a couple of seconds at most, and the page stays responsive the whole time.
  Nothing freezes, and the interface can say "thinking…" honestly.
- Difficulty settings are actually different, not just slower versions of each other.
- Given the same position twice, it plays the same move — so a surprising choice can be
  looked at again afterwards.

## Constraints

- **It runs in the browser**, on the player's machine, alongside the interface. No server
  doing the thinking, no API calls, nothing to pay for or keep online.
- It plays strictly by asking the engine what is legal and what would happen. It gets no
  private information and no shortcuts a human player wouldn't have.
- It has to work on a laptop that isn't a gaming rig, and on a phone without cooking it.
- Thinking must not block the page. Whatever it does, the interface stays alive.

## Not in scope

- Training anything, gathering datasets, or running long self-play jobs to produce a
  stronger player. If a learned approach turns out to be the right answer, that becomes its
  own intent.
- Explaining its moves to the player, or coaching them.
- Being world-class. "Hard for a good human player" is the bar; superhuman is not.
- Playing anything other than the two-player base game.

## Open questions

- What is the honest strength target — "beats me", "beats a strong club player", or just
  "never makes an obvious blunder"?
- Is one adjustable opponent enough, or should the easy setting be a genuinely different,
  simpler player rather than a handicapped strong one?
- Should the player be able to watch two computer opponents play each other? It is a good
  way to spot bad play, and it costs almost nothing once the rest exists.
