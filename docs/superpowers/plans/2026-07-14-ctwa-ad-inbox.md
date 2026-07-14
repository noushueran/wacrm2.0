# CTWA Ad Inbox Handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the full Click-to-WhatsApp ad `referral` on inbound messages, render the ad preview card above the first message, flag ad-lead conversations + contacts, and surface the 72h free-entry-point window in the composer.

**Architecture:** Widen the webhook parser to lift the whole `referral` (today only `ctwa_clid`). Persist it on the `messages` row, denormalize a summary + a 72h anchor onto `conversations`, and set acquisition fields once on `contacts`. Download the ad image into Convex storage (reuse `files.storeFromUrl`) so it never expires. On the client, render an `<AdReferralCard>` in the bubble, an "Ad lead" badge in the thread header, a read-only acquisition row in the contact sidebar, and swap the composer's expired-session hint for a "templates free for Xh" hint on ad leads.

**Tech Stack:** Convex (self-hosted), Next.js (modified — see constraints), React, next-intl, vitest + convex-test.

## Global Constraints

- **Offline build only.** Any `convex dev` / `convex deploy` / `convex codegen` pushes to the ONE live prod deployment. Do NOT run them. All schema/function changes here are additive and need no `_generated/` hand-edits: `dataModel.d.ts` derives `Doc<>` types from `schema.ts`, `api.d.ts` types each module via `typeof import(...)`, and the runtime `internal`/`api` objects are proxies — so new fields on existing tables and new exports in existing modules resolve automatically. No new Convex module files are created.
- **Additive schema, no migration.** Every new field is `v.optional(...)`; pre-existing rows validate unchanged.
- **Meta window rule is fixed.** The 24h free-form gate (`sessionExpired`) stays exactly as-is — Meta rejects free-form messages after 24h. The 72h window only makes messages *free*; it is surfaced as an indicator, never as a free-form unlock.
- **Modified Next.js.** Per `AGENTS.md`, before any routing/framework-level code consult `node_modules/next/dist/docs/`. This feature is components + Convex + one pure lib; no routing changes.
- **TDD, frequent commits.** Pure/backend logic gets a failing test first. UI wiring (no component-test harness in normal use) is verified by `npm run typecheck` + `npm run lint` + `npm run build`.
- **Forward-only.** Existing conversations cannot be backfilled; only inbound messages received after deploy carry the referral.
- **Verify commands:** `npm run test` (vitest), `npm run typecheck` (`tsc --noEmit`), `npm run lint` (eslint), `npm run build`.
- **Canonical type:** `AdReferral` is defined once in `convex/lib/whatsapp/webhookParse.ts` (Task 1) and imported by later backend tasks. The UI mirror types live in `src/types/index.ts` (Task 4).

---

### Task 1: Parse the full ad referral

**Files:**
- Modify: `convex/lib/whatsapp/webhookParse.ts` (`MetaWebhookMessage.referral` ~L81-84, `FlattenedInboundMessage` ~L243-257, `flattenInboundMessage` ~L266-273)
- Test: `convex/lib/whatsapp/webhookParse.test.ts`

**Interfaces:**
- Produces: `export interface AdReferral { sourceType?: "ad" | "post"; sourceId?: string; sourceUrl?: string; headline?: string; body?: string; mediaType?: "image" | "video"; imageUrl?: string; videoUrl?: string; thumbnailUrl?: string; }`
- Produces: `FlattenedInboundMessage.referral?: AdReferral` (in addition to the existing `ctwaClid?: string`, which is unchanged).
- Rule: attach `referral` only when the raw payload carries previewable content — any of `headline`, `body`, `source_url`, `source_type`, `image_url`, `video_url`, `thumbnail_url`. A referral with only `ctwa_clid`/`source_id` (the existing test fixtures) attaches NO `referral` object, so existing tests stay green.

- [ ] **Step 1: Write the failing tests** — append to `convex/lib/whatsapp/webhookParse.test.ts`:

```ts
// ------------------------------------------------------------
// flattenInboundMessage: full ad referral (creative preview)
// ------------------------------------------------------------

test("flattenInboundMessage: lifts the full referral creative alongside ctwaClid", () => {
  const result = flattenInboundMessage(
    msg({
      type: "text",
      text: { body: "Hello, how can I get more info?" },
      id: "wamid.AD1",
      referral: {
        ctwa_clid: "clid-1",
        source_id: "120210000",
        source_type: "ad",
        source_url: "https://fb.me/ad123",
        headline: "Dubai 5N/6D Package",
        body: "Starting AED 1,499 per person",
        media_type: "image",
        image_url: "https://scontent.example/ad.jpg",
      } as MetaWebhookMessage["referral"],
    }),
  );
  expect(result?.ctwaClid).toBe("clid-1");
  expect(result?.referral).toEqual({
    sourceType: "ad",
    sourceId: "120210000",
    sourceUrl: "https://fb.me/ad123",
    headline: "Dubai 5N/6D Package",
    body: "Starting AED 1,499 per person",
    mediaType: "image",
    imageUrl: "https://scontent.example/ad.jpg",
    videoUrl: undefined,
    thumbnailUrl: undefined,
  });
});

test("flattenInboundMessage: a referral with only ctwa_clid/source_id attaches NO referral object (nothing to preview)", () => {
  const result = flattenInboundMessage(
    msg({ type: "text", text: { body: "hi" }, referral: { ctwa_clid: "abc", source_id: "AD1" } }),
  );
  expect(result?.ctwaClid).toBe("abc");
  expect(result?.referral).toBeUndefined();
});

test("flattenInboundMessage: an image ad carries both mediaId and the referral creative", () => {
  const result = flattenInboundMessage(
    msg({
      type: "image",
      image: { id: "media-9", caption: "See offer" },
      referral: { ctwa_clid: "z", headline: "Offer", image_url: "https://scontent.example/x.jpg" } as MetaWebhookMessage["referral"],
    }),
  );
  expect(result?.mediaId).toBe("media-9");
  expect(result?.referral?.headline).toBe("Offer");
  expect(result?.referral?.imageUrl).toBe("https://scontent.example/x.jpg");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- webhookParse`
Expected: FAIL — the three new tests error (`referral` is not lifted; TS: `headline` etc. not on `MetaWebhookMessage.referral`).

- [ ] **Step 3: Widen `MetaWebhookMessage.referral`** — replace the field at `convex/lib/whatsapp/webhookParse.ts` ~L81-84:

```ts
  // Present when the message originated from a click-to-WhatsApp ad. The
  // full creative is lifted into `FlattenedInboundMessage.referral` for the
  // inbox ad-preview card; `ctwa_clid` continues to surface separately for
  // attribution (`FlattenedInboundMessage.ctwaClid`).
  referral?: {
    ctwa_clid?: string;
    source_id?: string;
    source_type?: "ad" | "post";
    source_url?: string;
    headline?: string;
    body?: string;
    media_type?: "image" | "video";
    image_url?: string;
    video_url?: string;
    thumbnail_url?: string;
  };
```

- [ ] **Step 4: Add the `AdReferral` type + `referral` field** — replace `FlattenedInboundMessage` (~L243-257):

```ts
/** Click-to-WhatsApp ad creative, lifted from the inbound `referral`
 *  object. The camelCase counterpart of Meta's snake_case payload. */
export interface AdReferral {
  sourceType?: "ad" | "post";
  sourceId?: string;
  sourceUrl?: string;
  headline?: string;
  body?: string;
  mediaType?: "image" | "video";
  imageUrl?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
}

export interface FlattenedInboundMessage {
  type:
    | "text"
    | "image"
    | "document"
    | "audio"
    | "video"
    | "location"
    | "interactive";
  text?: string;
  mediaId?: string;
  wamid: string;
  interactiveReplyId?: string;
  ctwaClid?: string;
  referral?: AdReferral;
}
```

- [ ] **Step 5: Populate `referral` in `flattenInboundMessage`** — replace the function (~L266-273):

```ts
export function flattenInboundMessage(
  message: MetaWebhookMessage,
): FlattenedInboundMessage | null {
  const base = flattenByType(message);
  if (!base) return null;
  const r = message.referral;
  const ctwaClid = r?.ctwa_clid || undefined;
  // Only attach a `referral` when there's previewable creative/link — a
  // referral carrying just ctwa_clid/source_id has nothing to render.
  const hasCreative =
    !!r &&
    !!(
      r.headline ||
      r.body ||
      r.source_url ||
      r.source_type ||
      r.image_url ||
      r.video_url ||
      r.thumbnail_url
    );
  const referral: AdReferral | undefined = hasCreative
    ? {
        sourceType: r!.source_type,
        sourceId: r!.source_id,
        sourceUrl: r!.source_url,
        headline: r!.headline,
        body: r!.body,
        mediaType: r!.media_type,
        imageUrl: r!.image_url,
        videoUrl: r!.video_url,
        thumbnailUrl: r!.thumbnail_url,
      }
    : undefined;
  return { ...base, ...(ctwaClid ? { ctwaClid } : {}), ...(referral ? { referral } : {}) };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -- webhookParse`
Expected: PASS — new tests pass; the pre-existing ctwaClid tests still pass (their fixtures have no creative, so `referral` stays absent).

- [ ] **Step 7: Commit**

```bash
git add convex/lib/whatsapp/webhookParse.ts convex/lib/whatsapp/webhookParse.test.ts
git commit -m "feat(ctwa): lift the full ad referral in the webhook parser"
```

---

### Task 2: Schema fields + persist referral, denorm conversation, set contact acquisition

**Files:**
- Modify: `convex/schema.ts` (`contacts` ~L58-82, `conversations` ~L114-150, `messages` ~L163-205)
- Modify: `convex/messages.ts` (`AppendMessageArgs` ~L72-100, `insertMessageAndUpdateConversation` insert ~L121-134)
- Modify: `convex/ingest.ts` (`inboundMessageValidator` ~L78-94, `ingestInbound` handler ~L231-245)
- Test: `convex/ingest.test.ts`

**Interfaces:**
- Consumes: `AdReferral` from `./lib/whatsapp/webhookParse` (Task 1).
- Produces: `messages.referral` (object incl. `storedImageUrl`), `conversations.adReferral` (`{ headline?, body?, sourceUrl?, sourceType?, imageUrl?, storedImageUrl?, startedAt: number }`), `contacts.acquisitionSource: "ad"` + `contacts.acquisitionAd: { headline?, sourceId?, sourceUrl?, firstSeenAt: number }`.
- Produces: `AppendMessageArgs.referral?: AdReferral`.

- [ ] **Step 1: Write the failing test** — append to `convex/ingest.test.ts` (near the ctwa attribution tests ~L1208):

```ts
test("processInbound persists the ad referral on the message, denorms it onto the conversation, and marks the contact acquired via ad", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551230000",
    message: {
      type: "text",
      text: "Hello, how can I get more info?",
      wamid: "wamid.ADLEAD1",
      ctwaClid: "clid-1",
      referral: {
        sourceType: "ad",
        sourceId: "120210000",
        sourceUrl: "https://fb.me/ad123",
        headline: "Dubai 5N/6D Package",
        body: "Starting AED 1,499",
        mediaType: "image",
        imageUrl: "https://scontent.example/ad.jpg",
      },
    },
  });

  const message = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", "wamid.ADLEAD1"))
      .first(),
  );
  expect(message!.referral?.headline).toBe("Dubai 5N/6D Package");
  expect(message!.referral?.sourceType).toBe("ad");

  const conversation = await t.run((ctx) => ctx.db.get(message!.conversationId));
  expect(conversation!.adReferral?.headline).toBe("Dubai 5N/6D Package");
  expect(typeof conversation!.adReferral?.startedAt).toBe("number");

  const contact = await t.run((ctx) => ctx.db.get(conversation!.contactId));
  expect(contact!.acquisitionSource).toBe("ad");
  expect(contact!.acquisitionAd?.sourceId).toBe("120210000");
});

test("processInbound does NOT overwrite an existing conversation adReferral or contact acquisition on a later ad message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);

  const send = (wamid: string, headline: string) =>
    t.action(internal.ingest.processInbound, {
      accountId,
      from: "15551230000",
      message: {
        type: "text",
        text: "hi",
        wamid,
        referral: { sourceType: "ad", sourceId: "AD-" + headline, headline },
      },
    });
  await send("wamid.FIRST", "First Ad");
  await send("wamid.SECOND", "Second Ad");

  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  expect(conversation!.adReferral?.headline).toBe("First Ad");
  const contact = await t.run((ctx) => ctx.db.get(conversation!.contactId));
  expect(contact!.acquisitionAd?.sourceId).toBe("AD-First Ad");
});

test("processInbound sets no ad fields for a plain (non-ad) inbound message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551239999",
    message: { type: "text", text: "just browsing", wamid: "wamid.PLAIN1" },
  });
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first(),
  );
  expect(conversation!.adReferral).toBeUndefined();
  const contact = await t.run((ctx) => ctx.db.get(conversation!.contactId));
  expect(contact!.acquisitionSource).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- ingest`
Expected: FAIL — `inboundMessageValidator` rejects the extra `referral` field (ArgumentValidationError), and no ad fields are written.

- [ ] **Step 3: Add the `contacts` acquisition fields** — in `convex/schema.ts`, inside `contacts: defineTable({...})`, after `notes: v.optional(v.string()),` (~L75):

```ts
    // Lead-acquisition provenance. Set ONCE, the first time a contact
    // arrives via a Click-to-WhatsApp ad referral; never overwritten.
    acquisitionSource: v.optional(v.literal("ad")),
    acquisitionAd: v.optional(
      v.object({
        headline: v.optional(v.string()),
        sourceId: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
        firstSeenAt: v.number(),
      }),
    ),
```

- [ ] **Step 4: Add the `conversations.adReferral` denorm** — in `convex/schema.ts`, inside `conversations: defineTable({...})`, after `updatedAt: v.optional(v.number()),` (~L138):

```ts
    // Denormalized Click-to-WhatsApp ad summary — presence flags this
    // conversation as an "ad lead" for the inbox badge without scanning
    // messages. `startedAt` anchors the 72h free-entry-point indicator
    // (set once, on the first ad message).
    adReferral: v.optional(
      v.object({
        headline: v.optional(v.string()),
        body: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
        sourceType: v.optional(v.union(v.literal("ad"), v.literal("post"))),
        imageUrl: v.optional(v.string()),
        storedImageUrl: v.optional(v.string()),
        startedAt: v.number(),
      }),
    ),
```

- [ ] **Step 5: Add the `messages.referral` field** — in `convex/schema.ts`, inside `messages: defineTable({...})`, after `aiGenerated: v.optional(v.boolean()),` (~L201):

```ts
    // The full Click-to-WhatsApp ad referral, on the FIRST inbound message
    // that carried it. `storedImageUrl` is the durable Convex-storage copy
    // of the ad image (Task 3), patched in after ingest.
    referral: v.optional(
      v.object({
        sourceType: v.optional(v.union(v.literal("ad"), v.literal("post"))),
        sourceId: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
        headline: v.optional(v.string()),
        body: v.optional(v.string()),
        mediaType: v.optional(v.union(v.literal("image"), v.literal("video"))),
        imageUrl: v.optional(v.string()),
        videoUrl: v.optional(v.string()),
        thumbnailUrl: v.optional(v.string()),
        storedImageUrl: v.optional(v.string()),
      }),
    ),
```

- [ ] **Step 6: Thread `referral` through `AppendMessageArgs` + the insert** — in `convex/messages.ts`:

At the top, add the import (merge into the existing `./_generated/dataModel` import block is not needed; add a new import line near the top):

```ts
import type { AdReferral } from "./lib/whatsapp/webhookParse";
```

In `AppendMessageArgs` (after `aiGenerated?: boolean;`, ~L99):

```ts
  /** Click-to-WhatsApp ad referral (inbound-only), stored verbatim on the
   *  message row. `storedImageUrl` is filled later (Task 3). */
  referral?: AdReferral;
```

In `insertMessageAndUpdateConversation`, add `referral` to the destructure (~L107-119) and to the `ctx.db.insert("messages", {...})` object (~L121-134):

```ts
  const {
    accountId,
    conversationId,
    senderType,
    contentType,
    contentText,
    mediaUrl,
    templateName,
    messageId,
    interactivePayload,
    interactiveReplyId,
    aiGenerated,
    referral,
  } = args;

  const newMessageId = await ctx.db.insert("messages", {
    accountId,
    conversationId,
    senderType,
    contentType,
    contentText,
    mediaUrl,
    templateName,
    messageId,
    interactivePayload,
    interactiveReplyId,
    aiGenerated,
    referral,
    status: "sent",
  });
```

- [ ] **Step 7: Accept `referral` in `inboundMessageValidator`** — in `convex/ingest.ts`, add to the validator object (~L78-94), after `ctwaClid: v.optional(v.string()),`:

```ts
  referral: v.optional(
    v.object({
      sourceType: v.optional(v.union(v.literal("ad"), v.literal("post"))),
      sourceId: v.optional(v.string()),
      sourceUrl: v.optional(v.string()),
      headline: v.optional(v.string()),
      body: v.optional(v.string()),
      mediaType: v.optional(v.union(v.literal("image"), v.literal("video"))),
      imageUrl: v.optional(v.string()),
      videoUrl: v.optional(v.string()),
      thumbnailUrl: v.optional(v.string()),
    }),
  ),
```

- [ ] **Step 8: Persist + denorm + acquisition in `ingestInbound`** — in `convex/ingest.ts`, set `referral` on `appendArgs` and add the denorm/acquisition after the insert (~L231-245):

```ts
    const appendArgs: AppendMessageArgs = {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: message.type,
      contentText: message.text,
      mediaUrl: message.mediaUrl,
      messageId: message.wamid,
      interactiveReplyId: message.interactiveReplyId,
      referral: message.referral,
    };
    const messageId = await insertMessageAndUpdateConversation(
      ctx,
      appendArgs,
      conversation,
    );

    // ---- (4b) ad-lead denorm + contact acquisition (set once) ----
    // `conversation` is the pre-patch doc, so `.adReferral` reflects state
    // BEFORE this message — the correct "already an ad lead?" check.
    if (message.referral) {
      if (!conversation.adReferral) {
        await ctx.db.patch(conversationId, {
          adReferral: {
            headline: message.referral.headline,
            body: message.referral.body,
            sourceUrl: message.referral.sourceUrl,
            sourceType: message.referral.sourceType,
            imageUrl: message.referral.imageUrl ?? message.referral.thumbnailUrl,
            startedAt: Date.now(),
          },
        });
      }
      const contactForAcq = existingContact ?? (await ctx.db.get(contactId));
      if (contactForAcq && !contactForAcq.acquisitionSource) {
        await ctx.db.patch(contactId, {
          acquisitionSource: "ad",
          acquisitionAd: {
            headline: message.referral.headline,
            sourceId: message.referral.sourceId,
            sourceUrl: message.referral.sourceUrl,
            firstSeenAt: Date.now(),
          },
        });
      }
    }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm run test -- ingest`
Expected: PASS — all three new tests pass; existing ingest tests still pass.

- [ ] **Step 10: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS (no type errors).

```bash
git add convex/schema.ts convex/messages.ts convex/ingest.ts convex/ingest.test.ts
git commit -m "feat(ctwa): persist ad referral, denorm ad-lead onto conversation + contact"
```

---

### Task 3: Download the ad image into Convex storage

**Files:**
- Modify: `convex/messages.ts` (add `setAdReferralImage` internalMutation, near `setMediaUrl` ~L392-399)
- Modify: `convex/ingest.ts` (`processInbound`, after the inbound-media block ~L516-527)
- Test: `convex/ingest.test.ts`

**Interfaces:**
- Consumes: `internal.files.storeFromUrl` (`{ url }` → `{ storageId }`), `ctx.storage.getUrl`.
- Produces: `internal.messages.setAdReferralImage({ messageId, conversationId, storedImageUrl })` — patches `messages.referral.storedImageUrl` and `conversations.adReferral.storedImageUrl`.

- [ ] **Step 1: Write the failing test** — append to `convex/ingest.test.ts`:

```ts
test("processInbound downloads the ad image into storage and attaches storedImageUrl to the message + conversation", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);

  const imgBytes = new TextEncoder().encode("jpeg-ad-banner-bytes");
  const fetchMock = vi.fn(async () =>
    ({ ok: true, status: 200, blob: async () => new Blob([imgBytes], { type: "image/jpeg" }) }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551230000",
    message: {
      type: "text",
      text: "info?",
      wamid: "wamid.ADIMG1",
      referral: { sourceType: "ad", headline: "Pkg", imageUrl: "https://scontent.example/ad.jpg" },
    },
  });

  const message = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_message_id", (q) => q.eq("messageId", "wamid.ADIMG1")).first(),
  );
  expect(message!.referral?.storedImageUrl).toBeTruthy();
  const conversation = await t.run((ctx) => ctx.db.get(message!.conversationId));
  expect(conversation!.adReferral?.storedImageUrl).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- ingest`
Expected: FAIL — `storedImageUrl` is undefined (no download step yet); `fetchMock` not called.

- [ ] **Step 3: Add `setAdReferralImage`** — in `convex/messages.ts`, right after `setMediaUrl` (~L399):

```ts
/** Attach the durable Convex-storage URL of a downloaded ad image to both
 *  the message's `referral` and the conversation's `adReferral` denorm.
 *  Best-effort partner to `ingest.processInbound`'s ad-image step. */
export const setAdReferralImage = internalMutation({
  args: {
    messageId: v.id("messages"),
    conversationId: v.id("conversations"),
    storedImageUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (message?.referral) {
      await ctx.db.patch(args.messageId, {
        referral: { ...message.referral, storedImageUrl: args.storedImageUrl },
      });
    }
    const conversation = await ctx.db.get(args.conversationId);
    if (conversation?.adReferral) {
      await ctx.db.patch(args.conversationId, {
        adReferral: { ...conversation.adReferral, storedImageUrl: args.storedImageUrl },
      });
    }
  },
});
```

- [ ] **Step 4: Add the download step in `processInbound`** — in `convex/ingest.ts`, immediately after the inbound-media resolution block (after the closing `}` of `if (message.mediaId && !message.mediaUrl) {...}`, ~L527), add:

```ts
    // ---- Ad-referral image → storage ----
    // The referral gives a DIRECT public CDN url (not a Meta mediaId), so a
    // plain `storeFromUrl` (no auth headers) re-hosts it into Convex storage
    // — same durability the inbound-media block gives voice notes/photos,
    // so the ad card never breaks when Meta's CDN url expires. After the
    // dedup guard above, so a Meta retry can't orphan a second copy.
    const adImageSrc = message.referral?.imageUrl ?? message.referral?.thumbnailUrl;
    if (adImageSrc) {
      await runBestEffort("ingest.storeAdReferralImage", async () => {
        const { storageId } = await ctx.runAction(internal.files.storeFromUrl, {
          url: adImageSrc,
        });
        const url = await ctx.storage.getUrl(storageId);
        if (url) {
          await ctx.runMutation(internal.messages.setAdReferralImage, {
            messageId: res.messageId,
            conversationId: res.conversationId,
            storedImageUrl: url,
          });
        }
      });
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- ingest`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add convex/messages.ts convex/ingest.ts convex/ingest.test.ts
git commit -m "feat(ctwa): re-host ad referral image into Convex storage at ingest"
```

---

### Task 4: UI types + adapters

**Files:**
- Modify: `src/types/index.ts` (`Contact` ~L99-124, `Conversation` ~L168-193, `Message` ~L229-...)
- Modify: `src/lib/convex/adapters.ts` (`toUiContact` ~L84-109, `toUiConversation` ~L255-285, `toUiMessage` ~L287-313)

**Interfaces:**
- Produces (UI, snake_case): `Message.referral?: MessageAdReferral`, `Conversation.ad_referral?: ConversationAdReferral`, `Contact.acquisition_source?: "ad"`, `Contact.acquisition_ad?: { headline?: string; source_id?: string; source_url?: string; first_seen_at: string }`.
- `MessageAdReferral` and `ConversationAdReferral` shapes are defined in Step 1 and consumed by Tasks 5–8.

- [ ] **Step 1: Add UI types** — in `src/types/index.ts`, add these two interfaces just above `export interface Message {` (~L229):

```ts
export interface MessageAdReferral {
  source_type?: 'ad' | 'post';
  source_id?: string;
  source_url?: string;
  headline?: string;
  body?: string;
  media_type?: 'image' | 'video';
  image_url?: string;
  video_url?: string;
  thumbnail_url?: string;
  /** Durable Convex-storage copy of the ad image (preferred over image_url). */
  stored_image_url?: string;
}

export interface ConversationAdReferral {
  headline?: string;
  body?: string;
  source_url?: string;
  source_type?: 'ad' | 'post';
  image_url?: string;
  stored_image_url?: string;
  /** ISO timestamp the ad conversation started — anchors the 72h free window. */
  started_at: string;
}
```

Add to `Message` (after `ai_generated?: boolean;`):

```ts
  /** Click-to-WhatsApp ad referral, on the first inbound message. Drives
   *  the ad-preview card in the bubble. */
  referral?: MessageAdReferral;
```

Add to `Conversation` (after `ai_handoff_summary?: string | null;`):

```ts
  /** Present when this conversation began from a Click-to-WhatsApp ad. */
  ad_referral?: ConversationAdReferral;
```

Add to `Contact` (after `notes?: string;`):

```ts
  /** Lead-acquisition provenance (set once). */
  acquisition_source?: 'ad';
  acquisition_ad?: {
    headline?: string;
    source_id?: string;
    source_url?: string;
    first_seen_at: string;
  };
```

- [ ] **Step 2: Map `referral` in `toUiMessage`** — in `src/lib/convex/adapters.ts`, add to the returned object in `toUiMessage` (after `ai_generated: doc.aiGenerated,`, ~L311):

```ts
    referral: doc.referral
      ? {
          source_type: doc.referral.sourceType,
          source_id: doc.referral.sourceId,
          source_url: doc.referral.sourceUrl,
          headline: doc.referral.headline,
          body: doc.referral.body,
          media_type: doc.referral.mediaType,
          image_url: doc.referral.imageUrl,
          video_url: doc.referral.videoUrl,
          thumbnail_url: doc.referral.thumbnailUrl,
          stored_image_url: doc.referral.storedImageUrl,
        }
      : undefined,
```

- [ ] **Step 3: Map `ad_referral` in `toUiConversation`** — add to the returned object (after `ai_handoff_summary: doc.aiHandoffSummary,`, ~L283):

```ts
    ad_referral: doc.adReferral
      ? {
          headline: doc.adReferral.headline,
          body: doc.adReferral.body,
          source_url: doc.adReferral.sourceUrl,
          source_type: doc.adReferral.sourceType,
          image_url: doc.adReferral.imageUrl,
          stored_image_url: doc.adReferral.storedImageUrl,
          started_at: new Date(doc.adReferral.startedAt).toISOString(),
        }
      : undefined,
```

- [ ] **Step 4: Map acquisition in `toUiContact`** — add to the returned object (after `tags: doc.tags ? doc.tags.map(toUiTag) : undefined,`, ~L107):

```ts
    acquisition_source: doc.acquisitionSource,
    acquisition_ad: doc.acquisitionAd
      ? {
          headline: doc.acquisitionAd.headline,
          source_id: doc.acquisitionAd.sourceId,
          source_url: doc.acquisitionAd.sourceUrl,
          first_seen_at: new Date(doc.acquisitionAd.firstSeenAt).toISOString(),
        }
      : undefined,
```

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/types/index.ts src/lib/convex/adapters.ts
git commit -m "feat(ctwa): surface ad referral / ad-lead / acquisition in UI types + adapters"
```

---

### Task 5: Ad preview card in the message bubble

**Files:**
- Create: `src/components/inbox/ad-referral-card.tsx`
- Modify: `src/components/inbox/message-bubble.tsx` (imports ~L1-22, `MessageContent` ~L122)
- Modify: `messages/en.json` (`Inbox.bubble` block ~L235)

**Interfaces:**
- Consumes: `Message.referral: MessageAdReferral` (Task 4).

- [ ] **Step 1: Add i18n keys** — in `messages/en.json`, inside the `"bubble": { ... }` object (~L235), add:

```json
      "fromAd": "From an ad",
      "viewAd": "View ad"
```

(If any non-English locale files exist under `messages/`, add the same two keys there.)

- [ ] **Step 2: Create the card component** — `src/components/inbox/ad-referral-card.tsx`:

```tsx
"use client";

import type { MessageAdReferral } from "@/types";
import { Megaphone, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

/** WhatsApp-style Click-to-WhatsApp ad preview, stacked above the first
 *  inbound message's content. Handles image ads, video ads (thumbnail),
 *  and text-only ads (no media block). */
export function AdReferralCard({ referral }: { referral: MessageAdReferral }) {
  const t = useTranslations("Inbox.bubble");
  const img =
    referral.stored_image_url ?? referral.image_url ?? referral.thumbnail_url;

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-background/50">
      <div className="flex items-center gap-1 px-2 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <Megaphone className="h-3 w-3" />
        {t("fromAd")}
      </div>
      <div className="flex gap-2 p-2">
        {img && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt=""
            loading="lazy"
            className="h-14 w-14 shrink-0 rounded object-cover"
          />
        )}
        <div className="min-w-0">
          {referral.headline && (
            <p className="truncate text-xs font-semibold text-foreground">
              {referral.headline}
            </p>
          )}
          {referral.body && (
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {referral.body}
            </p>
          )}
          {referral.source_url && (
            <a
              href={referral.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline"
            >
              {t("viewAd")}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Render the card in `MessageContent`** — in `src/components/inbox/message-bubble.tsx`:

Add the import near the other local imports (~L19-21):

```tsx
import { AdReferralCard } from "./ad-referral-card";
```

Rename the existing `function MessageContent(...)` (the one with the `switch`, ~L122) to `function MessageContentBody(...)` — signature and body otherwise unchanged. Then add a new wrapper directly above it:

```tsx
function MessageContent({ message, t, isAgent }: { message: Message, t: ReturnType<typeof useTranslations>, isAgent: boolean }) {
  const body = <MessageContentBody message={message} t={t} isAgent={isAgent} />;
  if (!message.referral) return body;
  return (
    <>
      <AdReferralCard referral={message.referral} />
      {body}
    </>
  );
}
```

- [ ] **Step 4: Verify (typecheck + lint + build)**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS — no type/lint errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/inbox/ad-referral-card.tsx src/components/inbox/message-bubble.tsx messages/en.json
git commit -m "feat(ctwa): render the ad preview card above the first message"
```

---

### Task 6: "Ad lead" badge in the thread header

**Files:**
- Modify: `src/components/inbox/message-thread.tsx` (header, next to the session badge ~L655-664; imports ~L38-48)
- Modify: `messages/en.json` (`Inbox.messageThread` block)

**Interfaces:**
- Consumes: `Conversation.ad_referral` (Task 4). `conversation` is already in scope in the header render.

- [ ] **Step 1: Add the i18n key** — in `messages/en.json`, inside the `"messageThread": { ... }` object, add:

```json
      "adLeadBadge": "Ad lead"
```

- [ ] **Step 2: Import the icon** — in `src/components/inbox/message-thread.tsx`, add `Megaphone` to the existing `lucide-react` import block (~L38-48):

```tsx
  Megaphone,
```

- [ ] **Step 3: Render the badge** — in `src/components/inbox/message-thread.tsx`, immediately AFTER the closing `</Badge>` of the session-timer badge (~L664), add:

```tsx
          {conversation.ad_referral && (
            <Badge
              variant="outline"
              className="ml-1 hidden gap-1 border-primary/40 text-[10px] text-primary sm:inline-flex sm:ml-2"
            >
              <Megaphone className="h-3 w-3" />
              {t("adLeadBadge")}
            </Badge>
          )}
```

- [ ] **Step 4: Verify (typecheck + lint + build)**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/inbox/message-thread.tsx messages/en.json
git commit -m "feat(ctwa): show an Ad lead badge in the thread header"
```

---

### Task 7: 72h free-window helper + composer hint

**Files:**
- Create: `src/lib/inbox/adWindow.ts`
- Test: `src/lib/inbox/adWindow.test.ts`
- Modify: `src/components/inbox/message-thread.tsx` (`sessionInfo` area ~L214-238; `<MessageComposer>` call ~L928-937; imports)
- Modify: `src/components/inbox/message-composer.tsx` (`MessageComposerProps` ~L113-122; expired banner ~L555-570)
- Modify: `messages/en.json` (`Inbox.sessionTimer` + `Inbox.composer` blocks)

**Interfaces:**
- Produces: `adFreeWindowRemainingMs(startedAtMs: number, nowMs: number): number` and `AD_FREE_WINDOW_MS: number`.
- Produces: `MessageComposerProps.adFreeWindowLabel?: string | null` — when set AND `sessionExpired`, the banner shows the free-template variant.

- [ ] **Step 1: Write the failing test** — `src/lib/inbox/adWindow.test.ts`:

```ts
import { expect, test } from "vitest";
import { adFreeWindowRemainingMs, AD_FREE_WINDOW_MS } from "./adWindow";

const HOUR = 60 * 60 * 1000;

test("full window remaining at the moment it starts", () => {
  expect(adFreeWindowRemainingMs(1_000, 1_000)).toBe(AD_FREE_WINDOW_MS);
});

test("about one hour remaining near the end", () => {
  const started = 0;
  const now = AD_FREE_WINDOW_MS - HOUR;
  expect(adFreeWindowRemainingMs(started, now)).toBe(HOUR);
});

test("clamps to 0 once the 72h have elapsed", () => {
  expect(adFreeWindowRemainingMs(0, AD_FREE_WINDOW_MS + HOUR)).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- adWindow`
Expected: FAIL — module `./adWindow` not found.

- [ ] **Step 3: Create the helper** — `src/lib/inbox/adWindow.ts`:

```ts
// Pure helper for the Click-to-WhatsApp 72h free-entry-point window.
// Dependency-free (no React/Convex) so it's unit-testable and shared,
// same convention as `./view.ts`.

/** The free-entry-point window Meta grants an ad lead: 72 hours. Within it
 *  all messages (incl. templates) are free of charge. NOTE: this window is
 *  about COST only — it does NOT extend the 24h free-form messaging window,
 *  which is enforced separately (`sessionExpired`). */
export const AD_FREE_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Milliseconds remaining in the 72h free window, anchored to when the ad
 *  conversation started. 0 once elapsed. */
export function adFreeWindowRemainingMs(
  startedAtMs: number,
  nowMs: number,
): number {
  return Math.max(0, startedAtMs + AD_FREE_WINDOW_MS - nowMs);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- adWindow`
Expected: PASS.

- [ ] **Step 5: Add i18n keys** — in `messages/en.json`:

Inside `"sessionTimer": { ... }` add:

```json
      "adFreeXhRemaining": "{hours}h",
      "adFreeXmRemaining": "{minutes}m"
```

Inside `"composer": { ... }` add:

```json
      "adFreeWindowHint": "Ad lead — templates are free for {remaining}"
```

- [ ] **Step 6: Compute the free-window label in the thread** — in `src/components/inbox/message-thread.tsx`:

Add the import near the other `@/lib/inbox` import (~L24-27):

```tsx
import { adFreeWindowRemainingMs } from "@/lib/inbox/adWindow";
```

Directly AFTER the `sessionInfo` memo (~L238), add:

```tsx
  // Ad-lead free-entry-point window (72h, cost-only). Shown in the composer
  // once the 24h free-form window has closed, so agents know template
  // re-engagement is free. `null` when not an ad lead or the 72h has run out.
  const adFreeWindowLabel = useMemo(() => {
    const startedIso = conversation.ad_referral?.started_at;
    if (!startedIso) return null;
    const remainingMs = adFreeWindowRemainingMs(
      new Date(startedIso).getTime(),
      Date.now(),
    );
    if (remainingMs <= 0) return null;
    const hoursLeft = remainingMs / (60 * 60 * 1000);
    return hoursLeft >= 1
      ? tTimer("adFreeXhRemaining", { hours: Math.floor(hoursLeft) })
      : tTimer("adFreeXmRemaining", { minutes: Math.floor(hoursLeft * 60) });
  }, [conversation.ad_referral?.started_at, tTimer]);
```

- [ ] **Step 7: Pass the label to the composer** — in the `<MessageComposer ... />` call (~L928-937), add the prop:

```tsx
          adFreeWindowLabel={sessionInfo.expired ? adFreeWindowLabel : null}
```

- [ ] **Step 8: Consume it in the composer** — in `src/components/inbox/message-composer.tsx`:

Add to `MessageComposerProps` (after `onClearReply?: () => void;`, ~L121):

```tsx
  /** When set (and the session is expired), the expired banner switches to
   *  a "templates are free for {label}" hint for Click-to-WhatsApp ad leads. */
  adFreeWindowLabel?: string | null;
```

Add `adFreeWindowLabel` to the destructured props of the component (wherever `sessionExpired`, `onOpenTemplates`, etc. are destructured from props — e.g. `export function MessageComposer({ ..., onOpenTemplates, adFreeWindowLabel }: MessageComposerProps)`).

Replace the expired banner (~L555-570) so the copy swaps when it's an ad lead:

```tsx
      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {adFreeWindowLabel
              ? t("adFreeWindowHint", { remaining: adFreeWindowLabel })
              : t("sessionExpiredHint")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t("templates")}
          </Button>
        </div>
      )}
```

- [ ] **Step 9: Verify (test + typecheck + lint + build)**

Run: `npm run test -- adWindow && npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/inbox/adWindow.ts src/lib/inbox/adWindow.test.ts src/components/inbox/message-thread.tsx src/components/inbox/message-composer.tsx messages/en.json
git commit -m "feat(ctwa): surface the 72h free-template window on ad leads in the composer"
```

---

### Task 8: "Acquired via ad" row in the contact sidebar

**Files:**
- Modify: `src/components/inbox/contact-sidebar.tsx` (after the Contact `Section` ~L299; imports)
- Modify: `messages/en.json` (`Inbox.sidebar` block)

**Interfaces:**
- Consumes: `Contact.acquisition_source` / `Contact.acquisition_ad` (Task 4). `contact`, `Section`, `tSidebar` are in scope.

- [ ] **Step 1: Add i18n keys** — in `messages/en.json`, inside the `"sidebar": { ... }` object, add:

```json
      "sectionAcquisition": "Acquisition",
      "acquiredViaAd": "Acquired via a Click-to-WhatsApp ad",
      "viewAd": "View ad"
```

- [ ] **Step 2: Import the icon** — in `src/components/inbox/contact-sidebar.tsx`, add `Megaphone` (and `ExternalLink` if not already imported) to the `lucide-react` import block:

```tsx
  Megaphone,
  ExternalLink,
```

- [ ] **Step 3: Render the read-only acquisition section** — in `src/components/inbox/contact-sidebar.tsx`, immediately AFTER the closing `</Section>` of the Contact section (~L299), add:

```tsx
          {contact.acquisition_source === "ad" && (
            <Section icon={Megaphone} label={tSidebar("sectionAcquisition")}>
              <div className="px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {tSidebar("acquiredViaAd")}
                </p>
                {contact.acquisition_ad?.headline && (
                  <p className="mt-0.5 text-sm text-foreground">
                    {contact.acquisition_ad.headline}
                  </p>
                )}
                {contact.acquisition_ad?.source_url && (
                  <a
                    href={contact.acquisition_ad.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 inline-flex items-center gap-0.5 text-xs text-primary hover:underline"
                  >
                    {tSidebar("viewAd")}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </Section>
          )}
```

- [ ] **Step 4: Verify (typecheck + lint + build)**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/inbox/contact-sidebar.tsx messages/en.json
git commit -m "feat(ctwa): show an Acquired-via-ad row in the contact sidebar"
```

---

## Final verification (after all tasks)

- [ ] `npm run test` — full suite green.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm run build` — succeeds.
- [ ] Manual (post-deploy, requires the owner's `convex deploy` + Netlify build): click the live CTWA ad → message the number → confirm (a) the ad card renders above the first message, (b) the thread header + contact sidebar show the ad-lead / acquisition info, (c) simulate/await 24h to see the composer's "templates free for Xh" hint.

## Self-review notes

- **Spec coverage:** §5.1 → Task 1; §5.2/5.3 → Tasks 2–3; §5.4 → Task 4; §5.5 → Task 5; §5.6 → Task 6; §5.7 → Task 7; §5.8 → Task 8. Non-goals (§7) respected — no Meta CAPI events, no inbox filter tab.
- **Type consistency:** `AdReferral` (camelCase, backend, Task 1) is imported by Tasks 2–3; `MessageAdReferral`/`ConversationAdReferral` (snake_case, UI, Task 4) are consumed by Tasks 5–8. `setAdReferralImage`, `adFreeWindowRemainingMs`, `adFreeWindowLabel` names are used identically across producing and consuming tasks.
- **Window correctness:** the 24h `sessionExpired` gate is never widened; the 72h helper only drives display, honoring the Meta rule in the spec §2.2.
