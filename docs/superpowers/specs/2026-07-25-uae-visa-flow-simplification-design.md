# UAE Visa Flow Simplification — Design

**Date:** 2026-07-25
**Status:** Approved, ready for implementation plan

## Problem

The auto-reply agent interrogates UAE visa enquiries. A customer who says "I want to
extend my visa" is asked their nationality, which visa and for how long, whether they
are inside or outside the UAE, their travel dates, when their current visa expires,
their email, whether Amani sponsors their visa, and how many extensions they have
already taken — then asked to send a visa copy, which the bot inspects and answers
"no, the visa is not under Amani."

Two of those questions are redundant, one is a rejection the bot should never make, and
the document request contradicts the company's own human SOP.

### Why it happens

Three layers independently push "ask one more thing":

1. **The live qualification checklists (Convex DB).** UAE visa is four services: an
   umbrella router plus New / Extension / Change pathways. The umbrella asks six items;
   routing to a pathway then adds the sponsor check and the extension-count question on
   top. `convex/lib/qualification/analyze.ts:119` only sets `checklistSatisfied` when
   *every* required item is answered, so the full list must be exhausted before the lead
   can complete. Result: a guaranteed 6–8 turn interrogation.

2. **`PURCHASE CRITERIA — UAE Visa Services` (Convex DB).** Requires that *"the customer
   has SENT the required documents in the chat (passport copy / photo)"*. This is what
   makes the bot chase the visa copy. It directly contradicts
   `amani-ai-agent/Sales-Agent-SOP-Incoming-Messages.md:29`, which forbids collecting
   passport or Emirates ID details in chat. The block's other condition is an instruction
   rather than a verifiable condition (*"use that pathway's own Purchase criteria once
   identified"*), already flagged dead in `amani-ai-agent/KB-AUDIT.md` §5.2.

3. **The prompt scaffold (code).** `convex/lib/ai/defaults.ts:172` instructs the model to
   *"weave in exactly ONE question"* into every reply, with no stop condition. Worse,
   `convex/lib/qualification/analyze.ts:132` hardcodes
   `"nextQuestion": {"key": "insideUae", "text": "Are you currently inside the UAE or outside?"}`
   into the response-schema example — a few-shot anchor that pulls the model toward that
   specific question even when it is absent from the checklist.

**Where the content lives matters.** The checklists and purchase blocks are rows in the
Convex database, editable through /agents → Knowledge. They are **not** in this repo.
`amani-ai-agent/knowledge-base-full.md` is a stale paste-ready copy covering 6 services;
the live DB has 10 (`amani-ai-agent/KB-AUDIT.md`). This design therefore splits into a
code change and a set of owner-applied data edits.

## Principle

The AI agent attends the initial conversation, answers basic questions, captures a
minimal lead, and hands off. It does not verify eligibility, does not collect documents,
and does not reject anyone. A human handles every hard step.

Corollary: **intent implies location.** A new visa means the applicant is outside the UAE
(they must exit and re-enter to take one). An extension or a status change is only
possible from inside. Asking is redundant.

## The new flow

Qualification collapses to three items on the umbrella service. Marks total exactly 100 —
`convex/lib/kb/lint.ts:97` rejects any other sum on publish.

| Item | Marks | Question |
|---|---|---|
| `service_intent` | 30 | Are you looking to extend a visa, change your visa status, or apply for a new visa? |
| `nationality` | 30 | May I know the applicant's nationality? |
| `email` | 40 | What's the best email to send the requirements and quote to? |

Inside/outside, sponsorship, travel dates, current visa expiry, extension count and all
documents are removed entirely. The mobile number is not asked for — the customer is
messaging on WhatsApp, so it is already on the contact record and visible to the human in
the inbox.

Most customers state their intent in their first message, so item 1 is usually already
satisfied and only two questions are asked:

> **Customer:** I want to extend my visa
> **Bot:** Happy to help with that. Extensions are possible for visas issued through us —
> our visa team will confirm what applies to yours. May I know the applicant's nationality?
> **Customer:** Indian
> **Bot:** Thank you. What's the best email to send the requirements and the quote to?
> **Customer:** x@y.com
> **Bot:** Thank you! Our UAE visa team will contact you shortly on this number. You can
> also reach us on +971 4 589 0001, daily 10 AM–9 PM (closed Sundays).

Only a vague opener ("visa?") triggers the three-way intent question first.

### Eligibility, without interrogation

Amani can only extend visas it sponsored itself (max 2×30 days), so the constraint is
real and cannot simply be ignored — a customer sponsored elsewhere would otherwise wait
for a call expecting something impossible.

The bot states the condition **once, as neutral information**, and never evaluates the
customer's case: *"extensions are possible for visas issued through us — our visa team
will confirm what applies to yours."* It is a statement, not a question, and not a
rejection. It costs no extra turns. The visa team verifies.

## Approach

**Collapse visa qualification onto the umbrella service and delete the pathway
qualification blocks.** The three pathways keep all of their prose entries — prices,
process, FAQs, requirements — so pathway-specific questions are still answered well. They
simply stop carrying question lists, which is what removes the sponsor check at the root:
routing to a pathway can no longer re-open a round of questions.

Rejected alternatives:

- **Four trimmed checklists, one per service.** Near-identical lists drift apart under
  maintenance, and the umbrella→pathway hop can still restart questioning mid-conversation.
- **Hardcode a visa branch in code.** Fights the architecture, which deliberately keeps
  question flows in owner-editable knowledge (`convex/lib/qualification/defaults.ts:10-11`),
  and takes the flow out of the owner's hands.

## Changes — Pile A: Knowledge base (owner-applied, /agents → Knowledge, no deploy)

### A1. `UAE Visa Services` → qualification block

Replace all six items with:

```
QUALIFICATION CHECKLIST — UAE Visa Services
- Which visa service (30 marks) — ask: Are you looking to extend a visa, change your visa status, or apply for a new visa?
- Applicant nationality (30 marks) — ask: May I know the applicant's nationality?
- Email address (40 marks) — ask: What's the best email to send the requirements and quote to?
```

There is no separate "bonus signal" field in this data model — a checklist item carries
only a label, a question and marks, so any such row is an ordinary scored item whose
marks count toward the total. Any extra scored rows carried over from before (e.g. "needs
the visa within 7 days", "multiple applicants") must be removed too, or the sum exceeds
100 and publish is rejected.

**This checklist must never drop below three items.** Lead completion requires at least
three answers actually collected from the conversation; with fewer than three the lead
never completes and the bot reverts to asking generic travel questions.

### A2. Delete the qualification blocks on the three pathways

`UAE Tourist Visa (New)`, `UAE Visa Extension`, `UAE Visa Change`. This is the step that
removes the sponsor check and the "how many extensions so far" question. Prose entries
stay untouched.

### A3. Internal note — add to the umbrella and to `UAE Visa Extension`

```
Never ask whether the customer's visa is sponsored by Amani, and never tell a customer
their visa "is not under Amani". State the condition once as neutral information —
"extensions are possible for visas issued through us; our visa team will confirm what
applies to yours" — and let the team verify. Never ask for a visa copy, passport copy,
Emirates ID or any document in chat. The team collects documents after they make contact.
Never ask whether the customer is inside or outside the UAE: a new visa implies outside,
an extension or status change implies inside.

Disqualify, do not score as a lead: job seekers and CV submissions, employment or work
permit enquiries we do not process, supplier and partnership pitches, wrong numbers.
```

The disqualification sentence restores rules dropped in the `kbOpsBlocks` schema
migration (`amani-ai-agent/KB-AUDIT.md` §5.4). The new schema has no disqualification
field, so internal notes and the Business Context prompt are the only available homes. A
Dubai visa agency receives high volumes of CV spam; without this every one of them is
scored and pushed into the pipeline as a real lead, polluting both lead data and Meta
optimisation.

### A4. `UAE Visa Services` → purchase block

Replace entirely:

```
PURCHASE CRITERIA — UAE Visa Services
- Which visa service, nationality and email are all confirmed.
- The customer has clearly signalled they want to go ahead — asks to book, asks how to pay, accepts a quoted price, or says to proceed.
Report value: <PENDING — owner to supply average visa margin in AED>
```

No document condition. The explicit go-ahead signal keeps the Purchase event meaningfully
stricter than a qualified Lead, which is the entire purpose of the second judge
(`convex/qualificationEngine.ts:837-845`), without asking for anything.

**One report value, not four — but only if the pathway Purchase blocks are also deleted.**
Qualification no longer matching the pathway services does not stop pathway Purchase
retrieval: `parseAnalysis` sets `serviceName` from `obj.service`, free text the model
writes with no constraint to services that still have a Qualification block
(`convex/lib/qualification/analyze.ts:150`), and the Purchase judge retrieves keyed on
that name regardless — `` `PURCHASE CRITERIA ${context.serviceName ?? ""} ${latest}` ``
(`convex/qualificationEngine.ts:1131`). So a session the model labels "UAE Visa Extension"
would still find that pathway's own Purchase block. The three pathway Purchase blocks
must be deleted too (rollout step 4); only then is the umbrella block the sole one
retrievable, making a single report value correct by construction.

**Open input:** the current 400 AED is an invented placeholder
(`amani-ai-agent/KB-AUDIT.md` §5.3). The owner will supply the real average visa margin.
Implementation is not blocked on it — the value is set in the UI when A4 is applied.

### A5. Reword the Process entry

Currently: *"We ask for your email and any documents needed (passport copy, photo)."*
Becomes: *"We collect your email here; our visa team requests any documents directly when
they contact you."*

Requirements entries are **not** changed. If a customer asks "what documents do you
need?", listing them is a correct and useful answer. The fix targets the bot *demanding*
documents, not its ability to describe them.

### A6. Business Context (/agents → Setup)

Update the `UAE visa` line in the "WHAT TO FIND OUT" checklist from
`nationality → which visa / how long → inside or outside the UAE → travel dates → email`
to `which service (extend / change / new) → nationality → email`. Add the
disqualification rules from A3.

## Changes — Pile B: Code (this repo)

### B1. `convex/lib/qualification/analyze.ts:132` — remove the few-shot anchor

The response-schema example hardcodes the inside/outside visa question. A concrete example
in the output contract is a strong anchor; the model will keep reaching for that question
after it leaves the checklist. Replace the `nextQuestion` example with a service-neutral
`email` one, and change the illustrative `expectedCount` from 5 to 3.

### B2. `convex/lib/qualification/analyze.ts:115-124` — add a standing inference rule

Add to the numbered instruction list: never propose a question whose answer the
customer's own request already implies (if the service asked for determines the answer,
treat the item as answered), and never propose asking the customer for documents, photos
or ID copies.

This belongs in code rather than knowledge because it is a reasoning rule, not business
content — and it protects the flow if an inside/outside item is ever re-added to a
checklist.

Media handling is unchanged: `convex/aiReply.ts:820-850` still transcribes and describes
documents customers send voluntarily. Only the bot's *asking* is removed.

### B3. `src/components/settings/qualification-settings.tsx` — add a Closing message field

`closingMessage` is whitelisted for updates (`convex/lib/qualification/validate.ts:25`)
but has no UI control anywhere, so today it can only be changed by a direct API call.
Without this field the owner cannot put a phone number in the handoff line. Add a
controlled textarea to the existing qualification settings panel.

### B4. `convex/lib/qualification/defaults.ts:77` — update the default closing message

From `"Thank you! Our travel expert will contact you shortly."` to:

> Thank you! Our UAE visa team will contact you shortly on this number. You can also reach
> us on +971 4 589 0001, daily 10 AM–9 PM (closed Sundays).

This affects newly created accounts only. The live account's value is already in the DB
and is changed through the B3 field.

## Testing

**Code:** `npm test` (vitest). Extend the existing test at
`convex/lib/qualification/analyze.test.ts:11` with two assertions:

- the prompt contains the new inference rule from B2
- the prompt does **not** contain `inside the UAE or outside` — a regression guard against
  the anchor being reintroduced

No component test for B3. There are no tests in `src/components/settings/`; the field is a
controlled textarea calling an already-tested mutation, so a test there would break
convention without adding coverage.

**Knowledge base:** cannot be verified from this repo — the blocks are DB rows behind the
owner's login, and Convex commands are not run against the self-hosted production
deployment. Verify in /agents → Playground, which exercises the same `buildSystemPrompt`
path as live auto-reply (`convex/aiReply.ts:1539`).

| Input | Expected |
|---|---|
| "I want to extend my visa" | Asks nationality. No sponsor question, no inside/outside question, no document request. |
| "I need a new tourist visa" | Asks nationality. No inside/outside question. |
| "visa?" | Asks the three-way extend / change / new question first. |
| "I'm looking for a job, here's my CV" | Disqualified, not scored as a lead. |
| Full run to email | Closing message fires with the phone number. |

## Rollout

1. Merge and deploy the code changes (Pile B).
2. Apply the knowledge base edits (Pile A) and publish.
3. Playground-test the five cases above.
4. Owner enables auto-reply in /agents → Setup.

Order matters: the KB edits are what change customer-facing behaviour and take effect on
publish; the code changes remove the model's pull back toward the old questions. If
auto-reply turns out to already be live, apply A4 first — the document chase is the worst
of the current behaviour.

## Out of scope

- **The other six services.** The same trimming pattern applies to Dubai packages,
  international holidays, ladies-only tours and the rest, as follow-up work. Note that
  three of them have purchase blocks that can never fire because they require a budget
  their checklists never ask for (`amani-ai-agent/KB-AUDIT.md` §5.1) — a related but
  separate problem.
- **A stop condition on the one-question-per-reply rule**
  (`convex/lib/ai/defaults.ts:172`). With a three-item checklist the flow ends after two
  questions on its own, so a cap would be dead code. Revisit only if the short flow still
  reads as pushy in practice.
- **Syncing `amani-ai-agent/knowledge-base-full.md` with the live DB.** The repo copy is
  stale (6 services vs 10 live). Worth doing, but it is documentation drift, not agent
  behaviour.
