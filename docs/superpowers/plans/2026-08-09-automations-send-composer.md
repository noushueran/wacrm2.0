# Automations Send Composer Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `Send message` automation step that composes text, media and interactive buttons, with a template fallback when Meta's 24-hour customer-service window is shut.

**Architecture:** `automationSteps.stepType` is unchanged — only `send_message`'s `step_config` grows, so an existing `{ text: "hello" }` config is already a valid instance of the new shape and no data migration is needed. Transport selection is extracted into a pure, unit-testable module (`convex/lib/automations/sendPlan.ts`) that the engine calls; the window check reuses the existing `resolveWindowState` resolver verbatim.

**Tech Stack:** Convex (queries/mutations/actions, `convex-test` + Vitest), Next.js App Router, React, Tailwind, next-intl, WhatsApp Cloud API.

Spec: `docs/superpowers/specs/2026-08-09-automations-enhancement-design.md`

## Global Constraints

- **Never run `convex deploy`, `convex dev`, or `convex codegen`.** The owner runs these. If a task appears to need regenerated types, stop and say so.
- **Do not change the `automationSteps.stepType` union.** Phase 1 adds no step types.
- `send_buttons` / `send_list` keep their engine cases and their stored steps keep executing. They are removed from the *add menu* only.
- Every Convex index used must lead with `accountId` so tenancy is enforced by the index, never by a post-scan `.filter()` (`convex/schema.ts:1492` argues this).
- Tests: `convex/**/*.test.ts` runs under `edge-runtime` via `convex-test`; `src/**/*.test.ts` runs under `node`. Both via `npx vitest run`.
- Media and interactive are **mutually exclusive** in a single send. `InteractiveMessagePayload.header` is `string`-only (`convex/lib/whatsapp/interactive.ts:44`), so this repo cannot put an image on an interactive message.
- Lint only files you changed: `npx eslint <paths>`. Typecheck with `npx tsc --noEmit`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

**Created:**
- `convex/lib/automations/sendPlan.ts` — pure transport selection. One export, no Convex imports.
- `convex/lib/automations/sendPlan.test.ts` — its spec.
- `convex/lib/automations/templateVars.ts` — pure `{{n}}` extraction/ordering.
- `convex/lib/automations/templateVars.test.ts` — its spec.
- `src/components/automations/send-composer.tsx` — the unified send-step editor.

**Modified:**
- `convex/lib/r2/keys.ts` — add `"automation"` to `MEDIA_KINDS`.
- `convex/lib/whatsapp/metaApi.ts` — `sendTemplateMessage` gains an optional header component.
- `convex/metaSend.ts` — `sendTemplate` threads the header through.
- `convex/automationsEngine.ts` — send dispatch, window resolution, `session_window` condition, `time_of_day` timezone.
- `convex/lib/automations/validate.ts` — validate the new `send_message` shape.
- `src/types/index.ts` — `SendMessageStepConfig`, `ConditionSubject`.
- `src/components/interactive/interactive-builder.tsx` — container queries.
- `src/components/automations/automation-builder.tsx` — wire the composer, widen cards, drop buttons/list from the add menu.
- `messages/en.json` — new strings.

---

### Task 1: Pure send-transport selection

The §1.2 decision table, extracted so it can be tested without a Convex context or a Meta call.

**Files:**
- Create: `convex/lib/automations/sendPlan.ts`
- Test: `convex/lib/automations/sendPlan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `planSend(cfg: SendMessageStepConfig): SendPlan`, and the types `SendMessageStepConfig`, `SendMediaConfig`, `SendFallbackConfig`, `SendPlan`. Tasks 4, 5 and 11 import from this module.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/automations/sendPlan.test.ts`:

```ts
import { expect, test } from "vitest";
import { planSend } from "./sendPlan";

test("text only sends text", () => {
  expect(planSend({ text: "hi" })).toEqual({ kind: "text", text: "hi" });
});

test("image with text sends one media message captioned", () => {
  expect(
    planSend({ text: "look", media: { type: "image", key: "acc/automation/a.jpg" } }),
  ).toEqual({
    kind: "media",
    mediaType: "image",
    caption: "look",
    key: "acc/automation/a.jpg",
    url: undefined,
    filename: undefined,
  });
});

test("image without text sends media with no caption", () => {
  expect(
    planSend({ media: { type: "image", key: "acc/automation/a.jpg" } }),
  ).toEqual({
    kind: "media",
    mediaType: "image",
    caption: undefined,
    key: "acc/automation/a.jpg",
    url: undefined,
    filename: undefined,
  });
});

test("audio WITH text splits into two messages — Meta 400s on a captioned audio", () => {
  expect(
    planSend({ text: "listen", media: { type: "audio", key: "acc/automation/a.ogg" } }),
  ).toEqual({
    kind: "media_then_text",
    text: "listen",
    key: "acc/automation/a.ogg",
    url: undefined,
  });
});

test("audio WITHOUT text stays a single media message", () => {
  expect(planSend({ media: { type: "audio", url: "https://x/a.ogg" } })).toEqual({
    kind: "media",
    mediaType: "audio",
    caption: undefined,
    key: undefined,
    url: "https://x/a.ogg",
    filename: undefined,
  });
});

test("document carries its filename", () => {
  expect(
    planSend({ media: { type: "document", key: "acc/automation/q.pdf", filename: "quote.pdf" } }),
  ).toEqual({
    kind: "media",
    mediaType: "document",
    caption: undefined,
    key: "acc/automation/q.pdf",
    url: undefined,
    filename: "quote.pdf",
  });
});

test("interactive alone sends interactive", () => {
  const payload = { kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] };
  expect(planSend({ interactive: payload as never })).toEqual({
    kind: "interactive",
    payload,
  });
});

test("media outranks interactive — the composer forbids both, the engine still needs a rule", () => {
  const payload = { kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] };
  expect(
    planSend({ media: { type: "image", url: "https://x/a.jpg" }, interactive: payload as never }),
  ).toMatchObject({ kind: "media" });
});

test("whitespace-only text is not text", () => {
  expect(planSend({ text: "   " })).toEqual({ kind: "empty" });
});

test("empty config yields empty", () => {
  expect(planSend({})).toEqual({ kind: "empty" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/automations/sendPlan.test.ts`
Expected: FAIL — `Failed to resolve import "./sendPlan"`.

- [ ] **Step 3: Write the implementation**

Create `convex/lib/automations/sendPlan.ts`:

```ts
// Pure transport selection for a unified `send_message` step. No Convex,
// no fetch — the whole §1.2 decision table lives here so it is testable
// without a context and without a Meta call, the same convention
// `./schedule.ts` and `../whatsapp/messagingWindow.ts` follow.

import type { InteractiveMessagePayload } from "../whatsapp/interactive";

export type SendMediaType = "image" | "video" | "audio" | "document";

export interface SendMediaConfig {
  type: SendMediaType;
  /** R2 object key, account-scoped. Preferred over `url`. */
  key?: string;
  /** Legacy/external public URL. */
  url?: string;
  /** Document only — Meta rejects it on other kinds. */
  filename?: string;
}

export interface SendFallbackConfig {
  template_name: string;
  language: string;
  variables?: Record<string, string>;
  header?: { type: "image" | "video" | "document"; key?: string; url?: string };
}

export interface SendMessageStepConfig {
  text?: string;
  media?: SendMediaConfig;
  interactive?: InteractiveMessagePayload;
  fallback?: SendFallbackConfig;
}

export type SendPlan =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      mediaType: SendMediaType;
      caption?: string;
      key?: string;
      url?: string;
      filename?: string;
    }
  /** Audio cannot carry a caption (Meta 400s), so text becomes a second
   *  message. `metaApi.ts:655` already strips caption/filename for audio;
   *  this is the only case where one step emits two messages. */
  | { kind: "media_then_text"; text: string; key?: string; url?: string }
  | { kind: "interactive"; payload: InteractiveMessagePayload }
  | { kind: "empty" };

function nonEmpty(s: string | undefined): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Evaluated top-down, first match wins. Order is load-bearing: the audio
 * split must be tested before the general media case, or a captioned
 * audio would be built and rejected by Meta.
 */
export function planSend(cfg: SendMessageStepConfig): SendPlan {
  const { text, media, interactive } = cfg;

  if (media && media.type === "audio" && nonEmpty(text)) {
    return { kind: "media_then_text", text, key: media.key, url: media.url };
  }

  if (media) {
    return {
      kind: "media",
      mediaType: media.type,
      caption: nonEmpty(text) ? text : undefined,
      key: media.key,
      url: media.url,
      filename: media.filename,
    };
  }

  if (interactive) return { kind: "interactive", payload: interactive };

  if (nonEmpty(text)) return { kind: "text", text };

  return { kind: "empty" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/automations/sendPlan.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/automations/sendPlan.ts convex/lib/automations/sendPlan.test.ts
git commit -m "feat(automations): pure send-transport selection for the unified send step

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Pure template-variable extraction

**Files:**
- Create: `convex/lib/automations/templateVars.ts`
- Test: `convex/lib/automations/templateVars.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractTemplateVariables(body: string): number[]`. Task 10 (composer template UI) and Task 11 (validation) import it.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/automations/templateVars.test.ts`:

```ts
import { expect, test } from "vitest";
import { extractTemplateVariables } from "./templateVars";

test("extracts placeholders in numeric order", () => {
  expect(extractTemplateVariables("Hi {{1}}, your {{2}} is ready")).toEqual([1, 2]);
});

test("orders numerically regardless of position in the body", () => {
  expect(extractTemplateVariables("{{2}} comes after {{1}}")).toEqual([1, 2]);
});

test("sorts 10 after 2 — lexicographic sort is the bug this guards", () => {
  expect(extractTemplateVariables("{{10}} {{2}} {{1}}")).toEqual([1, 2, 10]);
});

test("de-duplicates a placeholder used twice", () => {
  expect(extractTemplateVariables("{{1}} and again {{1}}")).toEqual([1]);
});

test("ignores non-numeric placeholders", () => {
  expect(extractTemplateVariables("Hello {{name}}")).toEqual([]);
});

test("tolerates inner whitespace", () => {
  expect(extractTemplateVariables("Hi {{ 1 }}")).toEqual([1]);
});

test("returns empty for a body with no placeholders", () => {
  expect(extractTemplateVariables("No placeholders here")).toEqual([]);
});

test("returns empty for an empty body", () => {
  expect(extractTemplateVariables("")).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/automations/templateVars.test.ts`
Expected: FAIL — `Failed to resolve import "./templateVars"`.

- [ ] **Step 3: Write the implementation**

Create `convex/lib/automations/templateVars.ts`:

```ts
// Meta templates use positional {{1}}, {{2}}, … placeholders. This
// module answers "which variables does this template body need, in the
// order Meta expects them" so the builder can render one input per
// variable. The numeric sort mirrors `automationsEngine.ts`'s
// `sortTemplateParams`, which exists because a lexicographic sort yields
// "1", "10", "2", … and silently scrambles any template with ≥10
// variables.

const PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

/** Unique placeholder numbers in a template body, ascending. */
export function extractTemplateVariables(body: string): number[] {
  if (!body) return [];
  const found = new Set<number>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/automations/templateVars.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/automations/templateVars.ts convex/lib/automations/templateVars.test.ts
git commit -m "feat(automations): extract {{n}} placeholders from a template body

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Template header components

`sendTemplateMessage` currently emits `components: [{ type: "body", ... }]` and nothing else, so no template with an image/video/document header can be sent by any path in this repo.

**Files:**
- Modify: `convex/lib/whatsapp/metaApi.ts:703-740` (`sendTemplateMessage`)
- Modify: `convex/metaSend.ts:162` (`sendTemplate` action args)
- Test: `convex/lib/whatsapp/metaApi.template.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `SendTemplateMessageArgs` gains `header?: { type: "image" | "video" | "document"; link: string }`. `internal.metaSend.sendTemplate` gains the same optional `header` argument. Task 5 passes it.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/whatsapp/metaApi.template.test.ts`:

```ts
/// <reference types="vite/client" />
import { afterEach, expect, test, vi } from "vitest";
import { sendTemplateMessage } from "./metaApi";

afterEach(() => vi.unstubAllGlobals());

/** Captures the JSON body of the single outbound fetch. */
function stubFetch(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ messages: [{ id: "wamid.TEST" }] }),
      };
    }),
  );
  return { body: () => captured };
}

const BASE = {
  phoneNumberId: "pn1",
  accessToken: "tok",
  to: "971500000000",
  templateName: "welcome",
  language: "en_US",
};

test("body-only call is unchanged — no components key when there are no params", async () => {
  const f = stubFetch();
  await sendTemplateMessage({ ...BASE });
  expect(f.body().template).toEqual({ name: "welcome", language: { code: "en_US" } });
});

test("body params still emit a single body component", async () => {
  const f = stubFetch();
  await sendTemplateMessage({ ...BASE, params: ["Ada"] });
  expect((f.body().template as Record<string, unknown>).components).toEqual([
    { type: "body", parameters: [{ type: "text", text: "Ada" }] },
  ]);
});

test("an image header emits a header component BEFORE the body component", async () => {
  const f = stubFetch();
  await sendTemplateMessage({
    ...BASE,
    params: ["Ada"],
    header: { type: "image", link: "https://cdn/x.jpg" },
  });
  expect((f.body().template as Record<string, unknown>).components).toEqual([
    { type: "header", parameters: [{ type: "image", image: { link: "https://cdn/x.jpg" } }] },
    { type: "body", parameters: [{ type: "text", text: "Ada" }] },
  ]);
});

test("a header with no body params emits only the header component", async () => {
  const f = stubFetch();
  await sendTemplateMessage({
    ...BASE,
    header: { type: "document", link: "https://cdn/q.pdf" },
  });
  expect((f.body().template as Record<string, unknown>).components).toEqual([
    { type: "header", parameters: [{ type: "document", document: { link: "https://cdn/q.pdf" } }] },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/whatsapp/metaApi.template.test.ts`
Expected: The first two tests PASS (current behaviour); the two header tests FAIL — `components` is `undefined` / has no header entry.

- [ ] **Step 3: Write the implementation**

In `convex/lib/whatsapp/metaApi.ts`, add to `SendTemplateMessageArgs`:

```ts
  /** Media header for templates whose HEADER component is image/video/
   *  document. Meta requires header components to precede the body. */
  header?: { type: "image" | "video" | "document"; link: string };
```

Then replace the `templatePayload` construction (currently lines 717-728) with:

```ts
  const templatePayload: Record<string, unknown> = {
    name: templateName,
    language: { code: language },
  };

  // Meta requires components in order: header, then body. Emitting them
  // the other way round is a 400.
  const components: Record<string, unknown>[] = [];
  if (header) {
    components.push({
      type: "header",
      parameters: [{ type: header.type, [header.type]: { link: header.link } }],
    });
  }
  if (params && params.length > 0) {
    components.push({
      type: "body",
      parameters: params.map((p) => ({ type: "text", text: String(p) })),
    });
  }
  if (components.length > 0) {
    templatePayload.components = components;
  }
```

Add `header` to the destructure at line 706.

Then in `convex/metaSend.ts`, add to `sendTemplate`'s `args`:

```ts
    header: v.optional(
      v.object({
        type: v.union(v.literal("image"), v.literal("video"), v.literal("document")),
        link: v.string(),
      }),
    ),
```

and pass `header: args.header` into the `sendTemplateMessage({ ... })` call at line 197.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/lib/whatsapp/metaApi.template.test.ts`
Expected: PASS, 4 tests. The first two prove body-only payloads are byte-identical to before.

Then confirm nothing else regressed:

Run: `npx vitest run convex/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/whatsapp/metaApi.ts convex/lib/whatsapp/metaApi.template.test.ts convex/metaSend.ts
git commit -m "feat(whatsapp): support media header components on template sends

sendTemplateMessage emitted a body component only, so no template with an
image/video/document header could be sent by any path in this repo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Media kind and engine send dispatch

Rewires `runStep`'s `send_message` case onto `planSend`, with the same cross-account media guard flows already uses.

**Files:**
- Modify: `convex/lib/r2/keys.ts:13-24` (`MEDIA_KINDS`)
- Modify: `convex/automationsEngine.ts:734-747` (`send_message` case), plus local types near line 140
- Modify: `src/types/index.ts:721` (`SendMessageStepConfig`)
- Test: `convex/automationsEngine.test.ts` (append)

**Interfaces:**
- Consumes: `planSend`, `SendMessageStepConfig` from Task 1.
- Produces: `runStep`'s `send_message` case now handles media and interactive. Task 5 wraps this in a window check.

- [ ] **Step 1: Add the media kind**

In `convex/lib/r2/keys.ts`, add `"automation"` to `MEDIA_KINDS` after `"flow"`:

```ts
  "flow",
  // Media attached to an automation's send step. Separate from "flow" so
  // AUTOMATION_SENDABLE_MEDIA_KINDS can gate exactly this kind — see
  // `automationsEngine.ts`.
  "automation",
```

`kindValidator` in `convex/files.ts:52` is derived from this array, so `files.startUpload` accepts the new kind with no further change.

- [ ] **Step 2: Write the failing test**

Append to `convex/automationsEngine.test.ts`. Follow the existing seed helpers in that file (`seedAccount` etc.) — read the top of the file first for the exact helper names and signatures.

```ts
test("send_message with an image sends one captioned media message", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Media");
  const { automationId, contactId } = await seedAutomationWithStep(t, accountId, {
    stepType: "send_message",
    stepConfig: {
      text: "look at this",
      media: { type: "image", key: `${accountId}/automation/a.jpg` },
    },
  });

  const sendMedia = vi.fn(async () => ({ whatsappMessageId: "wamid.M" }));
  // Follow the existing suite's convention for stubbing metaSend actions.
  await runAutomation(t, { automationId, contactId, stubs: { sendMedia } });

  expect(sendMedia).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "image", caption: "look at this" }),
  );
});

test("send_message rejects a media key belonging to another account", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Mine");
  const otherId = await seedAccount(t, "Theirs");
  const { automationId, contactId } = await seedAutomationWithStep(t, accountId, {
    stepType: "send_message",
    stepConfig: { media: { type: "image", key: `${otherId}/automation/a.jpg` } },
  });

  const log = await runAutomation(t, { automationId, contactId });
  expect(log.status).toBe("failed");
  expect(log.errorMessage).toMatch(/does not belong to this account/);
});

test("send_message rejects a note-kind key — internal evidence must never reach a customer", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Notes");
  const { automationId, contactId } = await seedAutomationWithStep(t, accountId, {
    stepType: "send_message",
    stepConfig: { media: { type: "image", key: `${accountId}/note/passport.jpg` } },
  });

  const log = await runAutomation(t, { automationId, contactId });
  expect(log.status).toBe("failed");
  expect(log.errorMessage).toMatch(/does not belong to this account/);
});

test("a legacy { text } config still sends plain text", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Legacy");
  const { automationId, contactId } = await seedAutomationWithStep(t, accountId, {
    stepType: "send_message",
    stepConfig: { text: "hello" },
  });

  const sendText = vi.fn(async () => ({ whatsappMessageId: "wamid.T" }));
  await runAutomation(t, { automationId, contactId, stubs: { sendText } });

  expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }));
});
```

If `seedAutomationWithStep` / `runAutomation` do not already exist in the suite, write them as local helpers modelled on the existing tests in that file — do not restructure the existing helpers.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run convex/automationsEngine.test.ts -t "send_message"`
Expected: FAIL — the media config is ignored and `sendText` is called with empty text.

- [ ] **Step 4: Write the implementation**

In `convex/automationsEngine.ts`, add imports:

```ts
import { planSend, type SendMessageStepConfig } from "./lib/automations/sendPlan";
import { parseMediaKey, type MediaKind } from "./lib/r2/keys";
import { resolveMediaUrlLazy } from "./lib/r2/url";
import { r2ConfigFromEnv } from "./lib/r2/config";
```

(Check the exact export path of `r2ConfigFromEnv` against `convex/flowsEngine.ts`'s own import block and match it.)

Add the kind gate near the other module constants:

```ts
/**
 * The ONLY `MediaKind` an automation's send step may transmit. Mirrors
 * `flowsEngine.ts`'s `FLOW_SENDABLE_MEDIA_KINDS` and exists for the same
 * reason: even a key this account owns could name a kind that must never
 * reach a customer — most importantly `"note"`, which is internal-only
 * evidence. This dispatch path calls `internal.metaSend.*` directly, so
 * it never passes through `send.ts`'s own check.
 */
const AUTOMATION_SENDABLE_MEDIA_KINDS: ReadonlySet<MediaKind> = new Set(["automation"]);
```

Replace the local `SendMessageStepConfig` interface (near line 140) — delete it and use the imported one from `sendPlan.ts`.

Replace the `case "send_message":` block (lines 734-747) with:

```ts
    case "send_message": {
      const cfg = step.stepConfig as SendMessageStepConfig;
      if (!args.contactId) throw new Error("send_message needs a contact");

      const interpolated: SendMessageStepConfig = {
        ...cfg,
        text: cfg.text ? interpolate(cfg.text, args.context) : undefined,
      };
      const plan = planSend(interpolated);
      if (plan.kind === "empty") throw new Error("send_message has nothing to send");

      if (plan.kind === "interactive") {
        const check = validateInteractivePayload(plan.payload);
        if (!check.ok) throw new Error(check.error);
      }

      const { conversationId, to } = await resolveSendTarget(ctx, args);
      const accountId = args.automation.accountId;

      if (plan.kind === "text") {
        const r: { whatsappMessageId: string } = await ctx.runAction(
          internal.metaSend.sendText,
          { accountId, conversationId, to, text: plan.text },
        );
        return `sent via Meta (${r.whatsappMessageId})`;
      }

      if (plan.kind === "interactive") {
        const r: { whatsappMessageId: string } = await ctx.runAction(
          internal.metaSend.sendInteractive,
          { accountId, conversationId, to, payload: plan.payload },
        );
        return `interactive sent via Meta (${r.whatsappMessageId})`;
      }

      // Both remaining plans send media first. Resolve and guard once.
      const link = resolveMediaLink(accountId, plan.key, plan.url);
      const mediaKind = plan.kind === "media_then_text" ? "audio" : plan.mediaType;
      const media: { whatsappMessageId: string } = await ctx.runAction(
        internal.metaSend.sendMedia,
        {
          accountId,
          conversationId,
          to,
          kind: mediaKind,
          link,
          mediaKey: plan.key,
          caption: plan.kind === "media" ? plan.caption : undefined,
          filename: plan.kind === "media" ? plan.filename : undefined,
        },
      );

      if (plan.kind === "media") {
        return `media sent via Meta (${media.whatsappMessageId})`;
      }

      // Audio takes no caption, so the text follows as its own message.
      const follow: { whatsappMessageId: string } = await ctx.runAction(
        internal.metaSend.sendText,
        { accountId, conversationId, to, text: plan.text },
      );
      return `audio + text sent via Meta (${media.whatsappMessageId}, ${follow.whatsappMessageId})`;
    }
```

Add the shared resolver helper next to `resolveSendTarget`:

```ts
/**
 * Resolve a send step's media to a URL Meta can fetch, refusing any key
 * that is not this account's own `automation`-kind object. Same guard,
 * and same rationale, as `flowsEngine.ts`'s `send_media` node.
 */
function resolveMediaLink(
  accountId: Id<"accounts">,
  key: string | undefined,
  url: string | undefined,
): string {
  if (key) {
    const parsed = parseMediaKey(key);
    if (
      !parsed ||
      parsed.accountId !== accountId ||
      !AUTOMATION_SENDABLE_MEDIA_KINDS.has(parsed.kind)
    ) {
      throw new Error("media_key does not belong to this account");
    }
  }
  const link = resolveMediaUrlLazy(r2ConfigFromEnv, { key, url });
  if (!link) throw new Error("send_message media has no key or url");
  return link;
}
```

Finally, in `src/types/index.ts`, replace `SendMessageStepConfig` (line 721) with the richer shape, keeping the doc comment style of its neighbours:

```ts
export interface SendMessageMediaConfig {
  type: 'image' | 'video' | 'audio' | 'document';
  /** R2 object key, account-scoped. Preferred over `url`. */
  key?: string;
  /** Legacy/external public URL. */
  url?: string;
  /** Document only — Meta rejects a filename on other kinds. */
  filename?: string;
}

export interface SendMessageFallbackConfig {
  template_name: string;
  language: string;
  variables?: Record<string, string>;
  header?: { type: 'image' | 'video' | 'document'; key?: string; url?: string };
}

/**
 * The unified send step. Every field is optional so a legacy
 * `{ text: "hello" }` config remains a valid instance — this is what
 * makes the composer a zero-migration change. `media` and `interactive`
 * are mutually exclusive (the composer enforces it; `planSend` resolves
 * the tie in media's favour if both somehow appear).
 */
export interface SendMessageStepConfig {
  text?: string;
  media?: SendMessageMediaConfig;
  interactive?: InteractiveMessagePayload;
  fallback?: SendMessageFallbackConfig;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/automationsEngine.test.ts`
Expected: PASS — the four new tests plus every pre-existing test in the suite.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/r2/keys.ts convex/automationsEngine.ts convex/automationsEngine.test.ts src/types/index.ts
git commit -m "feat(automations): send media from a send_message step

Adds the "automation" media kind and routes send_message through planSend,
with the same cross-account and note-kind media guard flows already uses.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: 24-hour window resolution and template fallback

**Files:**
- Modify: `convex/automationsEngine.ts` (new internal query + send-path guard)
- Test: `convex/automationsEngine.test.ts` (append)

**Interfaces:**
- Consumes: `planSend` (Task 1), `sendTemplate`'s `header` arg (Task 3), `resolveMediaLink` (Task 4).
- Produces: `internal.automationsEngine.resolveWindowQuery` — args `{ accountId, conversationId }`, returns `{ canSendFreeForm: boolean; expiresAt?: number; remainingMs: number }`. Task 6 reuses it for the `session_window` condition.

- [ ] **Step 1: Write the failing test**

Append to `convex/automationsEngine.test.ts`:

```ts
const HOUR = 60 * 60 * 1000;

test("window open sends the composed free-form message", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Open");
  const { automationId, contactId } = await seedAutomationWithStep(
    t,
    accountId,
    {
      stepType: "send_message",
      stepConfig: {
        text: "still here?",
        fallback: { template_name: "revival", language: "en_US" },
      },
    },
    { lastInboundAt: Date.now() - HOUR },
  );

  const sendText = vi.fn(async () => ({ whatsappMessageId: "wamid.T" }));
  const sendTemplate = vi.fn(async () => ({ whatsappMessageId: "wamid.X" }));
  await runAutomation(t, { automationId, contactId, stubs: { sendText, sendTemplate } });

  expect(sendText).toHaveBeenCalled();
  expect(sendTemplate).not.toHaveBeenCalled();
});

test("window closed sends the fallback template instead", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Closed");
  const { automationId, contactId } = await seedAutomationWithStep(
    t,
    accountId,
    {
      stepType: "send_message",
      stepConfig: {
        text: "still here?",
        fallback: {
          template_name: "revival",
          language: "en_US",
          variables: { "1": "Ada" },
        },
      },
    },
    { lastInboundAt: Date.now() - 30 * HOUR },
  );

  const sendText = vi.fn(async () => ({ whatsappMessageId: "wamid.T" }));
  const sendTemplate = vi.fn(async () => ({ whatsappMessageId: "wamid.X" }));
  await runAutomation(t, { automationId, contactId, stubs: { sendText, sendTemplate } });

  expect(sendText).not.toHaveBeenCalled();
  expect(sendTemplate).toHaveBeenCalledWith(
    expect.objectContaining({ templateName: "revival", params: ["Ada"] }),
  );
});

test("window closed with no fallback fails legibly instead of 400ing at Meta", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NoFallback");
  const { automationId, contactId } = await seedAutomationWithStep(
    t,
    accountId,
    { stepType: "send_message", stepConfig: { text: "still here?" } },
    { lastInboundAt: Date.now() - 30 * HOUR },
  );

  const log = await runAutomation(t, { automationId, contactId });
  expect(log.status).toBe("failed");
  expect(log.errorMessage).toBe(
    "24h window closed and no fallback template configured",
  );
});

test("a conversation that never received an inbound message counts as closed", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NeverInbound");
  const { automationId, contactId } = await seedAutomationWithStep(
    t,
    accountId,
    { stepType: "send_message", stepConfig: { text: "hi" } },
    { lastInboundAt: undefined },
  );

  const log = await runAutomation(t, { automationId, contactId });
  expect(log.status).toBe("failed");
});
```

`seedAutomationWithStep`'s third parameter sets fields on the seeded conversation; extend the helper you wrote in Task 4 to accept it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/automationsEngine.test.ts -t "window"`
Expected: FAIL — every case sends free-form text; no window check exists.

- [ ] **Step 3: Write the implementation**

In `convex/automationsEngine.ts`, import the existing resolver — do not reimplement it:

```ts
import { resolveWindowState } from "./lib/whatsapp/messagingWindow";
```

Add the internal query beside the other `internalQuery` exports:

```ts
/**
 * Resolve Meta's 24-hour customer-service window for a conversation.
 * `resolveWindowState` is a pure resolver shared with the qualification
 * engine — this query only feeds it the row.
 */
export const resolveWindowQuery = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) {
      return { canSendFreeForm: false, expiresAt: undefined, remainingMs: 0 };
    }
    const state = resolveWindowState({
      now: Date.now(),
      lastInboundAt: conversation.lastInboundAt,
      metaWindow: conversation.metaWindow,
      adReferralStartedAt: conversation.adReferral?.startedAt,
      firstReplyAt: conversation.firstReplyAt,
    });
    return {
      canSendFreeForm: state.canSendFreeForm,
      expiresAt: state.csw.expiresAt,
      remainingMs: state.csw.remainingMs,
    };
  },
});
```

Check the exact field names on the `conversations` row (`metaWindow`, `adReferral`, `firstReplyAt`) against `convex/schema.ts` and against `qualificationEngine.ts:3369`'s own call, and match them.

Then, in the `case "send_message":` block from Task 4, insert the window check immediately after `resolveSendTarget` and before any send:

```ts
      const { conversationId, to } = await resolveSendTarget(ctx, args);
      const accountId = args.automation.accountId;

      const windowState = await ctx.runQuery(
        internal.automationsEngine.resolveWindowQuery,
        { accountId, conversationId },
      );

      if (!windowState.canSendFreeForm) {
        const fb = cfg.fallback;
        if (!fb?.template_name) {
          throw new Error("24h window closed and no fallback template configured");
        }
        const header = fb.header
          ? {
              type: fb.header.type,
              link: resolveMediaLink(accountId, fb.header.key, fb.header.url),
            }
          : undefined;
        const r: { whatsappMessageId: string } = await ctx.runAction(
          internal.metaSend.sendTemplate,
          {
            accountId,
            conversationId,
            to,
            templateName: fb.template_name,
            language: fb.language,
            params: fb.variables ? sortTemplateParams(fb.variables) : [],
            header,
          },
        );
        return `window closed — fallback template sent via Meta (${r.whatsappMessageId})`;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/automationsEngine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/automationsEngine.ts convex/automationsEngine.test.ts
git commit -m "feat(automations): fall back to a template when the 24h window is shut

A Wait -> Send Message sequence silently failed at Meta once the customer
service window closed. Sends now resolve the window first and either send
the composed message, send the configured fallback template, or fail with
a legible message.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `session_window` condition subject

**Files:**
- Modify: `convex/automationsEngine.ts` (`ConditionSubject`, `evaluateCondition`)
- Modify: `src/types/index.ts:772` (`ConditionSubject`)
- Modify: `src/components/automations/automation-builder.tsx` (subject dropdown + operand field)
- Modify: `messages/en.json` (`Automations.builder.config.subjects.session_window`)
- Test: `convex/automationsEngine.test.ts` (append)

**Interfaces:**
- Consumes: `internal.automationsEngine.resolveWindowQuery` (Task 5).
- Produces: condition subject `"session_window"` with operand `"open" | "closed"`.

- [ ] **Step 1: Write the failing test**

```ts
test("session_window condition takes the yes branch while the window is open", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CondOpen");
  const { automationId, contactId } = await seedAutomationWithStep(
    t,
    accountId,
    { stepType: "condition", stepConfig: { subject: "session_window", operand: "open" } },
    { lastInboundAt: Date.now() - HOUR },
  );

  const log = await runAutomation(t, { automationId, contactId });
  expect(log.stepsExecuted[0].detail).toBe("branch=yes");
});

test("session_window condition takes the no branch once the window has closed", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CondClosed");
  const { automationId, contactId } = await seedAutomationWithStep(
    t,
    accountId,
    { stepType: "condition", stepConfig: { subject: "session_window", operand: "open" } },
    { lastInboundAt: Date.now() - 30 * HOUR },
  );

  const log = await runAutomation(t, { automationId, contactId });
  expect(log.stepsExecuted[0].detail).toBe("branch=no");
});

test("operand 'closed' inverts the test", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CondInvert");
  const { automationId, contactId } = await seedAutomationWithStep(
    t,
    accountId,
    { stepType: "condition", stepConfig: { subject: "session_window", operand: "closed" } },
    { lastInboundAt: Date.now() - 30 * HOUR },
  );

  const log = await runAutomation(t, { automationId, contactId });
  expect(log.stepsExecuted[0].detail).toBe("branch=yes");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/automationsEngine.test.ts -t "session_window"`
Expected: FAIL — `evaluateCondition`'s `default` returns `false`, so the third test fails and the first returns `branch=no`.

- [ ] **Step 3: Write the implementation**

In `convex/automationsEngine.ts`, widen the local type:

```ts
type ConditionSubject =
  | "contact_field"
  | "tag_presence"
  | "message_content"
  | "time_of_day"
  | "session_window";
```

Add the case to `evaluateCondition`, before `default`:

```ts
    case "session_window": {
      // operand "open" (default) is true while free-form sends are
      // permitted; "closed" inverts it.
      const target = await resolveSendTarget(ctx, args).catch(() => null);
      if (!target) return false;
      const state = await ctx.runQuery(internal.automationsEngine.resolveWindowQuery, {
        accountId: args.automation.accountId,
        conversationId: target.conversationId,
      });
      return cfg.operand === "closed" ? !state.canSendFreeForm : state.canSendFreeForm;
    }
```

Mirror the union in `src/types/index.ts:772`.

In `automation-builder.tsx`, add `session_window` to the condition subject `<select>` and render an operand `<select>` with `open` / `closed` when it is chosen (follow the existing per-subject operand rendering in that switch).

Add to `messages/en.json` under `Automations.builder.config.subjects`:

```json
"session_window": "24-hour window"
```

and under `Automations.builder.config` a new block:

```json
"windowStates": { "open": "is open", "closed": "is closed" }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/automationsEngine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/automationsEngine.ts convex/automationsEngine.test.ts src/types/index.ts src/components/automations/automation-builder.tsx messages/en.json
git commit -m "feat(automations): branch on whether the 24h window is open

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `time_of_day` evaluates in account-local time

`new Date().getHours()` runs on the Convex runtime, which is UTC. For a Dubai account an `18:00-09:00` window is four hours wrong — and the bundled `out_of_office` template ships exactly that window (`convex/automations.ts:91`).

**Files:**
- Modify: `convex/automationsEngine.ts:674-688` (`time_of_day` case)
- Test: `convex/automationsEngine.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `internal.automationsEngine.accountUtcOffsetQuery` — args `{ accountId }`, returns `number` (minutes). Reused by nothing else in Phase 1.

- [ ] **Step 1: Write the failing test**

The condition currently reads wall-clock time, so pin it with fake timers.

```ts
test("time_of_day evaluates against the account's UTC offset, not the server's", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Dubai");
  // Dubai is UTC+4. 15:00 UTC is 19:00 local, inside an 18:00-09:00
  // out-of-office window; in UTC it would fall outside it.
  await t.run(async (ctx) => {
    await ctx.db.insert("qualificationConfigs", {
      ...qualificationConfigDefaults(accountId),
      utcOffsetMinutes: 240,
    });
  });

  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T15:00:00Z"));
  try {
    const { automationId, contactId } = await seedAutomationWithStep(t, accountId, {
      stepType: "condition",
      stepConfig: { subject: "time_of_day", operand: "18:00-09:00" },
    });
    const log = await runAutomation(t, { automationId, contactId });
    expect(log.stepsExecuted[0].detail).toBe("branch=yes");
  } finally {
    vi.useRealTimers();
  }
});

test("an account with no qualification config falls back to UTC", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NoConfig");

  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T15:00:00Z"));
  try {
    const { automationId, contactId } = await seedAutomationWithStep(t, accountId, {
      stepType: "condition",
      stepConfig: { subject: "time_of_day", operand: "18:00-09:00" },
    });
    const log = await runAutomation(t, { automationId, contactId });
    expect(log.stepsExecuted[0].detail).toBe("branch=no");
  } finally {
    vi.useRealTimers();
  }
});
```

Write `qualificationConfigDefaults(accountId)` as a local helper returning every required field of the `qualificationConfigs` table (read `convex/schema.ts:2359` for the full list) — a partial insert will fail validation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/automationsEngine.test.ts -t "time_of_day"`
Expected: The first test FAILS with `branch=no` (15:00 UTC is outside 18:00-09:00); the second passes already.

- [ ] **Step 3: Write the implementation**

Add the internal query:

```ts
/**
 * The account's fixed UTC offset in minutes. Same source and same
 * UTC fallback the `time_based` trigger already uses — see the
 * `qualificationConfigs` lookup in `runDueTimeBased`. Gulf/India have no
 * DST, so a fixed offset is exact rather than an approximation.
 */
export const accountUtcOffsetQuery = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
    return config?.utcOffsetMinutes ?? 0;
  },
});
```

Replace the `time_of_day` case body:

```ts
    case "time_of_day": {
      // operand form "HH:mm-HH:mm" — true if account-local now is inside
      // that window (over-midnight ranges like "18:00-09:00" supported).
      const [from, to] = (cfg.operand ?? "").split("-");
      if (!from || !to) return false;
      const offsetMinutes = await ctx.runQuery(
        internal.automationsEngine.accountUtcOffsetQuery,
        { accountId: args.automation.accountId },
      );
      const now = new Date(Date.now() + offsetMinutes * 60_000);
      const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
      const parse = (s: string) => {
        const [h, m] = s.split(":").map(Number);
        return (h || 0) * 60 + (m || 0);
      };
      const f = parse(from);
      const t = parse(to);
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t;
    }
```

`getUTCHours` on an offset-shifted instant is the same arithmetic `isDailyDue` uses, and avoids depending on the host's own timezone.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/automationsEngine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/automationsEngine.ts convex/automationsEngine.test.ts
git commit -m "fix(automations): evaluate time_of_day in account-local time

The condition read the Convex runtime's UTC clock, so the bundled
out_of_office template's 18:00-09:00 window was four hours off for a Gulf
account. Now reads qualificationConfigs.utcOffsetMinutes, the same source
the time_based trigger already uses.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Validation for the new send shape

**Files:**
- Modify: `convex/lib/automations/validate.ts:83-97`
- Test: `convex/lib/automations/validate.test.ts` (append — the file exists and already imports `validateStepsForActivation`)

**Interfaces:**
- Consumes: `planSend` and `SendMessageStepConfig` (Task 1).
- Produces: nothing new — `validateStepsForActivation`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

Append these cases to the existing suite; do not re-declare its imports.

```ts
test("a send_message with only media is valid — text is no longer required", () => {
  const issues = validateStepsForActivation([
    { step_type: "send_message", step_config: { media: { type: "image", url: "https://x/a.jpg" } } },
  ]);
  expect(issues).toEqual([]);
});

test("a send_message with only buttons is valid", () => {
  const issues = validateStepsForActivation([
    {
      step_type: "send_message",
      step_config: { interactive: { kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] } },
    },
  ]);
  expect(issues).toEqual([]);
});

test("a send_message with nothing to send is rejected", () => {
  const issues = validateStepsForActivation([
    { step_type: "send_message", step_config: {} },
  ]);
  expect(issues).toHaveLength(1);
  expect(issues[0].message).toMatch(/needs text, media or buttons/);
});

test("media and buttons together are rejected", () => {
  const issues = validateStepsForActivation([
    {
      step_type: "send_message",
      step_config: {
        media: { type: "image", url: "https://x/a.jpg" },
        interactive: { kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] },
      },
    },
  ]);
  expect(issues[0].message).toMatch(/cannot carry both media and buttons/);
});

test("an invalid interactive payload still reports Meta's own limit message", () => {
  const issues = validateStepsForActivation([
    {
      step_type: "send_message",
      step_config: {
        interactive: {
          kind: "buttons",
          body: "pick",
          buttons: [{ id: "a", title: "This title is far too long for Meta" }],
        },
      },
    },
  ]);
  expect(issues).toHaveLength(1);
});

test("a fallback template with no name is rejected", () => {
  const issues = validateStepsForActivation([
    { step_type: "send_message", step_config: { text: "hi", fallback: { language: "en_US" } } },
  ]);
  expect(issues[0].message).toMatch(/fallback template name is required/);
});

test("a legacy { text } config is still valid", () => {
  expect(
    validateStepsForActivation([{ step_type: "send_message", step_config: { text: "hello" } }]),
  ).toEqual([]);
});

test("a stored send_buttons step is still valid", () => {
  expect(
    validateStepsForActivation([
      {
        step_type: "send_buttons",
        step_config: { kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] },
      },
    ]),
  ).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/lib/automations/validate.test.ts`
Expected: FAIL — the current `send_message` case requires `c.text`, so the media-only and buttons-only cases report "message text is required".

- [ ] **Step 3: Write the implementation**

Replace `validate.ts`'s `case "send_message":` with:

```ts
    case "send_message": {
      const cfg = c as SendMessageStepConfig;
      if (cfg.media && cfg.interactive) {
        issues.push({
          path: `${path}.media`,
          message:
            "a send step cannot carry both media and buttons — WhatsApp has no message type for that combination",
        });
        break;
      }
      if (planSend(cfg).kind === "empty") {
        issues.push({
          path: `${path}.text`,
          message: "a send step needs text, media or buttons",
        });
      }
      if (cfg.interactive) {
        const result = validateInteractivePayload(cfg.interactive);
        if (!result.ok) {
          issues.push({ path: `${path}.interactive`, message: result.error });
        }
      }
      if (cfg.fallback && !nonEmpty(cfg.fallback.template_name)) {
        issues.push({
          path: `${path}.fallback.template_name`,
          message: "fallback template name is required",
        });
      }
      break;
    }
```

Import `planSend` and `SendMessageStepConfig` from `./sendPlan`. Leave the `send_buttons` / `send_list` cases exactly as they are — stored steps of those types must keep validating.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/lib/automations/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/automations/validate.ts convex/lib/automations/validate.test.ts
git commit -m "feat(automations): validate the unified send step shape

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Fix the interactive builder's collapse

`interactive-builder.tsx:91` uses `md:flex-row` with a `md:w-[280px]` preview column at line 164. Those are **viewport** breakpoints, but the step card is a fixed 320px (`automation-builder.tsx:1109`). On a desktop viewport the component goes two-column inside a ~288px content box and the form column collapses — labels render one character per line.

**Files:**
- Modify: `src/components/interactive/interactive-builder.tsx:91,164`
- Modify: `src/components/automations/automation-builder.tsx:1107-1109`
- Modify: `tailwind.config.ts` if the container-query plugin is not already enabled

**Interfaces:**
- Consumes: nothing.
- Produces: an `InteractiveBuilder` that adapts to its container. Task 10 embeds it inside the composer.

- [ ] **Step 1: Confirm container-query support**

Run: `grep -rn "@tailwindcss/container-queries\|@container" tailwind.config.ts src/ | head`

Tailwind v4 ships container queries in core. If this project is on v3 and the plugin is absent, add `@tailwindcss/container-queries` to `devDependencies` and register it in `tailwind.config.ts`. Check the installed version first:

```bash
node -e "console.log(require('./package.json').devDependencies.tailwindcss || require('./package.json').dependencies.tailwindcss)"
```

- [ ] **Step 2: Widen the expanded step card**

In `automation-builder.tsx`, replace the `width` computation (lines 1107-1109):

```tsx
  // Collapsed cards keep the narrow flow-diagram look. An EXPANDED card
  // widens because the config forms inside it — the interactive payload
  // builder above all — need real horizontal room; at 320px the button
  // editor collapsed to one character per line.
  const width = expanded
    ? "w-full max-w-[560px] sm:w-[560px]"
    : isCondition
      ? "w-full max-w-[400px] sm:w-[400px]"
      : "w-full max-w-[320px] sm:w-80"
```

- [ ] **Step 3: Make the interactive builder container-relative**

In `interactive-builder.tsx`, line 91:

```tsx
    <div className="@container/ib flex flex-col gap-4 @2xl/ib:flex-row">
```

and line 164:

```tsx
      <div className="flex shrink-0 flex-col gap-1.5 @2xl/ib:w-[280px]">
```

The named container (`/ib`) prevents a nested container elsewhere in the tree from capturing these queries. `@2xl` is 672px — above that the two-column layout has room for a 280px preview plus a usable form column; below it the component stacks.

- [ ] **Step 4: Verify in the browser**

Start the preview and open an automation with a Send Buttons step:

- `preview_start` with `{name: "wacrm-dev"}`
- navigate to `/automations` and open any automation
- add a Send Buttons step and expand it
- screenshot

Expected: the card is ~560px wide, the reply-buttons form and its preview sit side by side, and every label reads as a normal line of text. Also check at the `mobile` viewport preset — the component should stack, not overflow.

Then confirm flows did not regress: open `/flows`, edit a flow with a `send_buttons` node, screenshot.

- [ ] **Step 5: Commit**

```bash
git add src/components/interactive/interactive-builder.tsx src/components/automations/automation-builder.tsx
git commit -m "fix(interactive): use container queries so the builder fits its container

The layout switched to two columns on viewport md: with a fixed 280px
preview, but the automation step card is 320px wide — the form column
collapsed and labels rendered one character per line. Fixed at the
component so flows and any future embedding benefit too.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: The send composer

**Files:**
- Create: `src/components/automations/send-composer.tsx`
- Modify: `src/components/automations/automation-builder.tsx` (`STEP_META`, `ADDABLE_STEPS`, `blankConfig`, `StepEditor`, `previewFor`)
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `SendMessageStepConfig` (`src/types`), `extractTemplateVariables` (Task 2), `uploadAccountMedia(convex, startUpload, file, "automation")` from `src/lib/storage/upload-media.ts`, `InteractiveBuilder` (Task 9), `useResources()` from `automation-builder.tsx`.
- Produces: `<SendComposer value={config} onChange={(next) => void} />` where both are `SendMessageStepConfig`.

- [ ] **Step 1: Build the composer shell with text and media**

Create `src/components/automations/send-composer.tsx`. It renders, in order:

1. **Message text** — `<Textarea>`, bound to `value.text`.
2. **Attachment** — a type `<Select>` (image / video / audio / document) plus a file picker. Model the upload on `src/components/flows/forms/node-config-form.tsx:914-955`: call `uploadAccountMedia(convex, startUpload, file, "automation")`, then patch `media` in one `onChange` so the form never renders a half-uploaded state. Enforce the same 16 MB `MEDIA_MAX_BYTES` guard and surface failures with `toast.error`. Changing the media type clears the current file. A `Remove` button clears `media` entirely.
3. When `media.type === "audio"` and `text` is non-empty, render an inline note: *"WhatsApp can't caption audio — your text will send as a second message."*

Use `useResources()` for the template list rather than adding a new query.

- [ ] **Step 2: Add the buttons/list section**

A segmented control with three states — **None** / **Buttons** / **List**:

- choosing Buttons or List sets `interactive` to `blankButtonsPayload()` / `blankListPayload()` and renders `<InteractiveBuilder>` bound to it;
- choosing None clears `interactive`.

When `media` is set, disable Buttons and List and show: *"WhatsApp can't put media on a message with buttons. Remove the attachment to add buttons."* When `interactive` is set, disable the attachment picker with the mirror-image message. This is the §1.2 exclusivity rule made visible rather than discovered at save time.

- [ ] **Step 3: Add the out-of-window fallback section**

A collapsible section headed *"If the 24-hour window is closed"* containing:

- a template `<Select>` (approved templates only — `useResources().templates` is already filtered to `status === "APPROVED"`);
- one `<Input>` per placeholder returned by `extractTemplateVariables(selectedTemplate.body)`, labelled `{{1}}`, `{{2}}`, …, writing into `fallback.variables` keyed by the number as a string;
- when the selected template declares a media header, a file picker writing `fallback.header`.

Above the section, a one-line explainer: *"WhatsApp only allows free-form messages within 24 hours of the contact's last message. Outside that window, only an approved template can be sent."*

If no template is selected, show a warning that the step will fail when the window is closed — this is the exact condition Task 5 made fail loudly.

- [ ] **Step 4: Wire it into the builder**

In `automation-builder.tsx`:

- `STEP_META.send_message.label` stays `send_message`; retitle the string in `messages/en.json` to `"Send Message"` (unchanged) — but its icon should now reflect that it carries media too. Leave the icon as `MessageSquare`.
- Remove `"send_buttons"` and `"send_list"` from `ADDABLE_STEPS`. **Leave them in `STEP_META`** — stored steps of those types still render.
- `blankConfig("send_message")` returns `{ text: "" }` (unchanged — the new fields are all optional).
- In `StepEditor`, `case "send_message"` renders `<SendComposer>`.
- Change `case "send_buttons": case "send_list":` to *upgrade on open*: render `<SendComposer>` with `value={{ interactive: asInteractive(cfg) }}` and, in `onChange`, emit `{ ...step, step_type: "send_message", step_config: next }`. Opening a legacy step and saving migrates that one step; never touch steps the user has not opened.
- Update `previewFor(step)` so a `send_message` with media shows e.g. `📎 image` and one with buttons shows `[buttons]`, falling back to the text as today.

- [ ] **Step 5: Verify in the browser**

With the preview running, on a scratch automation (do **not** save over an existing one):

1. Add a Send Message step; type text; screenshot.
2. Attach an image; confirm the caption note does not appear; screenshot.
3. Switch the attachment to audio; confirm the two-message note appears.
4. Remove the attachment; add Buttons; confirm the interactive builder renders correctly at the widened card size and the attachment picker is disabled with the explanation.
5. Open the fallback section; select a template; confirm one input renders per `{{n}}`.
6. Open a **legacy** Send Buttons step; confirm it loads into the composer with the buttons populated.
7. `read_console_messages` — expect no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/automations/send-composer.tsx src/components/automations/automation-builder.tsx messages/en.json
git commit -m "feat(automations): unified send composer with media, buttons and window fallback

One Send Message step now carries text, an optional attachment
(image/video/audio/document), optional reply buttons or a list, and an
out-of-window template fallback. send_buttons/send_list leave the add menu
and upgrade into the composer when opened.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Template step gets its variables

`SendTemplateFields` (`automation-builder.tsx:543`) edits name and language only, but the engine reads `cfg.variables`. Any template with `{{1}}` fails at Meta.

**Files:**
- Modify: `src/components/automations/automation-builder.tsx:543-600` (`SendTemplateFields`)
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `extractTemplateVariables` (Task 2).
- Produces: `SendTemplateFields` now writes `variables` and `header` into the step config.

- [ ] **Step 1: Extend the component's contract**

Change its props from `{ templateName, language, onChange, t }` to take the whole config and emit a whole config:

```tsx
function SendTemplateFields({
  cfg,
  onChange,
  t,
}: {
  cfg: SendTemplateStepConfig
  onChange: (next: SendTemplateStepConfig) => void
  t: ReturnType<typeof useTranslations>
})
```

Update its one call site in `StepEditor` (`case "send_template"`) accordingly.

- [ ] **Step 2: Render one input per placeholder**

After the existing template `<Select>`, look up the selected template in `useResources().templates`, run `extractTemplateVariables(template.body)`, and render an `<Input>` per number, labelled `{{n}}`, bound to `cfg.variables?.[String(n)]`. Changing the selected template clears `variables` — placeholders rarely mean the same thing across two templates, and stale values would send silently wrong content.

If the template has no placeholders, render nothing extra. Keep the existing raw-input fallback for accounts with no templates loaded.

- [ ] **Step 3: Add the header picker**

When the selected template declares an image/video/document header, render a file picker writing `cfg.header` (upload via `uploadAccountMedia(..., "automation")`, same as Task 10 step 1).

If the template record does not expose its header type, skip this step and note it in the commit message — the engine already tolerates an absent header.

- [ ] **Step 4: Verify in the browser**

Open a scratch automation, add a Send Template step, select a template with placeholders, confirm one labelled input renders per placeholder and that typing into them persists across a collapse/expand of the card. Screenshot.

- [ ] **Step 5: Commit**

```bash
git add src/components/automations/automation-builder.tsx messages/en.json
git commit -m "feat(automations): fill template variables from the builder

The engine has always read and positionally sorted step_config.variables,
but nothing in the builder could write it, so any template with {{1}} 400d
at Meta.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Full-suite verification

**Files:** none modified.

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS, with no pre-existing failures newly introduced.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint the changed files**

Run: `npx eslint convex/lib/automations convex/automationsEngine.ts convex/metaSend.ts convex/lib/whatsapp/metaApi.ts convex/lib/r2/keys.ts src/components/automations src/components/interactive/interactive-builder.tsx src/types/index.ts`
Expected: clean.

- [ ] **Step 4: End-to-end check against the live automation's shape**

In the browser preview, build a scratch automation shaped like the real one — `Tag Added → Wait 1m → Send Message (text + image + fallback template) → Send Template` — and confirm it saves and activates without a validation error. Do **not** activate it, and do **not** modify automation `mn7bry9z4hqtm4rnh9k805n14x8c4b65`.

- [ ] **Step 5: Commit any fixes**

If steps 1-4 surfaced nothing, there is nothing to commit. Otherwise commit fixes individually with a message naming what broke.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1.1 unified send step config | 1, 4, 10 |
| §1.2 dispatch table + exclusivity | 1, 4, 8, 10 |
| §1.2 media ownership guard | 4 |
| §1.3 template variables | 2, 11 |
| §1.3 template header component | 3, 11 |
| §1.4 window resolution + fallback | 5 |
| §1.4 `session_window` condition | 6 |
| §1.5 `time_of_day` timezone | 7 |
| §1.5 container-query layout fix | 9 |
| Testing — back-compat | 4 (legacy text), 8 (stored `send_buttons`), 3 (body-only payload) |

Phase 2 (run tracking) and Phase 3 (builder UX) are separate plans; they are not covered here by design.

**Known follow-ups deliberately not in this plan:**
- Media headers on interactive messages — excluded per spec §1.2, needs its own review across flows/conversations/broadcasts.
- Task 11 step 3 depends on the template record exposing its header type; if it does not, that sub-step is skipped and the picker ships in a later pass.
