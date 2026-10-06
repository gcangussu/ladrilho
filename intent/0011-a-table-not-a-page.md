---
title: A table, not a page
author: Gabriel Cangussu
date: 2026-10-06
status: pending
depends-on: 0002 — Web interface; 0005 — A board that holds still, and lines beside its wall
summary: >
  Redesign the game's screen so the whole game sits on one screen like a table:
  your board, the factories and the other player's board, with nothing to scroll
  between picking tiles and placing them — on a laptop and on a phone.
---

# A table, not a page

## The idea

Today the game reads like a document. A paragraph of status at the top, the seat choices under
it, then the factories, then both boards, then the scoring. On a laptop the boards start at the
bottom edge of the screen; on a phone you pick tiles at the top and scroll a long way down to put
them on your board, every turn.

We want it to look and work like the table you play the physical game on. The factories sit in a
ring around the centre, each player's board sits on its own side, and everything is on screen at
once. On a phone, your board sits along the bottom under your thumb, the factories are above it,
and the other player's board is shown small at the top — small, but all there.

Taking a turn should be obvious from the board itself:

- A factory shows one stack per colour with a count on it, because you always take all of a
  colour.
- Once you have picked, your board says what you are holding and where it came from, with a way
  to put it back.
- Each row of your board runs from the line you fill straight into the wall row it feeds, and the
  whole row is the thing you press. The rows you may use light up; the others stay visible.
- Number keys choose a row directly.

When a round is scored, the points appear next to the tiles that earned them, on each player's
own board, instead of in a table at the bottom of the page.

Choosing who plays moves out of the way of the game, behind its own button.

It should look like its own thing, not a dark default: a light surface, tiles that look like
tiles, and one accent colour that means "you can act here" and is never a tile colour. The black
tiles in particular must stop looking like empty spaces.

When two people share one phone, the phone shows the board of whoever is to move. When the turn
passes, a screen says whose turn it is and hides the board until that player is ready. The boards
change places behind that screen, never in front of someone's finger.

## Why

The game is two clicks a turn, and on a phone those two clicks are a long scroll apart. Nothing
about the rules is hard to see, but the page makes you hunt for it.

The rest is about learning the game. A player who sees a row as one thing — the line and the wall
row together — understands where tiles go without being told. A player who sees the points next to
the tiles understands why a round scored what it did.

## What good looks like

- On a laptop and on a phone held either way, the whole game is on one screen: no scrolling to
  get from the factories to your board.
- Someone who has never played can see what they are holding and where it can go.
- After a round, you can see on the board which tiles scored and how much.
- Against the computer, you can see what it just did.
- Two people on one phone each see their own board on their own turn, and never watch it swap.
- Everything that was reachable by keyboard and by screen reader still is.

## Constraints

- Everything the earlier intents promised stays true: no rule lives in the interface, nothing
  warns about a move before it is made, there is no undo, and only legal moves are offered.
- It still runs entirely in the browser with no network requests, which rules out fonts loaded
  from elsewhere.

## Not in scope

- Animation of tiles moving.
- Sound.
- A history of every round's scoring.
- A dark theme.
