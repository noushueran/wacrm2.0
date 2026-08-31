# UAE Visa Flow Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the auto-reply agent interrogating UAE visa enquiries — remove the code-level pull toward the inside/outside and document-request questions, and give the owner an editable closing message plus an exact checklist of knowledge-base edits to apply.

**Architecture:** Two piles. The **code** pile removes a few-shot anchor in the lead-analysis prompt, adds a standing inference rule ("never ask what the request already implies; never ask for documents"), and adds the missing UI control for `closingMessage`. The **content** pile is delivered as a rollout document the owner applies in /agents → Knowledge, because the live qualification checklists and purchase blocks are rows in the Convex database, not files in this repo.

**Tech Stack:** Convex (backend + DB), Next.js 16 App Router, React, TypeScript, vitest, next-intl, shadcn/ui, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-25-uae-visa-flow-simplification-design.md`

## Global Constraints

- **Never run `convex deploy`, `convex dev`, or `convex codegen`.** The Convex deployment is self-hosted production. Code changes reach it through the normal deploy pipeline, not from this workspace.
- **Do not edit the Convex database.** All knowledge-base changes are delivered as a document for the owner to apply through the /agents UI. Task 4 produces that document; it does not apply it.
- **Stage git paths explicitly** (`git add <path>`), never `git add -A` or `git add .`. Concurrent sessions share this working tree and there are unrelated uncommitted changes in it.
- **Scope lint to changed files:** `npx eslint <paths>`, not bare `npm run lint`.
- **When grepping, use the Grep/Glob tools or scope bash greps to `convex/` and `src/`.** Bash `grep -r` from the repo root traverses `.claude/worktrees/` and returns every hit once per worktree.
- Test runner is vitest: `npm test` runs everything, `npx vitest run <path>` runs one file.
- Only one locale file exists: `messages/en.json`. No other locales to update.

## Deviation from the spec — read before Task 2

Spec §B4 says to make the default closing message Amani-specific, including the phone number `+971 4 589 0001`. **Do not do that.** `amaniDefaultConfig()` in `convex/lib/qualification/defaults.ts` is the default for *every newly created account* in a multi-tenant CRM — baking one tenant's team name and phone number into it means an unrelated new account would start out telling its customers to call Amani.

Task 2 therefore keeps the code default generic. The Amani-specific text (with the phone number) is set by the owner through the new UI field from Task 3, and is documented for them in the Task 4 rollout document. This achieves the spec's actual goal — the owner can put their number in the handoff line — without the tenant leak.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `convex/lib/qualification/analyze.ts` | Modify (~line 121, ~line 129-134) | Builds the lead-analysis prompt. Owns the rules for what the model may propose asking. |
| `convex/lib/qualification/analyze.test.ts` | Modify (test at line 11) | Guards the analysis prompt's contents, including the regression guard against the anchor returning. |
| `convex/lib/qualification/defaults.ts` | Modify (line 77) | Default qualification config for new accounts. |
| `convex/qualificationEngine.test.ts` | Modify (line 546) | Asserts the closing-message send. Its fixture seeds from `amaniDefaultConfig()`, so it breaks when the default text changes. |
| `src/components/settings/qualification-settings.tsx` | Modify | Settings → Lead qualification panel. Gains the closing-message editor. |
| `messages/en.json` | Modify (`Settings.qualification`) | UI copy for the new field. |
| `amani-ai-agent/UAE-VISA-FLOW-ROLLOUT.md` | Create | Owner-applied knowledge-base edits, paste-ready, plus Playground verification cases. |

---

### Task 1: Remove the inside/outside anchor and add the inference rule

The response-schema example at `convex/lib/qualification/analyze.ts:132` hardcodes `"key": "insideUae", "text": "Are you currently inside the UAE or outside?"`. A concrete example in the output contract is a strong few-shot anchor — the model keeps reaching for that exact question even once it is gone from the knowledge-base checklist. This task removes the anchor and adds a standing rule so the behaviour cannot come back through a checklist edit either.

**Files:**
- Modify: `convex/lib/qualification/analyze.ts:121` (instruction 6) and `:129-134` (JSON contract example)
- Test: `convex/lib/qualification/analyze.test.ts:11-22`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. `buildAnalysisPrompt(args: { checklistExcerpts: string[]; basicFields: BasicField[]; knownFields: { key: string; value: string }[]; previousInquiry?: {...} }): string` keeps its existing signature — only the string it returns changes.

- [ ] **Step 1: Write the failing test**

In `convex/lib/qualification/analyze.test.ts`, replace the existing test at lines 11-22 with this expanded version. The three new assertions are the last three lines.

```ts
test("buildAnalysisPrompt embeds checklist excerpts, known fields and the JSON contract", () => {
  const prompt = buildAnalysisPrompt({
    checklistExcerpts: ["QUALIFICATION CHECKLIST — UAE visa\n1. nationality — ask their nationality [required, 20 marks]"],
    basicFields: amaniDefaultConfig().basicFields,
    knownFields: [{ key: "nationality", value: "Indian" }],
  });
  expect(prompt).toContain("QUALIFICATION CHECKLIST — UAE visa");
  expect(prompt).toContain("nationality: Indian"); // known answers listed
  expect(prompt).toContain('"checklistSatisfied"'); // JSON contract
  expect(prompt).toContain('"intent"');
  expect(prompt).toContain("travel_dates"); // fallback basics offered
  // The JSON example must never re-anchor the model on the inside/outside
  // question: it pulled the model back to asking it even after the
  // checklist dropped it (spec 2026-07-25-uae-visa-flow-simplification).
  expect(prompt).not.toContain("inside the UAE or outside");
  expect(prompt).toContain("Never propose a question the customer");
  expect(prompt).toContain("documents, photos, or ID copies");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run convex/lib/qualification/analyze.test.ts
```

Expected: FAIL. Three assertions fail — `not.toContain("inside the UAE or outside")` fails because the string is still in the JSON example, and the two `toContain` checks fail because the rule text does not exist yet.

- [ ] **Step 3: Add the inference rule to instruction 6**

In `convex/lib/qualification/analyze.ts`, find this line (currently line 121):

```ts
      "6. Propose the ONE next question to ask (the most important missing item), with exactly 2 alternate phrasings that sound different but ask the same thing. null when nothing is missing.\n" +
```

Replace it with:

```ts
      "6. Propose the ONE next question to ask (the most important missing item), with exactly 2 alternate phrasings that sound different but ask the same thing. null when nothing is missing. " +
        "Never propose a question the customer's own request already answers: when the service they asked for determines the answer, treat that item as answered and move on. " +
        "Never propose asking the customer to send documents, photos, or ID copies — a human collects those after handoff.\n" +
```

Note this deliberately extends instruction 6 rather than adding a new numbered item, so items 7 and 8 keep their numbers and nothing else in the prompt shifts.

- [ ] **Step 4: Replace the JSON contract example**

Still in `convex/lib/qualification/analyze.ts`, find these lines (currently 129-134):

```ts
      ' "scoreBreakdown": [{"criterion": "nationality", "marks": 20, "maxMarks": 20, "reason": "stated directly"}],' +
      ' "checklistSatisfied": false,' +
      ' "expectedCount": 5,' +
      ' "nextQuestion": {"key": "insideUae", "text": "Are you currently inside the UAE or outside?", "alternates": ["Quick check — are you in the UAE right now, or abroad?", "Just so I guide you right: are you inside the UAE at the moment?"]},' +
      ' "intent": "none",' +
      ' "summary": "Indian national, 60-day UAE tourist visa, travelling next week",' +
```

Replace with:

```ts
      ' "scoreBreakdown": [{"criterion": "nationality", "marks": 30, "maxMarks": 30, "reason": "stated directly"}],' +
      ' "checklistSatisfied": false,' +
      ' "expectedCount": 3,' +
      ' "nextQuestion": {"key": "email", "text": "Which email should we send the details to?", "alternates": ["Could I get an email address for the quote?", "Where should we email the requirements?"]},' +
      ' "intent": "none",' +
      ' "summary": "Indian national, UAE visa extension, email captured",' +
```

Three things changed and each matters: the `nextQuestion` example no longer names a question we never want asked; `expectedCount` and the `marks` figures now match the new 3-item / 30-mark checklist so the example is internally coherent; and the `summary` example no longer implies travel dates are collected.

Keep the surrounding lines (`' "service": "UAE visa" | null,'`, the `"fields"` example, `' "newInquiry": false}'`) exactly as they are — these strings are single-quoted JavaScript containing double-quoted JSON, so avoid introducing apostrophes into the replacement text.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run convex/lib/qualification/analyze.test.ts
```

Expected: PASS, all 5 tests in the file.

- [ ] **Step 6: Typecheck and lint**

```bash
npm run typecheck && npx eslint convex/lib/qualification/analyze.ts convex/lib/qualification/analyze.test.ts
```

Expected: no errors from either.

- [ ] **Step 7: Commit**

```bash
git add convex/lib/qualification/analyze.ts convex/lib/qualification/analyze.test.ts
git commit -m "fix(ai): stop the analysis prompt anchoring on the inside/outside visa question

The response-schema example hardcoded \"Are you currently inside the UAE
or outside?\", which pulled the model back to asking it even when the
checklist had dropped it. Replaced with a neutral email example and added
a standing rule: never propose a question the request already answers,
and never ask the customer for documents or ID copies.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Make the default closing message generic

`convex/lib/qualification/defaults.ts:77` currently reads `"Thank you! Our travel expert will contact you shortly."` — a travel-agency phrasing that does not fit a visa handoff. Make it service-neutral. Read the "Deviation from the spec" section above first: the phone number does **not** go here.

**Files:**
- Modify: `convex/lib/qualification/defaults.ts:77`
- Modify: `convex/qualificationEngine.test.ts:546`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `amaniDefaultConfig()` keeps its signature and every other field unchanged. Only `closingMessage`'s default string value changes.

This task is red-green in the reverse of the usual order: the existing test already pins the old text, so changing the default is what turns it red.

- [ ] **Step 1: Change the default**

In `convex/lib/qualification/defaults.ts`, line 77:

```ts
    closingMessage: "Thank you! Our travel expert will contact you shortly.",
```

becomes:

```ts
    // Deliberately generic: this is the default for EVERY new account, so
    // it must not carry one tenant's team name or phone number. Owners set
    // their own wording in Settings → Lead qualification.
    closingMessage: "Thank you! Our team will contact you shortly.",
```

- [ ] **Step 2: Run the test to verify it now fails**

```bash
npx vitest run convex/qualificationEngine.test.ts -t "sendClosingMessage"
```

Expected: FAIL with `expected "Thank you! Our team will contact you shortly." to contain "travel expert"`. This test seeds its config with `...amaniDefaultConfig()` (`convex/qualificationEngine.test.ts:36`), so it reads the default text you just changed. If it passes instead, Step 1 did not save.

- [ ] **Step 3: Update the assertion to the stable clause**

In `convex/qualificationEngine.test.ts`, line 546, change:

```ts
  expect(messages[0].contentText).toContain("travel expert");
```

to:

```ts
  expect(messages[0].contentText).toContain("contact you shortly");
```

This pins the stable part of the sentence rather than the brand-flavoured noun, so it will not break again the next time the wording is tuned.

- [ ] **Step 4: Run the affected tests**

```bash
npx vitest run convex/qualificationEngine.test.ts convex/qualification.test.ts
```

Expected: PASS. `convex/qualification.test.ts:45` inserts its own `closingMessage` literal into the fixture rather than using the default, so it is unaffected — if it fails, the fixture was changed by mistake; revert that.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: PASS. This catches any other test that relied on the old default text.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/qualification/defaults.ts convex/qualificationEngine.test.ts
git commit -m "fix(qualification): make the default closing message service-neutral

\"Our travel expert will contact you shortly\" does not fit a visa
handoff. The default stays generic on purpose — it applies to every new
account, so it must not carry one tenant's team name or number. Loosened
the engine test to assert the stable clause instead of the noun.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Add the closing-message editor to Settings → Lead qualification

`closingMessage` is already whitelisted for updates (`convex/lib/qualification/validate.ts:85`, which only requires it be a string) but has **no UI control anywhere in the app**. Today it can only be changed by a direct API call, so the owner cannot put their phone number in the handoff line. This task adds the field. No backend change is needed.

**Files:**
- Modify: `src/components/settings/qualification-settings.tsx`
- Modify: `messages/en.json` (under `Settings.qualification`)

**Interfaces:**
- Consumes: `api.qualification.getConfig` returns the whole config row spread into the result (`convex/qualification.ts:47-58`), so `config.closingMessage` is a `string` and is already available — no query change needed. `api.qualification.updateConfig` takes `{ patch: { closingMessage?: string } }`.
- Produces: no exports. `QualificationSettings()` keeps its zero-argument signature.

- [ ] **Step 1: Add the i18n copy**

In `messages/en.json`, inside the `Settings.qualification` object, add a `closing` block as a sibling of the existing `contactCard` block:

```json
    "closing": {
      "title": "Closing message",
      "desc": "The final message sent automatically once a lead has answered everything, just before a human takes over. Use it to set expectations and give your direct number.",
      "placeholder": "Thank you! Our team will contact you shortly.",
      "hint": "Leave this empty to send no closing message at all. Written exactly as the customer receives it — no placeholders are substituted.",
      "save": "Save closing message",
      "saved": "Saved",
      "saveError": "Could not save the closing message."
    },
```

The `hint` is not decoration: `convex/qualificationEngine.ts:1195` returns early when `closingMessage.trim()` is empty, so clearing the box genuinely disables the send. The owner needs to know that clearing it is a real off switch and not a mistake.

- [ ] **Step 2: Import Textarea**

In `src/components/settings/qualification-settings.tsx`, the imports at lines 10-15 include `Input` but not `Textarea`. Add it after the `Switch` import:

```tsx
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
```

- [ ] **Step 3: Add the form state**

After the contact-card state declarations (near line 86, just before `const [hydrated, setHydrated] = useState(false);`), add:

```tsx
  // Closing message — the one field that had no UI at all; it was
  // API-editable only. Same hydrate-once pattern as the blocks above.
  const [closing, setClosing] = useState('');
  const [closingSaving, setClosingSaving] = useState(false);
  const [closingError, setClosingError] = useState<string | null>(null);
  const [closingSaved, setClosingSaved] = useState(false);
```

- [ ] **Step 4: Hydrate it from the stored config**

In the `useEffect` that hydrates the form (lines 88-109), add this line alongside the other setters — put it directly after `setAlertTemplateName(...)`:

```tsx
    setClosing(config.closingMessage ?? '');
```

The `?? ''` guard matters: `closingMessage` is a required `v.string()` in the schema, but a `Textarea` given `undefined` becomes an uncontrolled input and React warns.

- [ ] **Step 5: Add the save handler**

After `onSaveCard` (which ends around line 184) and before `const setCardField = ...`, add:

```tsx
  const onSaveClosing = async () => {
    setClosingSaving(true);
    setClosingError(null);
    setClosingSaved(false);
    try {
      // Not trimmed to empty-as-undefined: an empty string is a real,
      // meaningful value here — it turns the closing message off
      // (qualificationEngine.sendClosingMessage bails on a blank).
      await updateConfig({ patch: { closingMessage: closing } });
      setClosingSaved(true);
    } catch (err) {
      const data = (err as { data?: { reason?: string } })?.data;
      setClosingError(data?.reason ?? t('closing.saveError'));
    } finally {
      setClosingSaving(false);
    }
  };
```

- [ ] **Step 6: Render the card**

In the returned JSX, insert this `<Card>` immediately before the `<Card>` that renders `{t('defaultsTitle')}` (currently line 474), so the editable field sits above the read-only "Active configuration" summary:

```tsx
            <Card>
              <CardContent className="space-y-3 pt-6 text-sm">
                <p className="font-medium text-foreground">{t('closing.title')}</p>
                <p className="text-muted-foreground">{t('closing.desc')}</p>
                <Textarea
                  value={closing}
                  onChange={(e) => setClosing(e.target.value)}
                  placeholder={t('closing.placeholder')}
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">{t('closing.hint')}</p>
                <div className="flex items-center gap-3">
                  <Button size="sm" onClick={onSaveClosing} disabled={closingSaving}>
                    {closingSaving ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {t('closing.save')}
                  </Button>
                  {closingSaved ? (
                    <span className="text-xs text-emerald-500">{t('closing.saved')}</span>
                  ) : null}
                  {closingError ? (
                    <span className="text-xs text-red-400">{closingError}</span>
                  ) : null}
                </div>
              </CardContent>
            </Card>
```

- [ ] **Step 7: Typecheck and lint**

```bash
npm run typecheck && npx eslint src/components/settings/qualification-settings.tsx
```

Expected: no errors. A missing i18n key does not fail typecheck — if the UI later renders the literal `closing.title`, Step 1 was not applied correctly.

- [ ] **Step 8: Verify the JSON stayed valid**

```bash
python3 -c "import json; json.load(open('messages/en.json')); print('valid')"
```

Expected: `valid`. A trailing comma in Step 1 is the most likely mistake and it breaks the whole app at runtime, not at typecheck.

- [ ] **Step 9: Run the suite**

```bash
npm test
```

Expected: PASS. No component test is added — there are none anywhere in `src/components/settings/`, and this is a controlled textarea calling an already-validated mutation, so a test here would break convention without adding coverage.

- [ ] **Step 10: Commit**

```bash
git add src/components/settings/qualification-settings.tsx messages/en.json
git commit -m "feat(qualification): let admins edit the closing message

closingMessage was whitelisted for updates but had no UI control
anywhere, so it could only be changed by a direct API call — meaning
owners could not put their own phone number in the handoff line. Adds a
textarea to Settings → Lead qualification, and documents that clearing
it disables the closing message entirely.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Write the owner rollout document

The live qualification checklists and purchase blocks are rows in the Convex database, editable only through /agents → Knowledge. This task produces the exact content for the owner to apply. It does **not** touch the database.

**Files:**
- Create: `amani-ai-agent/UAE-VISA-FLOW-ROLLOUT.md`

**Interfaces:**
- Consumes: the closing-message field shipped in Task 3 (the document tells the owner where to paste their phone-number text).
- Produces: nothing consumed by code.

- [ ] **Step 1: Create the document**

Write `amani-ai-agent/UAE-VISA-FLOW-ROLLOUT.md` with exactly this content:

````markdown
# UAE Visa Flow — Owner Rollout Checklist

Apply these in order, in `wa.amaniworld.com/agents`. Everything here is a data
edit in the Convex database — nothing in this list requires a deploy.

Spec: `docs/superpowers/specs/2026-07-25-uae-visa-flow-simplification-design.md`

**Before you start:** the code changes should already be deployed. They remove the
model's pull back toward the old questions; these edits are what actually change
what the customer experiences.

**Save vs. Publish:** clicking Save only stores a draft — it does not change what
the AI reads. Nothing reaches the AI until you click **Publish**. Until you do, the
previously published version stays live even though the block's badge will read
Draft.

**If auto-reply is already switched on**, do steps 1, 2, 3, 5 and 6 first — those are
the ones that change what a live customer experiences: the old question lists, the
wording that promises to ask them for documents, and the Business Context prompt text
that is handed to the reply model directly. Step 4 only changes what gets reported to
Meta as a conversion, so it can follow. You will be applying these one at a time
against a live agent, so for the few minutes in between, some conversations may still
see the old questions. That is expected and self-corrects.

---

## 1. Replace the umbrella qualification checklist

**/agents → Knowledge → UAE Visa Services → Qualification**

The editor will not save an empty checklist, so add the three new items **first**,
then remove the old ones — not the other way around.

Add these three:

| Label | Marks | Question |
|---|---|---|
| Which visa service | 30 | Are you looking to extend a visa, change your visa status, or apply for a new visa? |
| Applicant nationality | 30 | May I know the applicant's nationality? |
| Email address | 40 | What's the best email to send the requirements and quote to? |

Then remove all six of the original items.

The running marks total is shown live as you edit, and must read exactly **100** or
publish is rejected. 30 + 30 + 40 = 100. ✅

There is no separate "bonus signal" field in this editor — every row here is an
ordinary scored item whose marks count toward that total. If you find any extra
scored rows left over from before (e.g. "needs the visa within 7 days", "multiple
applicants"), remove those too and keep only the three items above.

**Never let this checklist drop below three items.** Lead completion requires at
least three answers actually collected from the conversation; with fewer than three
the lead never completes, and the bot falls back to asking generic travel questions.

Then click Publish.

## 2. Unpublish the three pathway qualification checklists

**/agents → Knowledge →** for each of `UAE Tourist Visa (New)`,
`UAE Visa Extension`, `UAE Visa Change` → **Qualification** → click **Unpublish**.
The Unpublish button only appears while the block shows **Published**. This sets the
block to Draft and recompiles — the content stays saved and nothing is lost, but it
is out of the AI's reach immediately.

This is the step that removes the "are you sponsored by Amani?" question and the
"how many extensions have you had?" question. Leave every prose entry alone —
prices, process, FAQs and requirements all stay, so the bot still answers
pathway questions properly.

## 3. Add the internal note

**/agents → Knowledge →** add as an **internal**-audience Note on both
`UAE Visa Services` and `UAE Visa Extension`:

```
Never ask whether the customer's visa is sponsored by Amani, and never tell a
customer their visa "is not under Amani". State the condition once as neutral
information — "extensions are possible for visas issued through us; our visa team
will confirm what applies to yours" — and let the team verify. Never ask for a visa
copy, passport copy, Emirates ID or any document in chat. The team collects
documents after they make contact. Never ask whether the customer is inside or
outside the UAE: a new visa implies outside, an extension or status change implies
inside.

Disqualify, do not score as a lead: job seekers and CV submissions, employment or
work permit enquiries we do not process, supplier and partnership pitches, wrong
numbers.
```

Make sure the audience is set to **Internal only** — this is instruction, not something a
customer should ever be quoted.

Then click Publish.

## 4. Replace the umbrella purchase criteria

**/agents → Knowledge → UAE Visa Services → Purchase**

The current block says *"Routed to a specific pathway — use that pathway's own
Purchase criteria once identified"*, which no condition engine can evaluate, and
requires the customer to have SENT documents in chat. Replace both conditions
with:

```
- Which visa service, nationality and email are all confirmed.
- The customer has clearly signalled they want to go ahead — asks to book, asks how to pay, accepts a quoted price, or says to proceed.
```

**Report value: _____ AED** — fill in your average visa margin. The current
400 AED is a placeholder someone invented (KB-AUDIT.md §5.3). This number is sent
to Meta and directly drives ad-spend optimisation, so a wrong value costs real
money.

Then click Publish.

### Also unpublish the three pathway Purchase blocks

**/agents → Knowledge →** for each of `UAE Tourist Visa (New)`, `UAE Visa Extension`,
`UAE Visa Change` → **Purchase** → click **Unpublish**. The Unpublish button only
appears while the block shows **Published**. This sets the block to Draft and
recompiles — the content stays saved and nothing is lost, but it is out of the AI's
reach immediately.

Do not skip this. The Purchase judge runs its own knowledge search keyed on whatever
service name the model decided the conversation was about, and that name is free text
the model writes — it is not limited to services that still have a Qualification
block. So if the model labels a conversation "UAE Visa Extension", the judge can still
pull that pathway's own Purchase block, which still demands documents. Unpublishing
them leaves the umbrella block as the only one it can find, which is what makes a
single report value correct.

This does not change what the customer sees — Purchase criteria are never quoted into
a customer-facing reply. What it changes is whether Meta receives a Purchase event at
all, and against which value.

## 5. Reword the Process entry

**/agents → Knowledge → UAE Visa Services → Process**

Change:

> We ask for your email and any documents needed (passport copy, photo).

to:

> We collect your email here; our visa team requests any documents directly when
> they contact you.

**Leave the Requirements entries as they are.** If a customer asks "what
documents do you need?", listing them is a correct and useful answer. We are only
stopping the bot from *demanding* documents.

Then click Publish.

## 6. Update the Business Context prompt

**/agents → Setup → Business context & instructions**

Find the `UAE visa` line in the "WHAT TO FIND OUT" checklist. It currently reads:

```
UAE visa: nationality → which visa / how long → inside or outside the UAE → travel dates → email (last).
```

Replace with:

```
UAE visa: which service (extend / change / new) → nationality → email (last).
```

Left alone, that stale line contradicts the new checklist and keeps pulling the
model back toward the old questions.

Then add the disqualification rules to the same prompt:

```
Never treat these as leads: job seekers and CV submissions, employment or work
permit enquiries, supplier and partnership pitches, wrong numbers.
```

## 7. Set your closing message

**Settings → Lead qualification → Closing message**

This field is new. Paste:

```
Thank you! Our UAE visa team will contact you shortly on this number. You can also reach us on +971 4 589 0001, daily 10 AM–9 PM (closed Sundays).
```

Leaving the field empty sends no closing message at all.

---

## 8. Verify in the Playground

**/agents → Playground.** This runs the same prompt-assembly path as live
auto-reply, so it is a real test.

| Type this | Expected |
|---|---|
| I want to extend my visa | Asks nationality. **No** sponsor question, **no** inside/outside question, **no** document request. |
| I need a new tourist visa | Asks nationality. **No** inside/outside question. |
| visa? | Asks the three-way extend / change / new question first. |
| I'm looking for a job, here's my CV | Marked disqualified, not scored as a lead. |
| Run one all the way to giving an email | Closing message fires, with your phone number in it. |

A full run should take **two** questions, not six — most customers state their
intent in their first message, which already answers item 1.

## 9. Enable auto-reply

**/agents → Setup → Auto-reply.** Only after the Playground cases above look
right. Watch the first few real conversations in the inbox before walking away
from it.
````

- [ ] **Step 2: Verify the marks arithmetic and the checklist is complete**

```bash
grep -c "^## " amani-ai-agent/UAE-VISA-FLOW-ROLLOUT.md
```

Expected: `9` — one heading per rollout step. Then re-read the table in section 1 and confirm 30 + 30 + 40 = 100, because `convex/lib/kb/lint.ts:97` rejects publish on any other sum and the owner will hit that error live.

- [ ] **Step 3: Commit**

```bash
git add amani-ai-agent/UAE-VISA-FLOW-ROLLOUT.md
git commit -m "docs(ai): owner rollout checklist for the simplified UAE visa flow

The live qualification checklists and purchase blocks are Convex DB rows
editable only through /agents → Knowledge, so the content half of the
visa simplification ships as a paste-ready checklist rather than code.
Includes the Playground cases that verify it and the report-value blank
the owner must fill in.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification

After all four tasks:

```bash
npm test && npm run typecheck
```

Expected: full suite passes, no type errors.

```bash
npx eslint convex/lib/qualification/analyze.ts convex/lib/qualification/defaults.ts src/components/settings/qualification-settings.tsx
```

Expected: clean.

The knowledge-base half cannot be verified from this repo — it is DB data behind the owner's login, and Convex commands are not run against the self-hosted production deployment. Section 8 of the rollout document is that verification, and it is the owner's to run.

## Out of scope

- The other six services' checklists (Dubai packages, international holidays, ladies-only tours, and the rest). Same trimming pattern applies later. Three of them also have purchase blocks that can never fire because they require a budget their checklists never ask for (`amani-ai-agent/KB-AUDIT.md` §5.1).
- A stop condition on the one-question-per-reply rule at `convex/lib/ai/defaults.ts:172`. With a three-item checklist the flow ends after two questions on its own, so a cap would be dead code.
- Syncing `amani-ai-agent/knowledge-base-full.md` with the live DB (repo copy has 6 services, live has 10). Documentation drift, not agent behaviour.
