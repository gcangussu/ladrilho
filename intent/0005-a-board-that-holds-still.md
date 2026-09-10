---
title: A board that holds still, and lines up with itself
author: Gabriel Cangussu
date: 2026-09-09
status: pending
summary: >
  A player's board should keep the same shape whether it is that player's turn
  or not, and the rows you fill should sit level with the rows they feed, so
  the board stops jumping and you can see where your tiles are going.
---

# A board that holds still, and lines up with itself

## The idea

Two things about the board, both about where things sit.

The first: a board is a fixed thing. It should take up exactly as much room when you are
waiting as when it is your turn, and the same again once the game is over. Today it grows
when the turn arrives and shrinks when the turn leaves, so every move shoves both boards up
and down the page.

The second: the rows you put tiles into should line up with the rows of the wall they feed.
Row three of your lines level with row three of your wall, side by side, the way the printed
board has it. Where the screen is wide enough to put them side by side, put them side by
side.

## Why

The jumping is the worse of the two. You take a turn, and while you are still looking at
what you did, the page moves under you — your own board shrinks, the other player's grows,
and whatever you were reading is somewhere else. Nothing on the board has changed except
whose turn it is, so nothing on the board should move.

The alignment is about learning the game. A tile goes from a line to the wall row beside it,
and if the two are level you can see that without being told. Stacked one above the other,
with the wall on top, you have to count rows in one place and count them again in the other.
That is the single most confusing thing about reading the board for someone who has not
played before.

## What good looks like

- Taking a turn moves nothing on the page except the tiles that moved.
- The two boards are the same height as each other, at every point in the game, including
  after the last move.
- On a wide enough screen, a line and the wall row it feeds are level, and you can see at a
  glance where a full line will end up.
- On a screen too narrow for that, the board still fits without scrolling sideways, and is
  still readable.
- A player using only the keyboard reaches everything they reached before, in the same
  order, and a player using a screen reader is told the same things.

## Constraints

- The board of the player to move offers its rows as things you can choose; the other
  player's board only shows them. That distinction stays. What must go is the difference in
  the room they take up, not the difference in what they do.
- Nothing here may teach the interface a rule. Which row a tile can go in, and what a
  penalty costs, are still questions for the engine.

## Not in scope

- Making the board look like the printed one in any other respect — the tiles, the colours,
  the borders are all as they were.
- Moving the factories or the middle. This is about a player's own board.
- Animating anything. If the board holds still there is nothing to animate.

## Open questions

- On a screen too narrow to put the lines beside the wall, which goes on top? Today the wall is
  above and this asks for them side by side where there is room; it does not say what the narrow
  screen should look like afterwards, and there is a case for either order.
