---
title: Rules engine
author: Gabriel Cangussu
date: 2026-09-03
status: pending
summary: >
  A trustworthy referee for two-player Azul: it knows every rule, decides which
  moves are allowed, plays them out, keeps score, and declares a winner — with no
  screen, no players, and no opinions about strategy.
---

# Rules engine

## The idea

Before anything can be played or watched, something has to *know the game*. This is that
piece: a referee that holds a game of Azul in progress and can answer three questions
forever — what has happened so far, what am I allowed to do right now, and what happens if
I do this?

It handles the whole game from the first tile drawn to the final bonus points: filling the
factory displays, taking tiles of one colour, the leftovers going to the middle, the
penalty for being first to take from the middle, filling pattern lines, moving tiles onto
the wall at the end of a round, the floor line penalties, and the end-of-game bonuses for
completed rows, columns, and colours.

It has no screen and no players. It sits underneath everything else and is the only thing
in the project allowed to decide what is and isn't legal.

## Why

Every other part of this project is a client of the rules. The interface draws whatever the
referee says the game looks like; the computer opponent tries out moves by asking the
referee what would happen. If the rules live in two places they will disagree, and the bug
will surface as a board that looks wrong for reasons nobody can find.

Doing it first, on its own, also means it can be tested to death without a single pixel
being drawn.

## What good looks like

- A complete two-player game can be played from start to finish without ever reaching a
  situation the referee doesn't have an answer for.
- Given any position, it can list every legal move — and refuses illegal ones rather than
  quietly doing something surprising.
- Scoring matches the printed rules exactly, including the fiddly parts: adjacency scoring
  when a tile joins existing runs, the floor line penalties, and the end-of-game bonuses.
- Tiles are conserved. Across an entire game, no tile is ever created or lost — every one
  is accounted for in a bag, a factory, the middle, a board, or the discard pile.
- The same game, started the same way, plays out identically every time. Nothing is random
  except the shuffle, and the shuffle can be asked to repeat itself.
- It is fast enough that a computer opponent can explore many thousands of positions
  without anyone noticing a pause.

## Constraints

- **Two players only.** Azul supports three and four; we are not doing them.
- **Correctness is judged against an existing implementation.** There is a Python engine we
  trust ([ludometer](https://github.com/RemiFabre/ludometer)). We replay its recorded games
  move by move and expect to agree at every step, plus a handful of hand-built awkward
  positions. A rule we can't check that way is a rule we've probably got wrong.
- **No rule variants.** The base game as printed, not the grey-side variant or expansions.
- It must be usable from inside a web page, since eventually the whole thing runs in a
  browser.

## Not in scope

- Anything visual — see *0002 — Web interface*.
- Anything that decides which move is *good* — see *0003 — Computer opponent*. The referee
  ranks nothing.
- Saving games to disk, networked play, or spectating.

## Open questions

- How much of a game's history should the referee remember? Enough to undo a move, enough
  to replay the whole game, or nothing at all beyond the current position?
- When a player has no sensible place to put tiles, the rules force them onto the floor.
  Should that be an ordinary move like any other, or something the referee handles for the
  player?
