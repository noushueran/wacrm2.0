# Lead-routing failsafe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A qualified lead can never again be dropped silently — every routing failure either falls back to the whole team or raises an admin alert.

**Architecture:** `offerContext` stops returning a bare `null` for seven different conditions and returns a discriminated union (`offer` / `noop` / `exhausted` / `unroutable`) instead. `startLeadOffer` switches on it: `offer` sends as today, the two failure kinds notify admins. When the service tag has no eligible linked member, candidate selection widens to the whole team rather than giving up.

**Tech Stack:** Convex (self-hosted), TypeScript, vitest + convex-test.

Spec: `docs/superpowers/specs/2026-07-19-lead-routing-failsafe-design.md`.

## Global Constraints

- **Never run `npx convex dev` / `deploy` / `codegen`.** There is exactly one live self-hosted Convex and all three push to production. Both tasks add exports to the *existing* `convex/qualificationEngine.ts` module, so `typeof qualificationEngine` picks them up and **no `convex/_generated/api.d.ts` edit is required.**
- **The happy path must stay byte-identical.** When the service tag exists with eligible linked members, the same agent is selected and the same message text is sent. The existing P6 tests at `convex/qualificationEngine.test.ts:1214` and `:1262` must pass untouched.
- **Alerts are ungated.** They must NOT check `adminAlertEnabled`, mirroring the deliberate precedent at `askAdminContext` (`convex/qualificationEngine.ts:1754`). With `adminAlertPhones` empty there is no channel, so alerting no-ops.
- **Only one file changes:** `convex/qualificationEngine.ts` (+ its test file). No schema change, no migration, no new table, no config field.
- **Baselines measured on this branch (`fix/lead-routing-failsafe` @ 878eee3), 2026-07-19:** `npm test` → **1905 passed / 143 files**; `npm run lint` → **0 errors, 15 warnings**, all in pre-existing files. The lint gate is "no NEW findings", not a clean run. (Do not reuse the 1957 figure from the knowledge-engine branch — that tree carries 52 extra kb tests this one does not.)
- **`npm install` has already been run in this worktree.** Git worktrees do not inherit `node_modules`; if it is somehow missing, run `npm install` before anything else or every command fails at once.
- Tests fake the AI: a qualified session's `serviceName` is always the synthetic `"UAE visa"` (`convex/qualificationEngine.test.ts:989`). The base `seed` helper creates the account owner as role `admin` with **no phone**, so the owner is never an eligible offer candidate — which is what makes the "no agents at all" case reachable.

---

### Task 1: `offerContext` returns a discriminated decision, with whole-team fallback

**Files:**
- Modify: `convex/qualificationEngine.ts:2254-2331` (`offerContext`), `:2358-2366` (`startLeadOffer` guard)
- Test: `convex/qualificationEngine.test.ts` (append)

**Interfaces:**
- Produces: exported type `OfferDecision`, consumed by Task 2.

```ts
type OfferCandidate = { userId: Id<"users">; phone: string; name: string; recent: number };

export type OfferDecision =
  | { kind: "noop" }
  | { kind: "unroutable"; reason: "no_agents"; serviceName: string; customerName: string }
  | { kind: "exhausted"; serviceName: string; customerName: string }
  | {
      kind: "offer";
      usedFallback: boolean;
      accountId: Id<"accounts">;
      conversationId: Id<"conversations">;
      contactId: Id<"contacts">;
      agent: OfferCandidate;
      serviceName: string;
      score: number | null;
      summary: string | null;
      customerName: string;
    };
```

- [ ] **Step 1: Write the failing tests**

Append to `convex/qualificationEngine.test.ts`. These reuse the existing `seedAttributed`, `seedAgentWithTag`, `seedCustomerMessage`, `sessionsFor` and `offersFor` helpers already defined in that file.

```ts
// ============================================================
// Routing failsafe — `offerContext` used to return a bare `null` for
// seven different conditions, three benign and four genuine routing
// failures, and `startLeadOffer` treated all seven as "nothing to do".
// Because no `leadOffers` row was written in the failure cases, the
// `sweepLeadOffers` cron (which finds work via `by_status_offered`)
// could never retry them, so the lead was orphaned permanently.
// ============================================================

/** Drives a conversation to a qualified session and returns it. */
async function qualifyLead(t: TestConvex<typeof schema>, base: Awaited<ReturnType<typeof seedAttributed>>) {
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[COMPLETE]] score:85 field:a=1;field:b=2;field:c=3");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });
  const [session] = (await sessionsFor(t, base.conversationId)).filter((s) => s.status === "qualified");
  return session;
}

test("failsafe: a service nobody is linked to still reaches the team, flagged as fallback", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  // Sara is a perfectly good agent — she is just linked to a DIFFERENT
  // service than the synthetic "UAE visa" this lead qualifies for, so
  // the "UAE visa" tag ends up with zero memberTags links.
  const sara = await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971 55 700 8899", tagName: "Georgia tours",
  });
  const session = await qualifyLead(t, base);

  const decision = await t.query(internal.qualificationEngine.offerContext, {
    sessionId: session._id,
  });
  expect(decision.kind).toBe("offer");
  if (decision.kind !== "offer") throw new Error("unreachable");
  expect(decision.usedFallback).toBe(true);
  expect(decision.agent.userId).toBe(sara.userId);

  // and it really is offered, not just classified
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  const offers = await offersFor(t, session._id);
  expect(offers).toHaveLength(1);
  expect(offers[0].agentUserId).toBe(sara.userId);

  // once the fallback pool itself is spent, that is exhaustion too
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971557008899", text: "no",
  });
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: session._id }))
    .toMatchObject({ kind: "exhausted" });
});

test("failsafe: a tag linked only to unreachable members falls back to the team", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  const omar = await seedAgentWithTag(t, base.accountId, {
    name: "Omar", phone: "+971551110002", tagName: "Georgia tours",
  });
  const session = await qualifyLead(t, base);

  // Nadia IS linked to the lead's own service, but has no WhatsApp
  // number, so she can never actually receive an offer — the link
  // exists on paper only. Added after qualification so it attaches to
  // the service tag the engine itself created.
  const tagId = await t.run(async (ctx) => {
    const tag = (await ctx.db.query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", base.accountId)).collect())
      .find((x) => x.name === "UAE visa");
    if (!tag) return null;
    const userId = await ctx.db.insert("users", { name: "Nadia", email: "nadia@example.com" });
    await ctx.db.insert("memberships", {
      userId, accountId: base.accountId, role: "agent",
      fullName: "Nadia", email: "nadia@example.com", // deliberately no phone
    });
    await ctx.db.insert("memberTags", { accountId: base.accountId, userId, tagId: tag._id });
    return tag._id;
  });
  expect(tagId).not.toBeNull(); // the premise: the engine made the service tag

  const decision = await t.query(internal.qualificationEngine.offerContext, {
    sessionId: session._id,
  });
  expect(decision.kind).toBe("offer");
  if (decision.kind !== "offer") throw new Error("unreachable");
  expect(decision.usedFallback).toBe(true);
  expect(decision.agent.userId).toBe(omar.userId);
});

test("failsafe: an account with no agent at all is unroutable, not silent", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  const session = await qualifyLead(t, base);

  const decision = await t.query(internal.qualificationEngine.offerContext, {
    sessionId: session._id,
  });
  expect(decision).toMatchObject({ kind: "unroutable", reason: "no_agents", serviceName: "UAE visa" });
});

test("failsafe: linked agents who have all passed mean exhausted — the team is NOT widened to", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  // Linked to the real service: routing intent WAS expressed for Lina.
  const lina = await seedAgentWithTag(t, base.accountId, {
    name: "Lina", phone: "+971551110001", tagName: "UAE visa",
  });
  // Omar is eligible but deliberately NOT linked to "UAE visa".
  await seedAgentWithTag(t, base.accountId, {
    name: "Omar", phone: "+971551110002", tagName: "Georgia tours",
  });
  const session = await qualifyLead(t, base);

  // Lina is offered first, then declines.
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  expect((await offersFor(t, session._id))[0].agentUserId).toBe(lina.userId);
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971551110001", text: "no",
  });

  // Intent was expressed and honoured, so this is exhausted — Omar must
  // NOT be pulled in behind Lina's back.
  const decision = await t.query(internal.qualificationEngine.offerContext, {
    sessionId: session._id,
  });
  expect(decision).toMatchObject({ kind: "exhausted", serviceName: "UAE visa" });
  expect(await offersFor(t, session._id)).toHaveLength(1);
});

test("failsafe: the three benign cases stay noop", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971 55 700 8899", tagName: "UAE visa",
  });
  const session = await qualifyLead(t, base);

  const patchConfig = async (patch: { autoAssignEnabled: boolean }) => {
    await t.run(async (ctx) => {
      const config = await ctx.db.query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", base.accountId)).unique();
      if (config) await ctx.db.patch(config._id, patch);
    });
  };

  // (a) already assigned
  await t.run((ctx) => ctx.db.patch(base.conversationId, { assignedToUserId: base.userId }));
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: session._id }))
    .toEqual({ kind: "noop" });
  await t.run((ctx) => ctx.db.patch(base.conversationId, { assignedToUserId: undefined }));

  // (b) auto-assign turned off — checked BEFORE any offer exists, so a
  // pass here cannot be the live-offer guard passing by coincidence
  await patchConfig({ autoAssignEnabled: false });
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: session._id }))
    .toEqual({ kind: "noop" });
  await patchConfig({ autoAssignEnabled: true });

  // (c) a live offer already exists
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  expect(await t.query(internal.qualificationEngine.offerContext, { sessionId: session._id }))
    .toEqual({ kind: "noop" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run convex/qualificationEngine.test.ts -t failsafe`
Expected: FAIL — `offerContext` still returns `null` or the old object, so `decision.kind` is `undefined`.

- [ ] **Step 3: Replace `offerContext`**

Replace `convex/qualificationEngine.ts:2254-2331` in full with:

```ts
type OfferCandidate = { userId: Id<"users">; phone: string; name: string; recent: number };

/**
 * What the engine decided to do about a session's lead offer.
 *
 * This is a discriminated union rather than `T | null` on purpose. It
 * previously returned a bare `null` for seven distinct conditions —
 * three benign, four genuine routing failures — and the single caller
 * could not tell them apart, so every failure was swallowed as "nothing
 * to do". Because no `leadOffers` row is written in the failure cases,
 * `sweepLeadOffers` (which finds work via `by_status_offered`) could
 * never retry them either, and the lead was orphaned permanently.
 */
export type OfferDecision =
  | { kind: "noop" }
  | { kind: "unroutable"; reason: "no_agents"; serviceName: string; customerName: string }
  | { kind: "exhausted"; serviceName: string; customerName: string }
  | {
      kind: "offer";
      usedFallback: boolean;
      accountId: Id<"accounts">;
      conversationId: Id<"conversations">;
      contactId: Id<"contacts">;
      agent: OfferCandidate;
      serviceName: string;
      score: number | null;
      summary: string | null;
      customerName: string;
    };

/** Decides who to offer a session's lead to, and why not when nobody. */
export const offerContext = internalQuery({
  args: { sessionId: v.id("qualificationSessions") },
  handler: async (ctx, args): Promise<OfferDecision> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== "qualified" || !session.serviceName) return { kind: "noop" };
    const config = await loadEnabledConfig(ctx, session.accountId);
    if (!config || config.autoAssignEnabled === false) return { kind: "noop" };
    const conversation = await ctx.db.get(session.conversationId);
    if (!conversation || conversation.assignedToUserId) return { kind: "noop" }; // taken already
    // one live offer at a time per session
    const offers = await ctx.db
      .query("leadOffers")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    if (offers.some((o) => o.status === "offered" || o.status === "accepted")) return { kind: "noop" };
    const alreadyTried = new Set(offers.map((o) => o.agentUserId));

    const serviceName = session.serviceName;
    const contact = await ctx.db.get(session.contactId);
    const customerName = contact?.name?.trim() || contact?.phone || "a customer";

    // the service tag (auto-created at completion)
    const tags = await ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", session.accountId))
      .collect();
    const serviceTag = tags.find(
      (t) => t.name.trim().toLowerCase() === serviceName.trim().toLowerCase(),
    );

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", session.accountId))
      .collect();
    // Everyone who could take a lead at all: right role, reachable.
    const eligibleById = new Map<Id<"users">, { phone: string; name: string }>();
    for (const m of memberships) {
      if (!m.phone) continue;
      if (m.role !== "agent" && m.role !== "supervisor") continue;
      eligibleById.set(m.userId, {
        phone: m.phone,
        name: m.fullName ?? m.email ?? "Team member",
      });
    }

    // Who the service tag routes to, computed BEFORE subtracting anyone
    // already tried — an empty set here means no routing intent was ever
    // expressed, which is what licenses the whole-team fallback.
    let poolIds: Id<"users">[] = [];
    if (serviceTag) {
      const links = await ctx.db
        .query("memberTags")
        .withIndex("by_account_tag", (q) =>
          q.eq("accountId", session.accountId).eq("tagId", serviceTag._id),
        )
        .collect();
      poolIds = links.map((l) => l.userId).filter((id) => eligibleById.has(id));
    }

    // No tag, or a tag nobody eligible is linked to: widen to the whole
    // team rather than lose the lead. Note this is deliberately NOT the
    // "linked people exist but have all passed" case — there the intent
    // was expressed and honoured, so we fall through to `exhausted` and
    // let a human decide instead of silently overriding the routing.
    const usedFallback = poolIds.length === 0;
    if (usedFallback) poolIds = Array.from(eligibleById.keys());

    const pool = poolIds.filter((id) => !alreadyTried.has(id));
    if (pool.length === 0) {
      return alreadyTried.size > 0
        ? { kind: "exhausted", serviceName, customerName }
        : { kind: "unroutable", reason: "no_agents", serviceName, customerName };
    }

    const cutoff = Date.now() - 72 * 3_600_000;
    const candidates: OfferCandidate[] = [];
    for (const userId of pool) {
      const m = eligibleById.get(userId);
      if (!m) continue;
      const recentAccepts = await ctx.db
        .query("leadOffers")
        .withIndex("by_agent_status", (q) =>
          q.eq("agentUserId", userId).eq("status", "accepted"),
        )
        .order("desc")
        .take(10);
      candidates.push({
        userId,
        phone: m.phone,
        name: m.name,
        recent: recentAccepts.filter((o) => (o.respondedAt ?? 0) > cutoff).length,
      });
    }
    candidates.sort((a, b) => a.recent - b.recent);

    return {
      kind: "offer",
      usedFallback,
      accountId: session.accountId,
      conversationId: session.conversationId,
      contactId: session.contactId,
      agent: candidates[0],
      serviceName,
      score: session.score ?? null,
      summary: session.summary ?? null,
      customerName,
    };
  },
});
```

- [ ] **Step 4: Adapt the `startLeadOffer` guard**

In `convex/qualificationEngine.ts:2358`, replace only these three lines:

```ts
      const context = await ctx.runQuery(internal.qualificationEngine.offerContext, {
        sessionId: args.sessionId,
      });
      if (!context) return;
```

with:

```ts
      const decision = await ctx.runQuery(internal.qualificationEngine.offerContext, {
        sessionId: args.sessionId,
      });
      // Task 2 replaces this with per-kind handling; for now every
      // non-offer outcome behaves exactly as the old `null` did.
      if (decision.kind !== "offer") return;
      const context = decision;
```

Leave the rest of the handler untouched — `context` keeps the same field names it had.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run convex/qualificationEngine.test.ts && npx tsc --noEmit`
Expected: PASS, including the pre-existing P6 tests at `:1214` and `:1262` — those prove the happy path is unchanged.

- [ ] **Step 6: Commit**

```bash
git add convex/qualificationEngine.ts convex/qualificationEngine.test.ts
git commit -m "fix(qualification): offerContext returns a decision, and unlinked services fall back to the team"
```

---

### Task 2: Admin alerts for the two unroutable outcomes

**Files:**
- Modify: `convex/qualificationEngine.ts` (add `routingAlertPhones` + `alertRoutingFailure`, extend `startLeadOffer`)
- Test: `convex/qualificationEngine.test.ts` (append)

**Interfaces:**
- Consumes: `OfferDecision` from Task 1.
- Produces: `internal.qualificationEngine.routingAlertPhones` (`{accountId}` → `string[]`) and `internal.qualificationEngine.alertRoutingFailure` (`{accountId, text}` → `void`).

- [ ] **Step 1: Write the failing tests**

Append to `convex/qualificationEngine.test.ts`:

```ts
/** Every message sent to a staff/admin WhatsApp number, newest last. */
async function staffMessagesTo(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
  phoneNormalized: string,
) {
  const contact = await t.run((ctx) =>
    ctx.db.query("contacts").withIndex("by_account_phone", (q) =>
      q.eq("accountId", accountId).eq("phoneNormalized", phoneNormalized)).unique());
  if (!contact) return [];
  const conversation = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_contact", (q) =>
      q.eq("contactId", contact._id)).first());
  if (!conversation) return [];
  return await messagesFor(t, conversation._id);
}

/** Points the account's admin alerts at one number. */
async function setAdminAlertPhone(
  t: TestConvex<typeof schema>,
  accountId: Id<"accounts">,
  phone: string,
) {
  await t.run(async (ctx) => {
    const config = await ctx.db.query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
    if (config) await ctx.db.patch(config._id, { adminAlertPhones: [phone] });
  });
}

test("failsafe: a fallback offer tells admins the tag has no linked agent", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await seedAgentWithTag(t, base.accountId, {
    name: "Sara", phone: "+971 55 700 8899", tagName: "Georgia tours",
  });
  await setAdminAlertPhone(t, base.accountId, "+971559456999");
  const session = await qualifyLead(t, base);

  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });

  const msgs = await staffMessagesTo(t, base.accountId, "971559456999");
  expect(msgs.some((m) => m.contentText?.includes("UAE visa"))).toBe(true);
  expect(msgs.some((m) => m.contentText?.includes("whole team"))).toBe(true);
  // the lead still went out — the alert is in addition, not instead
  expect(await offersFor(t, session._id)).toHaveLength(1);
});

test("failsafe: an exhausted cycle tells admins the lead is stranded", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  await seedAgentWithTag(t, base.accountId, {
    name: "Lina", phone: "+971551110001", tagName: "UAE visa",
  });
  await setAdminAlertPhone(t, base.accountId, "+971559456999");
  const session = await qualifyLead(t, base);

  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });
  await t.mutation(internal.qualificationEngine.onAdminInbound, {
    accountId: base.accountId, phoneNormalized: "971551110001", text: "no",
  });
  // the decline re-triggers the offer, which now finds nobody left
  await t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  });

  const msgs = await staffMessagesTo(t, base.accountId, "971559456999");
  expect(msgs.some((m) => m.contentText?.includes("not taken"))).toBe(true);
});

test("failsafe: no admin numbers configured means no send, and no crash", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  const session = await qualifyLead(t, base);
  // no agents and no admin phones: unroutable, but nothing to send to
  await expect(t.action(internal.qualificationEngine.startLeadOffer, {
    accountId: base.accountId, sessionId: session._id,
  })).resolves.toBeUndefined();
  expect(await offersFor(t, session._id)).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run convex/qualificationEngine.test.ts -t failsafe`
Expected: the two alert tests FAIL (no message reaches the admin number); the third passes already.

- [ ] **Step 3: Add the alert plumbing**

Insert immediately above `export const startLeadOffer` in `convex/qualificationEngine.ts`:

```ts
/** Read side for `alertRoutingFailure`. */
export const routingAlertPhones = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<string[]> => {
    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
    return config?.adminAlertPhones ?? [];
  },
});

/**
 * Fans a routing-failure notice out to every configured admin number.
 *
 * Deliberately NOT gated on `adminAlertEnabled`, for the same reason
 * `askAdminContext` above is not: that toggle governs routine new-lead
 * notifications, whereas these are operational failures — "your routing
 * is broken", "this lead is stranded". Someone who muted the former
 * still needs the latter. With no admin numbers configured there is no
 * channel at all, so this no-ops.
 */
export const alertRoutingFailure = internalAction({
  args: { accountId: v.id("accounts"), text: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const phones = await ctx.runQuery(internal.qualificationEngine.routingAlertPhones, {
      accountId: args.accountId,
    });
    for (const phone of phones) {
      await ctx.runAction(internal.qualificationEngine.notifyStaffText, {
        accountId: args.accountId, phone, text: args.text,
      });
    }
  },
});
```

- [ ] **Step 4: Handle each decision kind in `startLeadOffer`**

Replace the Task 1 guard (`if (decision.kind !== "offer") return; const context = decision;`) with:

```ts
      if (decision.kind === "noop") return;
      if (decision.kind === "exhausted") {
        await ctx.runAction(internal.qualificationEngine.alertRoutingFailure, {
          accountId: args.accountId,
          text:
            `⚠️ Lead not taken\n${decision.customerName} — ${decision.serviceName}\n` +
            "Everyone eligible has passed or timed out. Please assign this lead manually.",
        });
        return;
      }
      if (decision.kind === "unroutable") {
        await ctx.runAction(internal.qualificationEngine.alertRoutingFailure, {
          accountId: args.accountId,
          text:
            `⚠️ Lead could not be routed\n${decision.customerName} — ${decision.serviceName}\n` +
            "No team member has the agent or supervisor role with a WhatsApp number. " +
            "Add one in Settings → Team, then assign this lead manually.",
        });
        return;
      }
      const context = decision;
```

Then, immediately after the existing `if (!offerId) return;` line, add:

```ts
      if (context.usedFallback) {
        await ctx.runAction(internal.qualificationEngine.alertRoutingFailure, {
          accountId: args.accountId,
          text:
            `⚠️ Routing not configured\nNo agent is linked to the tag "${context.serviceName}", ` +
            `so ${context.customerName}'s lead was offered to the whole team.\n` +
            "Link the right agents to that tag in Settings → Team to route it properly.",
        });
      }
```

- [ ] **Step 5: Run the full gate**

```bash
npm test
npm run typecheck
npm run build
npm run lint 2>&1 | tail -5
```

Expected: **1913 tests passing** (the 1905 baseline + the 8 new failsafe tests), tsc clean, Next build green, and lint findings **equal to the 0-errors/15-warnings baseline** with none in `qualificationEngine.ts`.

- [ ] **Step 6: Commit**

```bash
git add convex/qualificationEngine.ts convex/qualificationEngine.test.ts
git commit -m "fix(qualification): alert admins when a lead cannot be routed or nobody takes it"
```

---

## Deploy runbook (owner-gated — do NOT run during implementation)

1. `git fetch origin && git merge origin/main`, then re-run the Task 2 gate. Check `gh pr list --state merged --limit 5` for surprises (deploy-collision lesson, 2026-07-18).
2. Copy `.env.local` from the main checkout into the worktree (worktrees lack it).
3. `npx convex deploy -y`, then confirm `npx convex function-spec` lists `qualificationEngine.js:alertRoutingFailure` and `:routingAlertPhones`.
4. Merge the PR. Netlify rebuilds; there are no frontend changes in this fix.
5. **This one is NOT dormant** — it changes live routing behaviour the moment the backend deploys. Rollback is a plain revert; no schema change, no migration.
6. Verify live: confirm `adminAlertPhones` is populated in Settings, then watch the next qualified lead for an unlinked service produce both an offer and an admin notice.
