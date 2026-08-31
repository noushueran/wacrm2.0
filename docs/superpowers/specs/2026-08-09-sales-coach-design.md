# Sales coach — design

Date: 2026-08-09
Status: built

## What the data allowed

Measured before designing:

| | |
|---|---|
| Conversations | 1,802 |
| Assigned to a human | 1,198 |
| Sales checklists | 188 |
| **Deals** | **0** |
| Conversations past `qualified` | **0** |

That last pair is decisive. **There is no outcome data.** Nothing has ever
reached `price_quoted`, won, or lost, so no honest agent can say who *closes*
better. It can only judge process and handling.

## Design consequences

**No scores. No ranking.** A number built from process alone would read as
objective and would not be — and this is the one agent whose output is about a
named colleague. The prompt forbids grading; the parser does not accept a score
field at all.

**Every observation carries a verbatim quote, enforced in the parser.** An
observation the model cannot evidence from the thread is dropped rather than
filed. Feedback about a person without evidence is an opinion, and an opinion
from a model is not something anyone should have to answer for.

**Strengths are required alongside faults.** A list of only failings is not
coaching, and would guarantee the tool is resented.

**A thread the bot handled alone is never coached.** Assignment does not mean a
person typed. 1,198 threads are assigned; many were answered entirely by the
auto-reply. Coaching someone for work they never did is the fastest way to make
this useless.

**Response time is computed in code, never asked of the model.** It is plain
arithmetic on timestamps, and a model asked to estimate it produces a number that
looks authoritative and is not. Bot replies are ignored: the auto-reply answers
instantly, so counting it would make every response time look perfect. No human
reply reports `null`, not zero — zero would read as instant.

## The four dimensions

Chosen by the owner, and the only things it looks at:

- `unanswered_question` — the customer asked, and never got an answer
- `checklist_skipped` — a listed step was never done
- `slow_response` — the computed reply time was poor, or nobody replied
- `tone` — curt, confusing, or unhelpful handling

It is told not to judge anything outside the thread: calls and in-person
meetings are invisible here, and guessing at them would invent faults.

## Visibility

Enforced in the query layer, not the UI:

- `salesCoach.forMe` — any member reads their **own** coaching. Coaching someone
  without letting them see it is surveillance.
- `salesCoach.forTeam` — supervisor and above only, for everyone's. It returns
  per-person counts of reviews and observations, deliberately **not** a score or
  a league table.

## Shape

- Cron `sales-coach-sweep`, daily. Coaching is not an hourly concern, and nobody
  should find fresh critique waiting every hour.
- `salesCoachConfigs`, `enabled` defaulting false — dormant-safe.
- Usage logs under `coach`.
- A thread is re-reviewed only once it has new messages.

## Out of scope

- Scoring, grading, ranking, or comparing people
- Judging outcomes — the data does not record any
- Anything outside the thread text
