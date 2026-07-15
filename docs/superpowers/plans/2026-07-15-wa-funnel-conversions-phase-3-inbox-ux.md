# WA Funnel Conversions — Phase 3: Inbox stage-tracker UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents see and advance a conversation's funnel stage from the inbox — a stage dropdown in the thread header (with a Purchase-value dialog), and a stepper in the contact sidebar showing each stage's progress + whether it was reported to Meta.

**Architecture:** A read-only `api.funnel.getState` query composes the conversation's funnel (current stage + sale value), its `funnelTransitions` (reached-at), and its `conversionEvents` (per-stage Meta status). A pure `buildFunnelSteps` helper turns that into an ordered step list the UI renders. The thread header gets a stage `DropdownMenu` mirroring the existing status dropdown (calling `api.funnel.setStage`); `Purchased` opens a value `Dialog` first. The sidebar gets a stepper `Section`. Stage labels come from i18n; the stage order/flags from a small UI config mirror.

**Tech Stack:** Next.js (App Router) + React, Convex (`useQuery`/`useMutation`), shadcn UI (DropdownMenu/Dialog/Input/Button), next-intl, `convex-test` + Vitest.

## Global Constraints

- **Offline codegen only.** NEVER run `convex dev`/`deploy`/`codegen`. New Convex function in the existing `convex/funnel.ts` module needs NO `api.d.ts` edit (the module is already registered). New frontend files are not Convex modules.
- **Stage files EXPLICITLY by exact path.** NEVER `git add -A` (untracked `.claude/worktrees/*` present).
- **Match file style.** Convex files double-quoted; frontend files follow their own local style. No broad `prettier --write`.
- **i18n = single locale:** `messages/en.json` only.
- **Lint gate:** the repo has pre-existing lint debt — the gate is "`npm run build` passes AND this diff adds no NEW lint finding," not global-clean.
- **UI verification is auth-gated:** the inbox is behind login, so there is no interactive click-through in CI/test. Verify UI via `npm run typecheck` + `npm run lint` (no new findings) + `npm run build`, plus the Task-1 unit tests for the query + pure helper. Do NOT claim interactive verification.
- **Access parity:** the stage dropdown is hidden for `accountRole === "viewer"` (same as the status dropdown). `setStage` is `"own"`-gated server-side, so a non-owner agent's click fails with a toast — identical to the existing status dropdown's behavior. Do not add extra client ownership logic.
- **TDD** for Task 1 (query + pure helper). Tasks 2–3 are UI wiring verified via build/lint/typecheck (the ctwa-ad-inbox UI precedent).

---

## File Structure

- **Modify** `convex/funnel.ts` — add the `getState` accountQuery.
- **Modify** `convex/funnel.test.ts` — `getState` tests.
- **Create** `src/lib/inbox/funnel.ts` — UI stage config mirror (ordered keys + `internalOnly`/`needsValue`).
- **Create** `src/lib/inbox/funnelView.ts` — pure `buildFunnelSteps`.
- **Create** `src/lib/inbox/funnelView.test.ts`.
- **Modify** `messages/en.json` — `Inbox.funnel` namespace.
- **Modify** `src/components/inbox/message-thread.tsx` — stage dropdown + Purchase value dialog.
- **Modify** `src/components/inbox/contact-sidebar.tsx` — funnel stepper Section (+ `conversationId` prop).
- **Modify** `src/components/inbox/contact-panel-drawer.tsx` — thread `conversationId` through to the sidebar.

---

### Task 1: Read query + pure view helper + i18n

**Files:**
- Modify: `convex/funnel.ts`, `convex/funnel.test.ts`
- Create: `src/lib/inbox/funnel.ts`, `src/lib/inbox/funnelView.ts`, `src/lib/inbox/funnelView.test.ts`
- Modify: `messages/en.json`

**Interfaces:**
- Produces: `api.funnel.getState({ conversationId }) → FunnelState` (below); `UI_FUNNEL_STAGES` + `UI_FUNNEL_STAGE_KEYS` + `UiFunnelStageKey` (`src/lib/inbox/funnel.ts`); `buildFunnelSteps(state) → FunnelStep[]` (`src/lib/inbox/funnelView.ts`).

```ts
// FunnelState (returned by getState; also the input to buildFunnelSteps)
type MetaStatus = "pending" | "sent" | "unmatched" | "error" | "abandoned";
interface FunnelState {
  attributed: boolean;
  lane: "code" | "ctwa" | null;
  currentStage: string | null;      // a UiFunnelStageKey or null
  saleValue?: number;
  saleCurrency?: string;
  reachedAt: Record<string, number>;   // stageKey → earliest transition time (ms)
  metaStatus: Record<string, MetaStatus>; // stageKey → its conversionEvents status
}
```

- [ ] **Step 1: Write the failing test for the query** — add to `convex/funnel.test.ts` (reuse its existing `seedAccountMember`/`seedConv` helpers):

```ts
test("getState composes current stage, reached-at, and per-stage Meta status", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Gia", email: "gia@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { lane: "ctwa", identifier: "clid-1", assignedToUserId: userId });

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "price_quoted" });

  const state = await asUser.query(api.funnel.getState, { conversationId });
  expect(state.attributed).toBe(true);
  expect(state.lane).toBe("ctwa");
  expect(state.currentStage).toBe("price_quoted");
  expect(state.reachedAt.price_quoted).toBeGreaterThan(0);
  expect(state.reachedAt.new_lead).toBeGreaterThan(0); // seedConv seeds the new_lead anchor's transition? see note
  expect(state.metaStatus.price_quoted).toBe("pending"); // dormant → pending
});

test("getState for an organic conversation reports attributed:false", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Hal", email: "hal@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { assignedToUserId: userId }); // organic
  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "qualified" });

  const state = await asUser.query(api.funnel.getState, { conversationId });
  expect(state.attributed).toBe(false);
  expect(state.lane).toBeNull();
  expect(state.currentStage).toBe("qualified");
  expect(Object.keys(state.metaStatus)).toHaveLength(0);
});
```

Note: `seedConv` (Phase 2 test helper) seeds a `new_lead` conversionEvent anchor but NOT a `new_lead` funnelTransition. So `reachedAt.new_lead` will be absent unless a transition exists. **Adjust the first test** to assert `reachedAt.price_quoted` only (drop the `new_lead` reached-at assertion), OR have `getState` also treat the `new_lead` conversionEvent as an implicit reached marker. Keep it simple: assert only stages that have a `funnelTransitions` row (`price_quoted`). Remove the `reachedAt.new_lead` line.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- funnel.test`
Expected: FAIL — `api.funnel.getState` undefined.

- [ ] **Step 3: Add the query** — in `convex/funnel.ts`, add the imports `accountQuery` (already importing from `./lib/auth`? it imports `accountMutation` — add `accountQuery` to that import) and add:

```ts
export const getState = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );

    const transitions = await ctx.db
      .query("funnelTransitions")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
    const reachedAt: Record<string, number> = {};
    for (const tr of transitions) {
      const at = tr._creationTime;
      if (reachedAt[tr.stage] === undefined || at < reachedAt[tr.stage]) {
        reachedAt[tr.stage] = at;
      }
    }

    const events = await ctx.db
      .query("conversionEvents")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
    const metaStatus: Record<string, string> = {};
    for (const ev of events) {
      metaStatus[ev.stage] = ev.status;
    }

    return {
      attributed: conversation.attribution !== undefined,
      lane: conversation.attribution?.lane ?? null,
      currentStage: conversation.funnel?.stage ?? null,
      saleValue: conversation.funnel?.saleValue,
      saleCurrency: conversation.funnel?.saleCurrency,
      reachedAt,
      metaStatus,
    };
  },
});
```

(`accountQuery` provides `ctx.requireRole` etc.; reading is `"view"` access — no `requireRole` needed beyond membership, matching how other read queries here gate. If `requireConversationAccess` needs a role on `ctx`, `accountQuery` supplies it.)

- [ ] **Step 4: Create the UI config mirror** — create `src/lib/inbox/funnel.ts`:

```ts
// UI mirror of the funnel stage ORDER + flags (labels come from i18n;
// event mappings live server-side in convex/lib/funnel.ts). Kept as a small
// standalone module so the frontend needn't import across the convex/ boundary.
export const UI_FUNNEL_STAGES = [
  { key: "new_lead", internalOnly: false, needsValue: false },
  { key: "qualified", internalOnly: false, needsValue: false },
  { key: "price_quoted", internalOnly: false, needsValue: false },
  { key: "itinerary_created", internalOnly: true, needsValue: false },
  { key: "itinerary_sent", internalOnly: false, needsValue: false },
  { key: "invoice_sent", internalOnly: false, needsValue: false },
  { key: "purchased", internalOnly: false, needsValue: true },
] as const;

export type UiFunnelStageKey = (typeof UI_FUNNEL_STAGES)[number]["key"];
export const UI_FUNNEL_STAGE_KEYS: UiFunnelStageKey[] = UI_FUNNEL_STAGES.map(
  (s) => s.key,
);
```

- [ ] **Step 5: Create the pure view helper + its test** — create `src/lib/inbox/funnelView.test.ts`:

```ts
import { expect, test } from "vitest";
import { buildFunnelSteps } from "./funnelView";

const base = { attributed: true, lane: "ctwa" as const, currentStage: null as string | null, reachedAt: {}, metaStatus: {} };

test("marks reached stages done, the current stage current, the rest upcoming", () => {
  const steps = buildFunnelSteps({
    ...base,
    currentStage: "price_quoted",
    reachedAt: { new_lead: 10, qualified: 20, price_quoted: 30 },
    metaStatus: { new_lead: "sent", price_quoted: "pending" },
  });
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
  expect(byKey.new_lead.done).toBe(true);
  expect(byKey.price_quoted.current).toBe(true);
  expect(byKey.itinerary_sent.upcoming).toBe(true);
  expect(byKey.new_lead.metaStatus).toBe("sent");
  expect(byKey.price_quoted.reportsToMeta).toBe(true);
  expect(byKey.itinerary_created.reportsToMeta).toBe(false); // internal-only
});

test("an organic funnel reports no stage as reporting to Meta", () => {
  const steps = buildFunnelSteps({ ...base, attributed: false, lane: null, currentStage: "qualified", reachedAt: { qualified: 5 } });
  expect(steps.every((s) => s.reportsToMeta === false)).toBe(true);
});
```

Then create `src/lib/inbox/funnelView.ts`:

```ts
import { UI_FUNNEL_STAGES } from "./funnel";

interface FunnelStateInput {
  attributed: boolean;
  lane: "code" | "ctwa" | null;
  currentStage: string | null;
  reachedAt: Record<string, number>;
  metaStatus: Record<string, string>;
}

export interface FunnelStep {
  key: string;
  internalOnly: boolean;
  needsValue: boolean;
  done: boolean;
  current: boolean;
  upcoming: boolean;
  reportsToMeta: boolean;
  reachedAt?: number;
  metaStatus?: string;
}

/** Composes the ordered stepper view. A stage is `done` if it has a
 *  transition (`reachedAt`), `current` if it equals `currentStage`, else
 *  `upcoming`. `reportsToMeta` = the conversation is attributed AND the stage
 *  isn't internal-only. */
export function buildFunnelSteps(state: FunnelStateInput): FunnelStep[] {
  return UI_FUNNEL_STAGES.map((s) => {
    const reachedAt = state.reachedAt[s.key];
    const current = state.currentStage === s.key;
    const done = reachedAt !== undefined && !current;
    return {
      key: s.key,
      internalOnly: s.internalOnly,
      needsValue: s.needsValue,
      done,
      current,
      upcoming: !done && !current,
      reportsToMeta: state.attributed && !s.internalOnly,
      reachedAt,
      metaStatus: state.metaStatus[s.key],
    };
  });
}
```

- [ ] **Step 6: Add i18n keys** — in `messages/en.json`, inside the `"Inbox"` object, add a `"funnel"` block:

```json
      "funnel": {
        "label": "Stage",
        "crmOnly": "CRM only — not from an ad or tracked link, so not reported to Meta.",
        "reportedToMeta": "Reported to Meta",
        "notReportedYet": "Not reported yet",
        "saleAmountTitle": "Record the sale",
        "saleAmountLabel": "Sale amount",
        "saleAmountConfirm": "Mark purchased",
        "stage": {
          "new_lead": "New lead",
          "qualified": "Qualified lead",
          "price_quoted": "Price quoted",
          "itinerary_created": "Itinerary created",
          "itinerary_sent": "Itinerary sent",
          "invoice_sent": "Invoice sent",
          "purchased": "Purchased"
        }
      }
```

(Place it next to the existing `messageThread`/`sidebar` blocks; ensure valid JSON — a trailing comma on the preceding block if needed.)

- [ ] **Step 7: Run tests + typecheck + commit**

Run: `npm test -- funnel.test funnelView` → PASS. `npm run typecheck` → PASS.
```bash
git add convex/funnel.ts convex/funnel.test.ts src/lib/inbox/funnel.ts src/lib/inbox/funnelView.ts src/lib/inbox/funnelView.test.ts messages/en.json
git commit -m "feat(funnel): getState query + funnel view helper + i18n (Phase 3)"
```

---

### Task 2: Thread header stage dropdown + Purchase value dialog

**Files:**
- Modify: `src/components/inbox/message-thread.tsx`

**Interfaces:**
- Consumes: `api.funnel.getState`, `api.funnel.setStage` (Task 1 / Phase 2); `UI_FUNNEL_STAGES` (Task 1); the existing `DropdownMenu*` imports, `Dialog`/`Input`/`Button`, `useAuth().accountRole`, `useTranslations("Inbox.funnel")`.

- [ ] **Step 1: Add imports + hooks**

At the top of `src/components/inbox/message-thread.tsx`, add to the UI imports: `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` from `"@/components/ui/dialog"`; `Input` from `"@/components/ui/input"`. Add `import { UI_FUNNEL_STAGES } from "@/lib/inbox/funnel";`. Inside `MessageThread`, add:

```tsx
  const tFunnel = useTranslations("Inbox.funnel");
  const funnelState = useQuery(
    api.funnel.getState,
    conversationId ? { conversationId: conversationId as Id<"conversations"> } : "skip",
  );
  const setStageMutation = useMutation(api.funnel.setStage);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [purchaseAmount, setPurchaseAmount] = useState("");

  const applyStage = useCallback(
    async (stage: string, saleValue?: number) => {
      if (!conversation) return;
      try {
        await setStageMutation({
          conversationId: conversation.id as Id<"conversations">,
          stage: stage as never,
          ...(saleValue !== undefined ? { saleValue } : {}),
        });
      } catch (err) {
        console.error("Failed to update stage:", err);
        toast.error(tFunnel("label"));
      }
    },
    [conversation, setStageMutation, tFunnel],
  );

  const handleStageSelect = useCallback(
    (stage: string) => {
      const def = UI_FUNNEL_STAGES.find((s) => s.key === stage);
      if (def?.needsValue) {
        setPurchaseAmount("");
        setPurchaseOpen(true);
        return;
      }
      void applyStage(stage);
    },
    [applyStage],
  );
```

(`conversationId` is already derived in this component; reuse it. `useQuery`/`useMutation`/`useState`/`useCallback`/`toast` are already imported.)

- [ ] **Step 2: Add the stage dropdown JSX** — in the header actions `<div className="flex items-center gap-2">` (around line 697), immediately BEFORE the status `DropdownMenu` block (`{accountRole !== "viewer" && (`), add a sibling stage dropdown:

```tsx
          {accountRole !== "viewer" && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  funnelState?.currentStage ? "text-primary" : "text-muted-foreground",
                )}
              >
                {funnelState?.currentStage
                  ? tFunnel(`stage.${funnelState.currentStage}`)
                  : tFunnel("label")}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="border-border bg-popover">
                {UI_FUNNEL_STAGES.map((s) => (
                  <DropdownMenuItem
                    key={s.key}
                    onClick={() => handleStageSelect(s.key)}
                    className="text-sm"
                  >
                    {tFunnel(`stage.${s.key}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
```

- [ ] **Step 3: Add the Purchase value dialog** — near the other modals rendered by this component (e.g. next to the template modal render), add:

```tsx
      <Dialog open={purchaseOpen} onOpenChange={setPurchaseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tFunnel("saleAmountTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">{tFunnel("saleAmountLabel")}</label>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              value={purchaseAmount}
              onChange={(e) => setPurchaseAmount(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                const v = Number(purchaseAmount);
                if (!Number.isFinite(v) || v <= 0) return;
                setPurchaseOpen(false);
                void applyStage("purchased", v);
              }}
              disabled={!(Number(purchaseAmount) > 0)}
            >
              {tFunnel("saleAmountConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck` → PASS. `npm run lint src/components/inbox/message-thread.tsx` → no NEW findings. `npm run build` → PASS.
```bash
git add src/components/inbox/message-thread.tsx
git commit -m "feat(funnel): thread stage dropdown + Purchase value dialog (Phase 3)"
```

---

### Task 3: Contact-sidebar funnel stepper

**Files:**
- Modify: `src/components/inbox/contact-sidebar.tsx`
- Modify: `src/components/inbox/contact-panel-drawer.tsx`

**Interfaces:**
- Consumes: `api.funnel.getState` (Task 1); `buildFunnelSteps` (Task 1); the existing `Section` component; `useTranslations("Inbox.funnel")`.
- Produces: `ContactSidebar` gains an optional `conversationId?: string` prop; `ContactPanelDrawer` threads it through.

- [ ] **Step 1: Thread `conversationId` through the drawer** — in `src/components/inbox/contact-panel-drawer.tsx`: add `conversationId?: string` to its props interface, and pass it to the sidebar (line ~73): `<ContactSidebar contact={contact} conversationId={conversationId} />`. Then in the drawer's own render site (wherever `<ContactPanelDrawer` is used in `message-thread.tsx`/inbox layout), pass `conversationId={conversation?.id}`. Find the render site: `grep -n "ContactPanelDrawer" src/components/inbox/*.tsx`.

- [ ] **Step 2: Add the stepper to the sidebar** — in `src/components/inbox/contact-sidebar.tsx`:
  - Add `conversationId?: string` to `ContactSidebarProps` and destructure it: `export function ContactSidebar({ contact, conversationId }: ContactSidebarProps)`.
  - Add imports: `import { useQuery } from "convex/react"` (already imported); `import { buildFunnelSteps } from "@/lib/inbox/funnelView";`; add a funnel translations hook `const tFunnel = useTranslations("Inbox.funnel");`; import an icon (e.g. `Target` or `ListChecks` from lucide-react — check the file's existing lucide import block and add one).
  - Add the query + render, as a new `Section` after the "Acquired via ad" section:

```tsx
  const funnelState = useQuery(
    api.funnel.getState,
    conversationId ? { conversationId: conversationId as Id<"conversations"> } : "skip",
  );
```

and in the JSX (after the acquisition `Section`):

```tsx
          {conversationId && funnelState && (
            <Section icon={ListChecks} label={tFunnel("label")}>
              <div className="px-3 py-2 space-y-1.5">
                {!funnelState.attributed && (
                  <p className="text-xs text-muted-foreground">{tFunnel("crmOnly")}</p>
                )}
                {buildFunnelSteps(funnelState).map((step) => (
                  <div key={step.key} className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        "text-sm",
                        step.current
                          ? "font-medium text-primary"
                          : step.done
                            ? "text-foreground"
                            : "text-muted-foreground",
                      )}
                    >
                      {step.done ? "✓ " : step.current ? "• " : "○ "}
                      {tFunnel(`stage.${step.key}`)}
                    </span>
                    {step.reportsToMeta && (step.done || step.current) && (
                      <span
                        className="text-[10px] text-muted-foreground"
                        title={
                          step.metaStatus === "sent"
                            ? tFunnel("reportedToMeta")
                            : tFunnel("notReportedYet")
                        }
                      >
                        {step.metaStatus === "sent" ? "✓ Meta" : "– Meta"}
                      </span>
                    )}
                  </div>
                ))}
                {funnelState.saleValue !== undefined && (
                  <p className="pt-1 text-sm text-foreground">
                    {funnelState.saleCurrency} {funnelState.saleValue}
                  </p>
                )}
              </div>
            </Section>
          )}
```

(`cn` is already imported in this file; if not, add `import { cn } from "@/lib/utils";`. `Id` type — the file already imports it for `contactId`; reuse.)

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck` → PASS. `npm run lint src/components/inbox/contact-sidebar.tsx src/components/inbox/contact-panel-drawer.tsx` → no NEW findings. `npm run build` → PASS.
```bash
git add src/components/inbox/contact-sidebar.tsx src/components/inbox/contact-panel-drawer.tsx
git commit -m "feat(funnel): contact-sidebar funnel stepper (Phase 3)"
```

---

### Task 4: Phase verification

**Files:** none.

- [ ] **Step 1:** `npm test` → PASS (full suite; + the Task-1 `getState` + `funnelView` tests over the Phase-2 baseline of 1505).
- [ ] **Step 2:** `npm run typecheck` → PASS.
- [ ] **Step 3:** `npm run build` → PASS.
- [ ] **Step 4:** `npm run lint` → confirm the funnel files add NO new findings vs the pre-existing baseline (compare touched-file lint to base).
- [ ] **Step 5:** Confirm by inspection: no `convex dev/deploy/codegen` run; the stage dropdown is hidden for viewers; `getState` is read-only ("view" access); `setStage` still dormant end-to-end (no Meta fire without env). Note in the report that interactive click-through is not possible (auth-gated) — verification is typecheck + lint + build + Task-1 unit tests.

---

## Self-Review

**Spec coverage (Phase 3 from design §11):**
- Thread stage dropdown (+ Purchase value popover) → Task 2. ✓
- Contact-sidebar stepper with per-stage "reported to Meta ✓/–" → Task 3. ✓
- Organic "CRM only" note → Task 3 (`!attributed`). ✓
- Viewer/own gating → Task 2 (viewer-hidden; own-mode enforced server-side, toast on failure — matching the status dropdown). ✓
- i18n → Task 1 (`Inbox.funnel`, single-locale `en.json`). ✓
- Read queries behind the UI → Task 1 (`getState`) + the pure `buildFunnelSteps`. ✓

**Placeholder scan:** every code step shows complete code; the one design nuance (the Task-1 test's `reached-at new_lead` assertion) is called out with the exact adjustment. No TBD/TODO.

**Type consistency:** `getState({conversationId}) → FunnelState`; `buildFunnelSteps(FunnelStateInput) → FunnelStep[]`; both consumed by Tasks 2–3. `setStage`'s `stage` arg is cast `as never` at the call site because the UI passes a `string` from `UI_FUNNEL_STAGES` (the server validator is the source of truth) — acceptable and localized. `UI_FUNNEL_STAGES` keys match the 7 server stages exactly.

**UI-verification caveat for reviewers:** the inbox is auth-gated, so there is no automated interactive click-through. Tasks 2–3 are verified by typecheck + lint-delta + `next build` + the Task-1 unit tests (the same bar the merged `ctwa-ad-inbox` UI phases used). Reviewers should read the JSX for correctness rather than expect a rendered screenshot.
