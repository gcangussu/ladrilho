# Spec

This directory holds **specs**: precise, technical descriptions of how something works, written
so that it can be built from the document and so the built thing can be checked against it.

A spec is the counterpart to an [intent](../intent/README.md). The intent says *what we want and
why*, in plain language, and never mentions a file or a function. The spec says *what the thing
does*, in the language of the code, and never argues for itself — if you want to know why the
engine exists, read the intent it links to.

| | Intent | Spec |
| --- | --- | --- |
| Answers | What do we want, and why? | What exactly does it do? |
| Audience | Anyone | Whoever implements or verifies it |
| Language | Plain, no technical terms | Types, encodings, invariants, numbers |
| Lifetime | Frozen once written | Revised to track the design |
| Written | Before the work | Before the work, kept current during it |

## Why this exists

Intents deliberately refuse detail: an intent that says "scoring matches the printed rules
exactly" is honest but not buildable, and two people (or two agents) will read it two ways. The
detail has to live somewhere, and the two places it usually lives — a chat log, or the code
itself — are both bad. A chat log is unsearchable and dies with the session; the code answers
"what does it do" but not "what is it *supposed* to do", so a bug and a feature look identical.

A spec is the artifact tests can cite. Every requirement here has an identifier, and a test that
proves it should say so. When the code and the spec disagree, one of them is wrong, and the
disagreement is now a thing you can point at.

## What goes in a spec

- **Data**: state, types, encodings, exact layouts and field orders.
- **Behaviour**: numbered requirements, in enough detail that two implementations agree tile for
  tile.
- **Invariants**: what must be true of every reachable state.
- **Interfaces**: the signatures other packages depend on, and what they throw.
- **Verification**: how we will know it is right — the tests, fixtures, and budgets that decide.
- **Open questions**: decisions the spec has deliberately not made yet.

## What does *not* go in a spec

- **Rationale and motivation.** Link the intent instead. A spec may explain *why a design choice
  was made over an alternative*, briefly; it should not sell the feature.
- **Implementation plans.** Task order, milestones, and who does what belong in the work.
- **Whole modules of code.** Signatures, type declarations, tables and short pseudocode earn
  their place; a copy of the implementation does not — it goes stale the day it is written.
- **Status prose.** Progress lives in git and in the `status` field.

## Requirement language

Requirements use RFC 2119 keywords — **MUST**, **MUST NOT**, **SHOULD**, **MAY** — and carry
stable identifiers scoped to the spec, written `[E1-14]` for requirement 14 of spec 0001 (`E` for
engine; each spec declares its own prefix in the frontmatter as `prefix`).

Identifiers are **append-only**. A requirement that is removed is struck out and its number
retired, never reused, so a test that cites `[E1-14]` always means the same rule.

## Lifecycle

Every spec carries a `status`:

| Status | Meaning |
| --- | --- |
| `draft` | Being written or argued about. Do not build from it yet. |
| `accepted` | Agreed. This is what gets built. |
| `implemented` | The code exists and satisfies it. Still the description of record. |
| `superseded` | Replaced by a later spec. Keep the file; add a line naming the replacement. |

Unlike intents, specs are **living documents**: fix an error, tighten a loose requirement, or add
a case in place, and let the git history carry the change. The exception is a redesign large
enough that the old document no longer describes anything real — then write a new spec, mark the
old one `superseded`, and set `supersedes` in the new one's frontmatter.

## Conventions

- One subject per file, named `NNNN-short-slug.md` with a zero-padded sequence number
  (`0001-engine-core.md`). Numbers are identifiers, not priorities.
- Spec numbers are their **own sequence** — spec 0002 is not "the spec for intent 0002". Each
  spec names the intent it serves in its `intent` field and refers to others by number and title.
  A spec **may serve more than one intent** — a later intent that changes the same subject amends
  the spec that owns it rather than starting a spec of cross-references. Where it does, `intent`
  is a YAML list, because an intent's title is free to contain a comma and a comma-separated
  string is then unparseable. The Index below names those specs by intent number alone.
- Cite a requirement in the same spec as `[E1-14]`, and one in another spec as `[0001 E1-14]` —
  spec number inside the brackets, so a whole citation is one token a script can match with
  `\[(?:(\d{4}) )?([A-Z]+\d+-\d+)\]`. Prefixes are unique across specs, so the spec number is
  never needed to *resolve* a citation — it is there to tell a reader which file to open, which
  is why citations from outside the `spec/` tree (test names, comments, commit messages) use the
  bare `[E1-24]`.
- Qualify **both ends** of a range and never leave one bare: `[0001 E1-41]` through
  `[0001 E1-45]`, not `[0001 E1-41] to [E1-45]`. Where the members of a range each need to be
  traceable — a requirement that mandates a test per item — list them individually instead;
  a range cites its endpoints, and the three identifiers in the middle are mentioned nowhere.
- Length follows the subject. A spec is allowed to be long where the detail is real, but prefer
  splitting a second subject into a second spec over one document that covers everything.
- Dates are the date the spec was first written; the git log covers the rest.

## Template

Copy [`TEMPLATE.md`](TEMPLATE.md) into a new numbered file. The preamble is YAML frontmatter; the
body is markdown under the suggested headings — keep the ones that carry content, drop the rest.

```markdown
---
title: Short noun phrase naming the subject
author: Who wrote it
date: YYYY-MM-DD
status: draft | accepted | implemented | superseded
intent: 0001 — Rules engine
prefix: E1
summary: >
  One or two sentences saying what this specifies and what it does not.
---
```

Required fields: `title`, `author`, `date`, `status`, `intent`, `prefix`, `summary`. Add
`supersedes` / `superseded-by` and `depends-on` when they apply.

## Index

| Spec | Status | Intent | Subject |
| --- | --- | --- | --- |
| [0001 — Engine core](0001-engine-core.md) | implemented | 0001 — Rules engine | State, action encoding, rules, scoring, determinism, observation vector |
| [0002 — Engine conformance vectors](0002-engine-conformance-vectors.md) | implemented | 0001 — Rules engine | How the engine is proven correct against the reference implementation |
| [0003 — Web interface](0003-web-interface.md) | implemented | 0002, 0005 | The hot-seat client: turn interaction, board presentation and layout, the engine seam, accessibility |
| [0004 — Computer opponent](0004-computer-opponent.md) | implemented | 0003 — Computer opponent | The player: the information barrier, evaluation, search, difficulty tiers, determinism |
| [0005 — Opponent strength](0005-opponent-strength.md) | implemented | 0003 — Computer opponent | How we know it plays well: the arena, the reference opponents, the ladder, the blunder audit |
| [0006 — Opponent in the interface](0006-opponent-in-the-interface.md) | implemented | 0003 — Computer opponent | Where it runs and what you see: seating, the worker, the thinking state; amends 0003 |
| [0007 — Scoring explained](0007-scoring-explained.md) | draft | 0004 — Scoring explained | How the engine reports the way it scored a round: the second entry point, the record, the invariants; amends 0001 and 0003 |
