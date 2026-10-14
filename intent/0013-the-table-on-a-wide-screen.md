---
title: The table on a wide screen
author: Gabriel Cangussu
date: 2026-10-14
status: done
depends-on: 0011 — A table, not a page
summary: >
  On a screen wide enough for both boards to sit either side of the table,
  show what is left in the bag at all times, and show every tile on every
  factory and in the centre as a tile, rather than one tile of each colour
  with a count on it.
---

# The table on a wide screen

## The idea

*0011 — A table, not a page* put the whole game on one screen, and on a phone that meant being
sparing: a factory shows one tile per colour with a count on it, and the bag is behind a button
in the top bar. People playing on a laptop or a monitor have asked for two things that phone
could not afford, and a wide screen can.

Show the bag at all times. On a wide screen, what is left in the bag — and in the lid, which
refills it — sits in plain view for the whole game, out of the way of the boards and the
factories. Nobody opens anything to see it.

Show every tile. On a wide screen, a factory holding two blue tiles, a red and a yellow shows
four tiles, the two blues side by side, and no count. The centre shows its tiles the same way,
like colours together. Picking is unchanged: you take every tile of a colour, so pressing any
one of them takes them all, and they light up together.

Phones and narrow windows keep what they have today. The counts and the folded bag were the
right answer where there was no room, and they still are.

## Why

Both are things a player at a real table has for free. The bag is a cloth sack, but what has
been drawn from it is on the table and in the lid, and a player who counts knows what is left.
And the factories hold loose tiles: you see at a glance that a factory has two blues, without
reading a numeral off a tile. People say that would make the game a lot easier to play, and on
a wide screen most of the table is empty.

## What good looks like

- On a laptop screen, the bag's and the lid's counts by colour are visible from the first move to
  the last without pressing anything, and nothing else moved to make room for them.
- On the same screen, every factory shows exactly the tiles it holds, each as a tile, same colours
  together, and the centre does the same. No count numeral on a tile.
- Pressing one tile of a colour on a factory selects them all, and it is obvious from the screen
  that it did.
- Everything reachable by keyboard and by screen reader before is reachable the same way, by the
  same names.
- On a phone, held either way, nothing has changed.
- The whole game is still on one screen on a laptop, with nothing to scroll.

## Constraints

- **The wide screen is the one 0011 already has.** Whatever rule decides that both boards sit
  either side of the table decides this too. No new breakpoint, no new setting.
- **Picking is one thing, however it is drawn.** A colour on a factory is still one control with
  one name, whichever of its tiles you press, so the keyboard and the screen reader see exactly
  what they saw before.
- **The bag's order stays hidden.** Counts by colour are all that is ever shown, as before.
- **Everything the earlier intents promised stays true**: no rule in the interface, no judging a
  move before it is made, no undo, only legal moves offered, no network.

## Not in scope

- Any change on phones, or on a screen where the boards do not sit either side of the table.
- Laying tiles out exactly as they were drawn from the bag, which the game does not record and
  which would be invented.
- Animating tiles as they are taken.
- Showing the bag on a phone by any other means.
