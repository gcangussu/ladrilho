---
title: Short noun phrase naming the subject
author: Who wrote it
date: YYYY-MM-DD
status: draft
intent: NNNN — Title of the intent this serves
prefix: X1
summary: >
  One or two sentences saying what this document specifies, and — just as
  usefully — what it deliberately leaves to another spec.
---

# Title

## Scope

What this spec covers, and what it explicitly does not. Name the specs or intents that own the
neighbouring parts so a reader who came here for the wrong thing leaves quickly.

## Definitions

Terms used with a precise meaning below, and constants the rest of the document depends on.
Skip if the subject introduces no vocabulary of its own.

## Data model

Types, structures, and layouts. Field order matters when it is part of the contract — say so.

## Behaviour

Numbered requirements. One rule per requirement, phrased so it is testable.

- **[X1-1]** The thing MUST do this.
- **[X1-2]** When *condition*, the thing MUST NOT do that.

Group them under sub-headings when there are more than a handful.

## Interfaces

The public surface other code depends on: signatures, arguments, return values, and what is
thrown or returned on failure.

## Invariants

Properties true of every reachable state, written so a test can assert them directly.

## Performance

Budgets, with the measurement that decides them. Only where performance is actually a
requirement — omit the section rather than inventing a number.

## Verification

How we will know this is right: the tests, fixtures, and cross-checks. Point at the conformance
spec if one owns the fixtures.

## Open questions

Decisions this spec has not made, phrased as questions, with the consequence of each answer.
Delete the section if there are none.

## References

The intent, related specs, and any external source of truth.

---

*Delete these instructions as you fill the file in. See [README.md](README.md) for conventions,
requirement identifiers, and lifecycle.*
