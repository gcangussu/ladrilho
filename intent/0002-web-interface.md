---
title: Web interface
author: Gabriel Cangussu
date: 2026-09-03
status: pending
summary: >
  A web page where you can actually play Azul: see the factories, the middle, and
  both boards, take tiles by clicking them, and watch the scoring happen — with the
  rules enforced so an illegal move is simply not offered.
---

# Web interface

## The idea

Open a page, see a game of Azul laid out clearly, and play it. Two people share one screen
and take turns.

A turn is two clicks: pick the tiles you want — a colour from one of the factory displays,
or from the pile in the middle — then pick the row on your board where they go, or dump
them on the floor. The board only offers what the rules allow, so there is no way to make
an illegal move and no need to know the rules to start playing.

At the end of a round, tiles move onto the wall and the score changes; the interface should
make it obvious *why* the score changed, not just that it did. At the end of the game the
bonuses are shown and a winner is declared.

## Why

The engine can play a perfect game that nobody can see. This is the part that makes the
project a thing you can show someone.

It is also the honest test of the rules: replaying recorded games proves the engine agrees
with another program, but sitting down and playing proves it feels like Azul.

## What good looks like

- Someone who has played Azul before can sit down and play without instructions.
- Someone who *hasn't* can work it out, because only legal choices are ever clickable.
- At a glance you can see whose turn it is, what is left to take, and how far each player
  is from finishing a row, a column, or a colour.
- Scoring is legible: when points are awarded you can tell which tiles earned them.
- It works on a laptop and on a phone held sideways, and it doesn't require a mouse.
- Nothing about it feels sluggish — clicking a tile responds immediately.

## Constraints

- Built with Solid.js **version 2**. Note that v2's way of doing things differs from the
  heavily-documented v1, so examples found online are often the wrong shape.
- It runs entirely in the browser. No server, no accounts, no network calls — the whole
  game happens on the page.
- It never contains a rule. Everything it knows about legality and scoring it asks the
  engine for. If the interface has an opinion about the rules, that's a bug.
- Hot-seat first: two people, one device.

## Not in scope

- Playing against the computer — that arrives with *0003 — Computer opponent*. The
  interface should be shaped so a player can later be a person or a program, but it does
  not need to know how to be one.
- Playing over a network, matchmaking, or accounts.
- Animation of tiles flying around the board. Clear beats fancy; if a little motion helps
  explain the scoring, that's a nice-to-have, not a requirement.
- Sound.

## Open questions

- Does an undo button exist? It makes learning much friendlier and competitive play
  meaningless.
- Should the interface point out a costly move before you commit to it — a "this puts four
  tiles on your floor" warning — or stay out of the way and let people lose?
- How much of the board's state needs to survive a page refresh, if any?
