# Knowledge gap agent — design

Date: 2026-08-09
Status: built

## What the data said

Measured against production before designing anything:

| | |
|---|---|
| Questions the assistant escalated to staff (`adminInquiries`) | 70 |
| **Never answered by anyone** | **49 (70%)** |
| Answered with usable text | 21 |
| Knowledge-base entries | 91 — exactly 13 of each type, i.e. seeded, not grown |

Real pairs sitting in that table, none of which exist in the knowledge base:

> "Can an Indian applicant later change from the 2-year freelance visa to a
> company visa?" → "Yes , freelance visa can change to employment visa later"

That reframed the agent from one job into two.

## Two jobs

**Answered inquiries → knowledge-base drafts.** A human already wrote the answer,
so the agent rewrites rather than researches. The prompt says, in as many words,
never to add a fact the staff answer does not contain: a wrong visa rule is worse
than a missing one.

**Unanswered inquiries → clustered themes.** Nobody has answered these, so there
is nothing to rewrite. The agent groups them and reports what customers keep
asking that the business has never written down. It is explicitly told not to
answer them — visa eligibility and pricing are exactly where a confident guess
costs a customer or a fine.

## Judging what is worth keeping

Production stores `"Okay"` as an answer, and also `"Tell them our team will
contact you for this solution"`. Both are useless; only one can be caught by a
rule.

- **`isThinAnswer`** (pure, in `lib/kbGap/select.ts`) rejects what can be decided
  from the shape of the text: empty, under `minAnswerChars`, or a bare
  acknowledgement. Anchored to the whole string, so "Yes , freelance visa can
  change…" — the best answer in the sample — is not caught by its leading "Yes".
- **The model** decides the rest, returning `worthKeeping` with a reason. A
  keyword list for "our team will contact you" would also reject genuine answers
  that mention the team.

The cheap filter runs first, so a bare "Okay" never costs a provider call.

## Output

Drafts land as `kbEntries` with `status: "draft"` — the knowledge base already
has a draft state, and it is where someone would edit them anyway. Publishing
stays a human act.

`kbGapProcessed` records every inquiry considered, with its outcome and reason.
It is both the idempotency record — without it a sweep re-drafts the same entry
every run — and the audit trail for anything skipped.

`kbGapThemes` is rewritten wholesale each sweep rather than merged: a theme is a
view over the current backlog, and merging would strand themes whose questions
have since been answered, leaving the board reporting a gap that is closed.

## Shape

- Cron `kbgap-sweep`, every 6 hours. A knowledge gap is not urgent.
- `kbGapConfigs`, `enabled` defaulting false — dormant-safe like every agent here.
- Usage logs under `kb_gap`, so the roster counts its work.
- Registry entry `built: true`, with its own switch and extra-instructions support.

## Out of scope

- Answering the unanswered questions
- Mining conversations for gaps that never became an inquiry — the relay is
  already structured question-and-answer; free text is far noisier and worth
  doing once this proves itself
- Publishing anything automatically
