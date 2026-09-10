# Intent

This directory holds **intents**: short, plain-language documents describing something we
want to build, change, or try — written *before* any code exists, in the words of the person
who had the idea.

An intent is not a spec, a ticket, or a design doc. It is the answer to *"what do we want,
and why?"*, captured once, in version control, so it can be read months later and acted on by
a person or an AI agent without a meeting in between.

## Why this exists

Normally an idea passes through backlog entries, user stories, story points, and refinement
meetings before anyone can act on it — and most of the original thinking is lost along the
way. Intents skip that: the idea is written down once, kept next to the code, and revised
through the same history as the code. What we wanted and what we built stay in the same
repository, and the gap between them is visible.

For a solo project, this matters for a different reason: it is a memory. Six months from now
neither you nor an agent will remember why the bot was supposed to run in the browser, or
what "good enough" meant for the UI. The intent says so.

Rationale and framing borrowed from Anthropic's
[AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook#sd-s1), where
intent is the starting artifact of the development lifecycle — "human readable, machine
actionable".

## What goes in an intent

- A problem or an opportunity: what can't be done today, or what would be better.
- The outcome we want, described by what someone can *do* once it exists.
- Constraints we are choosing to accept, and non-goals we are choosing to skip.
- Open questions that are genuinely unresolved.

## What does *not* go in an intent

- **Technical language.** No file paths, type signatures, function names, class diagrams,
  library APIs, or code. If a sentence would only make sense to someone who has read the
  source, rewrite it or drop it. Naming a technology as a *constraint* ("it must run in the
  browser", "we're using Solid.js") is fine; explaining how to use it is not.
- **Implementation plans.** Steps, task breakdowns, and file-by-file changes belong in the
  work itself, not here.
- **Status reports.** Progress lives in git and in the `status` field, not in prose.

An intent that stays non-technical stays readable when the code underneath it is rewritten.

## Lifecycle

Every intent carries a `status`:

| Status | Meaning |
| --- | --- |
| `pending` | Written down, not built (or not finished). The default for a new intent. |
| `done` | The intent has been realised. The document is left as-is — a record of what we wanted, not of what shipped. |
| `discarded` | We decided not to do it, or it stopped being relevant. Keep the file and add a line saying why. |

Intents are **not deleted and not completely rewritten after the fact**. If an idea changes
substantially, mark the old one `discarded` and write a new intent that references it. The
value of the directory is the trail, including the turns we didn't take.

## Conventions

- One idea per file, named `NNNN-short-slug.md` with a zero-padded sequence number
  (`0001-rules-engine.md`). The number is an identifier, not a priority — intents are not
  necessarily done in order.
- Reference other intents by number and title: *"depends on 0001 — Rules engine"*.
- Keep it short. Most intents should fit on one screen; if it doesn't, it is probably two
  intents, or it has drifted into design.
- Dates are the date the intent was *written*. They are not updated when the status changes.

## Template

Copy [`TEMPLATE.md`](TEMPLATE.md) into a new numbered file and fill it in. The preamble is
YAML frontmatter; the body is free-form markdown under the suggested headings.

```markdown
---
title: Short noun phrase naming the thing
author: Who had the idea
date: YYYY-MM-DD
status: pending | done | discarded
summary: >
  One or two sentences a stranger could read on their own and understand
  what this is and why it is wanted.
---

# Title

## The idea
What we want, in plain language.

## Why
The problem it solves or the reason it is worth doing.

## What good looks like
Concrete, observable signs that this is finished and worth having.

## Constraints
Boundaries we are accepting up front.

## Not in scope
Things a reader might reasonably assume are included, but aren't.

## Open questions
What is genuinely undecided.
```

Only the five preamble fields — `title`, `author`, `date`, `status`, `summary` — are
required. Add others (`tags`, `depends-on`, `supersedes`) when they earn their place.
