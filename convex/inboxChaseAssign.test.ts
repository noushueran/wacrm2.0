import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

// Convex function modules for convex-test to resolve `internal.*`
// references against — the absolute, from-project-root pattern every
// other `convex/*.test.ts` suite uses (see `convex/contacts.test.ts`).
const modules = import.meta.glob("/convex/**/*.ts");

const DAY = 24 * 3_600_000;

/**
 * Options for `seedChasing`. Every test below is a single knob turned
 * away from the "obviously due, obviously routable" default.
 */
type SeedChasingOpts = {
  /** "other" seeds a second member and pre-assigns the conversation to them. */
  assignTo?: "other";
  /** Seed no eligible members at all (no phone, or no memberships). */
  noAgents?: boolean;
  /**
   * Defaults to true; false writes autoAssignEnabled: false. `"absent"`
   * omits the key ENTIRELY — the shape of every config row written
   * before Phase 6 added the field, and the one case a `boolean` option
   * cannot express because it always writes something.
   */
  autoAssign?: boolean | "absent";
  /** Master qualification switch. Defaults to true. */
  qualificationEnabled?: boolean;
  /** Days since lastMessageAt. Defaults to 9 — well past the 3-day cutoff. */
  quietDays?: number;
  /** Defaults to false (Waiting/Chasing side). True puts it in Active. */
  awaitingReply?: boolean;
};

/**
 * Seeds one account with everything `sweepChaseAssign` needs to have an
 * opinion about a single conversation: a `qualificationConfigs` row
 * (`sessionWindowHours: 72` -> a 3-day Chasing cutoff), an owner
 * membership (ineligible for routing — `role: "owner"` fails
 * `resolveRouting`'s agent/supervisor filter — but a real supervisor+
 * recipient for the `chase_unassigned` pool notification), a
 * phone-bearing `agent` membership routed via a `tags` + `memberTags`
 * link matching the session's `serviceName` (unless `noAgents`), a
 * contact, a qualification session, and the conversation itself.
 *
 * `accounts.ownerUserId` and `tags.color` are supplied because the
 * schema requires them even though this suite never reads either
 * (the `routing.test.ts` precedent).
 */
async function seedChasing(
  t: ReturnType<typeof convexTest>,
  opts: SeedChasingOpts = {},
) {
  const quietDays = opts.quietDays ?? 9;
  const awaitingReply = opts.awaitingReply ?? false;
  // Spread rather than a plain field, so `"absent"` writes NO key at all
  // instead of relying on Convex's drop-undefined-fields behaviour — the
  // absent case is the whole point of the test that uses it, so it must
  // not depend on a second mechanism to be true.
  const autoAssign =
    opts.autoAssign === "absent"
      ? {}
      : { autoAssignEnabled: opts.autoAssign ?? true };
  const serviceName = "Bali Tours";

  return await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Owner",
      email: "owner@example.com",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "Acct",
      defaultCurrency: "AED",
      ownerUserId,
    });
    // Supervisor+ pool-notification recipient, deliberately ineligible
    // for routing itself (owner is not "agent"/"supervisor").
    await ctx.db.insert("memberships", {
      userId: ownerUserId,
      accountId,
      role: "owner",
      fullName: "Owner",
      email: "owner@example.com",
    });

    await ctx.db.insert("qualificationConfigs", {
      accountId,
      enabled: opts.qualificationEnabled ?? true,
      basicFields: [],
      qualifyThresholdScore: 60,
      timezoneLabel: "Asia/Dubai",
      utcOffsetMinutes: 240,
      workStartMinute: 600,
      workEndMinute: 1260,
      workDays: [1, 2, 3, 4, 5, 6],
      followUpDelaysMinutes: [60],
      maxFollowUps: 4,
      sessionWindowHours: 72,
      closingMessage: "thanks",
      adminAlertEnabled: false,
      adminAlertPhones: [],
      outboundNudgesEnabled: false,
      ...autoAssign,
    });

    const agentId = await ctx.db.insert("users", {
      name: "Ann",
      email: "ann@example.com",
    });
    if (!opts.noAgents) {
      await ctx.db.insert("memberships", {
        userId: agentId,
        accountId,
        role: "agent",
        fullName: "Ann",
        email: "ann@example.com",
        phone: "+971500000001",
      });
      const tagId = await ctx.db.insert("tags", {
        accountId,
        name: serviceName,
        color: "#000000",
      });
      await ctx.db.insert("memberTags", { accountId, userId: agentId, tagId });
    }

    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+971500000099",
      phoneNormalized: "971500000099",
      name: "Cust",
    });

    let otherUserId: Id<"users"> | undefined;
    let assignedToUserId: Id<"users"> | undefined;
    if (opts.assignTo === "other") {
      otherUserId = await ctx.db.insert("users", {
        name: "Bob",
        email: "bob@example.com",
      });
      await ctx.db.insert("memberships", {
        userId: otherUserId,
        accountId,
        role: "agent",
        fullName: "Bob",
        email: "bob@example.com",
        phone: "+971500000002",
      });
      assignedToUserId = otherUserId;
    }

    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      lastMessageAt: Date.now() - quietDays * DAY,
      awaitingReply,
      assignedToUserId,
    });

    await ctx.db.insert("qualificationSessions", {
      accountId,
      conversationId,
      contactId,
      status: "expired",
      origin: "inbound",
      serviceName,
      fields: [],
      expectedCount: 0,
      answeredCount: 0,
      followUpsSent: 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
    });

    return { accountId, agentId, otherUserId, conversationId };
  });
}

/**
 * Seeds one account with `opts.agents` eligible members (all linked to
 * one shared service tag), `opts.loaded` of them pre-assigned one
 * already-Chasing thread each, and `opts.unowned` further Chasing
 * threads with no owner — the fixture the load-spreading test sweeps.
 *
 * `opts.forcedUnowned` adds unowned threads that are in Chasing ONLY
 * because a human forced them: one day quiet (squarely in Waiting by
 * derivation) with `chasingForcedAt` set, so they are reached exclusively
 * through the sweep's forced range and counted exclusively by
 * `pickOwner`'s forced probe.
 */
async function seedChasingFleet(
  t: ReturnType<typeof convexTest>,
  opts: { agents: number; loaded: number; unowned: number; forcedUnowned?: number },
) {
  const serviceName = "Fleet Tours";

  return await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Owner",
      email: "owner-fleet@example.com",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "Fleet Acct",
      defaultCurrency: "AED",
      ownerUserId,
    });
    await ctx.db.insert("memberships", {
      userId: ownerUserId,
      accountId,
      role: "owner",
      fullName: "Owner",
      email: "owner-fleet@example.com",
    });
    await ctx.db.insert("qualificationConfigs", {
      accountId,
      enabled: true,
      basicFields: [],
      qualifyThresholdScore: 60,
      timezoneLabel: "Asia/Dubai",
      utcOffsetMinutes: 240,
      workStartMinute: 600,
      workEndMinute: 1260,
      workDays: [1, 2, 3, 4, 5, 6],
      followUpDelaysMinutes: [60],
      maxFollowUps: 4,
      sessionWindowHours: 72,
      closingMessage: "thanks",
      adminAlertEnabled: false,
      adminAlertPhones: [],
      outboundNudgesEnabled: false,
      autoAssignEnabled: true,
    });

    const tagId = await ctx.db.insert("tags", {
      accountId,
      name: serviceName,
      color: "#111111",
    });

    const agentIds: Id<"users">[] = [];
    for (let i = 0; i < opts.agents; i++) {
      const userId = await ctx.db.insert("users", {
        name: `Agent ${i}`,
        email: `agent${i}@example.com`,
      });
      await ctx.db.insert("memberships", {
        userId,
        accountId,
        role: "agent",
        fullName: `Agent ${i}`,
        email: `agent${i}@example.com`,
        phone: `+97150000100${i}`,
      });
      await ctx.db.insert("memberTags", { accountId, userId, tagId });
      agentIds.push(userId);
    }

    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+971500009999",
      phoneNormalized: "971500009999",
      name: "Fleet Cust",
    });

    const seedThread = async (
      assignedToUserId?: Id<"users">,
      forced?: { chasingForcedAt: number },
    ) => {
      const conversationId = await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        // A forced thread is deliberately seeded INSIDE the Waiting
        // window (1 day), so the force is the only thing putting it in
        // Chasing — exactly the row the derived load count cannot see.
        lastMessageAt: Date.now() - (forced ? 1 : 9) * DAY,
        awaitingReply: false,
        assignedToUserId,
        chasingForcedAt: forced?.chasingForcedAt,
      });
      await ctx.db.insert("qualificationSessions", {
        accountId,
        conversationId,
        contactId,
        status: "expired",
        origin: "inbound",
        serviceName,
        fields: [],
        expectedCount: 0,
        answeredCount: 0,
        followUpsSent: 0,
        phrasingCursor: 0,
        sendAttemptErrors: 0,
      });
      return conversationId;
    };

    // Pre-load the first `loaded` agents with one already-assigned
    // Chasing thread each, so the sweep must steer new threads away.
    for (let i = 0; i < opts.loaded; i++) {
      await seedThread(agentIds[i]);
    }

    const conversationIds: Id<"conversations">[] = [];
    for (let i = 0; i < opts.unowned; i++) {
      conversationIds.push(await seedThread(undefined));
    }

    // Distinct `chasingForcedAt` values so the sweep's `.order("asc")`
    // over the forced range is deterministic.
    const forcedIds: Id<"conversations">[] = [];
    for (let i = 0; i < (opts.forcedUnowned ?? 0); i++) {
      forcedIds.push(await seedThread(undefined, { chasingForcedAt: Date.now() + i }));
    }

    return { conversationIds, forcedIds, agentIds };
  });
}

test("assigns an unowned Chasing thread to a routed agent, without charging", async () => {
  const t = convexTest(schema, modules);
  const { agentId, conversationId } = await seedChasing(t);

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBe(agentId);
  // Deliberately NOT charged — see the spec's billing decision.
  expect(await t.run((ctx) => ctx.db.query("leadCharges").collect())).toHaveLength(0);
});

// The `auto_assign` literal has no other coverage anywhere: a swapped
// source, or an `actorUserId` handed in by accident, would write a
// permanently wrong audit row and still pass every assertion above.
test("the sweep's event is auto_assign with NO actor — nobody assigned it", async () => {
  const t = convexTest(schema, modules);
  const { agentId, conversationId } = await seedChasing(t);

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  const events = await t.run((ctx) =>
    ctx.db
      .query("conversationEvents")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .collect(),
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "assigned",
    source: "auto_assign",
    targetUserId: agentId,
  });
  // Absent, not merely falsy: the sweep IS the system, and that absence
  // is what makes the thread's line read "Auto-assigned to …" instead of
  // naming a person who never touched the chat.
  expect(events[0].actorUserId).toBeUndefined();
});

test("never reassigns a thread that already has an owner", async () => {
  const t = convexTest(schema, modules);
  const { conversationId, otherUserId } = await seedChasing(t, { assignTo: "other" });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBe(otherUserId);
});

test("leaves a Waiting thread alone — only Chasing is swept", async () => {
  const t = convexTest(schema, modules);
  // One day quiet, well inside the 3-day cutoff.
  const { conversationId } = await seedChasing(t, { quietDays: 1 });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBeUndefined();
});

test("the auto-assign sweep skips a snoozed thread", async () => {
  const t = convexTest(schema, modules);
  const { conversationId } = await seedChasing(t);
  await t.run((ctx) => ctx.db.patch(conversationId, {
    snoozedUntil: Date.now() + 86_400_000,
  }));

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId).toBeUndefined();
});

test("the auto-assign sweep DOES pick up a forced thread", async () => {
  const t = convexTest(schema, modules);
  // quietDays: 1 keeps it inside Waiting by derivation; the force is the
  // only reason it should be swept.
  const { agentId, conversationId } = await seedChasing(t, { quietDays: 1 });
  await t.run((ctx) => ctx.db.patch(conversationId, { chasingForcedAt: Date.now() }));

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId).toBe(agentId);
});

test("an Active thread is never assigned by this sweep, however old", async () => {
  const t = convexTest(schema, modules);
  const { conversationId } = await seedChasing(t, { awaitingReply: true, quietDays: 90 });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBeUndefined();
});

test("no eligible agent leaves it unassigned and notifies the pool", async () => {
  const t = convexTest(schema, modules);
  const { conversationId } = await seedChasing(t, { noAgents: true });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBeUndefined();
  const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(notes.map((n) => n.type)).toContain("chase_unassigned");
});

test("skipped entirely when autoAssignEnabled is false", async () => {
  const t = convexTest(schema, modules);
  const { conversationId } = await seedChasing(t, { autoAssign: false });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBeUndefined();
});

// The other side of that gate, and the one the rest of this suite cannot
// reach. `autoAssignEnabled` is `v.optional(v.boolean())` added in Phase
// 6, so every config row written before then has NO such key — and the
// sweep's `=== false` is the only thing that decides those rows are ON.
// Every other test here pins the flag explicitly (this file always wrote
// it; `defaultQualificationConfig()` supplies `true` elsewhere), so a regression
// from `config.autoAssignEnabled === false` to a truthy test
// (`!config.autoAssignEnabled`) would silently switch auto-assign OFF for
// every pre-Phase-6 account with the whole suite still green. This is the
// test that goes red instead.
// The master switch, which this sweep did not consult at all. Every other
// per-account job keyed on `qualificationConfigs` stops when an owner turns
// qualification off — `qualificationEngine.ts`'s staff-keepalive loop does
// exactly `if (!config.enabled) continue`. This cron did not, so an account
// with qualification switched OFF still had its Chasing backlog assigned
// every 30 minutes, and still had staff notified about it.
//
// This is NOT the same question as `autoAssignEnabled`, which stays opt-OUT
// (the test below pins that, deliberately). `enabled` is a required
// `v.boolean()` an owner sets explicitly; honouring it cannot silently
// change behaviour for a row that predates a field.
test("an account with qualification switched off is skipped entirely", async () => {
  const t = convexTest(schema, modules);
  const { conversationId } = await seedChasing(t, { qualificationEnabled: false });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBeUndefined();
});

test("an absent autoAssignEnabled still sweeps — the flag is opt-OUT, not opt-in", async () => {
  const t = convexTest(schema, modules);
  const { accountId, agentId, conversationId } = await seedChasing(t, {
    autoAssign: "absent",
  });

  // The premise, asserted rather than assumed: if the seed ever starts
  // writing the field again this test silently degrades into a duplicate
  // of the plain happy-path one at the top of the file.
  const config = await t.run((ctx) =>
    ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique(),
  );
  expect(config).not.toBeNull();
  expect(Object.hasOwn(config!, "autoAssignEnabled")).toBe(false);

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBe(agentId);
});

test("spreads across agents by current Chasing load", async () => {
  const t = convexTest(schema, modules);
  // Two eligible agents, one already holding a Chasing thread; three
  // unowned threads must not all land on the same person.
  const { conversationIds, agentIds } = await seedChasingFleet(t, {
    agents: 2, loaded: 1, unowned: 3,
  });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  const owners = await Promise.all(
    conversationIds.map(async (id) =>
      (await t.run((ctx) => ctx.db.get(id)))!.assignedToUserId),
  );
  for (const owner of owners) expect(agentIds).toContain(owner);

  // The exact distribution `pickOwner`'s greedy-minimum-load rule
  // produces here: agent 0 starts pre-loaded with 1 Chasing thread,
  // agent 1 with 0. Conversation 1 goes to the idle agent 1 (load 0
  // always wins outright). That ties both agents at load 1, so
  // conversation 2 goes to agent 0 (first-seen-minimum tie-break, pool
  // order [agent0, agent1]). That puts agent 0 back in the lead at load
  // 2 vs. agent 1's load 1, so conversation 3 goes to agent 1 again.
  // Net: agent 0 picks up exactly 1 of the 3 new threads, agent 1 picks
  // up exactly 2 — proof the pre-loaded agent was steered away from, not
  // just "not all four landed on one person".
  const counts = new Map<string, number>();
  for (const owner of owners) {
    const key = String(owner);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  expect(counts.get(String(agentIds[0]))).toBe(1);
  expect(counts.get(String(agentIds[1]))).toBe(2);
});

// Final whole-branch review, Finding 4. `pickOwner` counted a candidate's
// Chasing load over a range binding `eq("chasingForcedAt", undefined)`,
// which cannot see forced threads at all — and forced threads are exactly
// what the sweep hands out in the same batch. So the load-balancer
// observed no change while assigning them, and EVERY forced thread in a
// run went to whichever candidate started with the lowest count. Two
// forced threads and two idle agents is the smallest fixture that shows
// it: before the fix both landed on agent 0.
test("two forced threads in one sweep do not both land on the same agent", async () => {
  const t = convexTest(schema, modules);
  const { forcedIds, agentIds } = await seedChasingFleet(t, {
    agents: 2, loaded: 0, unowned: 0, forcedUnowned: 2,
  });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  const owners = await Promise.all(
    forcedIds.map(async (id) =>
      (await t.run((ctx) => ctx.db.get(id)))!.assignedToUserId),
  );
  for (const owner of owners) expect(agentIds).toContain(owner);
  expect(new Set(owners.map(String)).size).toBe(2);
});

// ============================================================
// Fix round 1 — issues a Critical/Important review found that no test
// above caught.
// ============================================================

test("a repeat-inquiry conversation (two qualificationSessions rows) still gets assigned, not thrown", async () => {
  const t = convexTest(schema, modules);
  const { accountId, agentId, conversationId } = await seedChasing(t);

  // `qualificationEngine.ts`'s "Fresh lead for the same contact" path
  // inserts a SECOND `qualificationSessions` row for the same
  // `conversationId` — `by_conversation` is not 1:1. Before the fix,
  // `pickOwner` read it with `.unique()`, which throws on more than one
  // match; that throw would abort this whole mutation (every account's
  // work in this pass), and since the offending row is read oldest-first
  // and nothing here clears it, it would repeat every single sweep.
  await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(conversationId))!;
    await ctx.db.insert("qualificationSessions", {
      accountId,
      conversationId,
      contactId: conversation.contactId,
      status: "expired",
      origin: "inbound",
      serviceName: "Bali Tours",
      fields: [],
      expectedCount: 0,
      answeredCount: 0,
      followUpsSent: 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
    });
  });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBe(agentId);
});

test("notifies the new owner via conversation_assigned when auto-assigned", async () => {
  const t = convexTest(schema, modules);
  const { agentId, conversationId } = await seedChasing(t);

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
  const assignedNote = notes.find((n) => n.type === "conversation_assigned");
  expect(assignedNote).toBeDefined();
  expect(assignedNote?.userId).toBe(agentId);
  expect(assignedNote?.conversationId).toBe(conversationId);
});

test("no eligible agent notifies each recipient ONCE per sweep, not once per stuck conversation", async () => {
  const t = convexTest(schema, modules);
  const { conversationIds } = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Owner", email: "owner-dedupe@example.com",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "Dedupe Acct", defaultCurrency: "AED", ownerUserId,
    });
    await ctx.db.insert("memberships", {
      userId: ownerUserId, accountId, role: "owner",
      fullName: "Owner", email: "owner-dedupe@example.com",
    });
    const supervisorId = await ctx.db.insert("users", {
      name: "Sup", email: "sup-dedupe@example.com",
    });
    await ctx.db.insert("memberships", {
      userId: supervisorId, accountId, role: "supervisor",
      fullName: "Sup", email: "sup-dedupe@example.com",
    });
    await ctx.db.insert("qualificationConfigs", {
      accountId, enabled: true, basicFields: [], qualifyThresholdScore: 60,
      timezoneLabel: "Asia/Dubai", utcOffsetMinutes: 240,
      workStartMinute: 600, workEndMinute: 1260, workDays: [1, 2, 3, 4, 5, 6],
      followUpDelaysMinutes: [60], maxFollowUps: 4, sessionWindowHours: 72,
      closingMessage: "thanks", adminAlertEnabled: false, adminAlertPhones: [],
      outboundNudgesEnabled: false, autoAssignEnabled: true,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000077", phoneNormalized: "971500000077",
      name: "Cust2",
    });
    const ids: Id<"conversations">[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await ctx.db.insert("conversations", {
          accountId, contactId, status: "open", unreadCount: 0,
          lastMessageAt: Date.now() - 9 * DAY, awaitingReply: false,
        }),
      );
    }
    return { accountId, conversationIds: ids };
  });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  for (const id of conversationIds) {
    expect((await t.run((ctx) => ctx.db.get(id)))!.assignedToUserId)
      .toBeUndefined();
  }
  const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
  const chaseNotes = notes.filter((n) => n.type === "chase_unassigned");
  // Two supervisor+ recipients (owner + supervisor) × ONE notification
  // each — not × 3 stuck conversations. This is the exact multiplication
  // the review flagged: `poolIds` is only ever empty because the whole
  // account has zero eligible members, so the "nobody eligible" fact is
  // account-wide, not per-conversation.
  expect(chaseNotes).toHaveLength(2);
});

// ============================================================
// Final whole-branch review, Finding 2 — the per-sweep bound above does
// not bound anything ACROSS sweeps, and "no eligible agent" is a standing
// configuration fault (memberships with no `phone`), so at one sweep
// every 30 minutes it was 48 notifications per supervisor per day,
// forever, with no off switch that does not also disable lead offers.
// ============================================================

test("chase_unassigned is not repeated on the next sweep while the first is still unread", async () => {
  const t = convexTest(schema, modules);
  await seedChasing(t, { noAgents: true });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});
  const afterFirst = await t.run((ctx) =>
    ctx.db.query("notifications").collect(),
  );
  const firstChase = afterFirst.filter((n) => n.type === "chase_unassigned");
  expect(firstChase).toHaveLength(1); // the owner membership

  // The condition has not changed and nobody has read the bell.
  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});
  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  const afterMore = await t.run((ctx) =>
    ctx.db.query("notifications").collect(),
  );
  expect(afterMore.filter((n) => n.type === "chase_unassigned")).toHaveLength(1);
});

test("chase_unassigned is sent again once the recipient has read the previous one", async () => {
  const t = convexTest(schema, modules);
  await seedChasing(t, { noAgents: true });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  // Reading it is the acknowledgement — the fault is still there, so the
  // next sweep is entitled to say so again. Dedupe on UNREAD, not on
  // "ever sent", so an admin who reads and forgets is told again rather
  // than never.
  await t.run(async (ctx) => {
    const note = (await ctx.db.query("notifications").collect()).find(
      (n) => n.type === "chase_unassigned",
    )!;
    await ctx.db.patch(note._id, { readAt: Date.now() });
  });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(notes.filter((n) => n.type === "chase_unassigned")).toHaveLength(2);
});

// ============================================================
// Task 8 — Gate 5: chase auto-assignment must not put a human on a
// do-not-contact lead. `blockedReason` (`lib/notes/gate.ts`) is the one
// predicate every outbound-to-customer path shares; this sweep is one of
// its five call sites. The gate sits where the derived (`due`) and
// forced (`forced`) ranges converge into `batch`, so both are covered by
// one check rather than two.
// ============================================================

async function markDoNotContact(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  contactId: Id<"contacts">,
) {
  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Asked us to stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(contactId, { doNotContact: { at: Date.now(), noteId } });
  });
}

test("a do-not-contact lead in the age-based (derived) range is not auto-assigned", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedChasing(t);
  const contactId = (await t.run((ctx) => ctx.db.get(conversationId)))!.contactId;
  await markDoNotContact(t, accountId, contactId);

  const result = await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect(result.assigned).toBe(0);
  expect(result.unroutable).toBe(0);
  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.assignedToUserId).toBeUndefined();
});

// This is the half a partial fix (gating only the derived `due` range)
// would miss: `chasingForcedAt` puts a thread in Chasing regardless of
// age, reached exclusively through the sweep's separate forced range.
test("a do-not-contact lead in the forced-chasing range is not auto-assigned either", async () => {
  const t = convexTest(schema, modules);
  // quietDays: 1 keeps it inside Waiting by derivation, same as the
  // existing "DOES pick up a forced thread" test — the force is the only
  // reason this thread would otherwise be swept at all.
  const { accountId, conversationId } = await seedChasing(t, { quietDays: 1 });
  const contactId = (await t.run((ctx) => ctx.db.get(conversationId)))!.contactId;
  await markDoNotContact(t, accountId, contactId);
  await t.run((ctx) =>
    ctx.db.patch(conversationId, { chasingForcedAt: Date.now() }),
  );

  const result = await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect(result.assigned).toBe(0);
  expect(result.unroutable).toBe(0);
  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.assignedToUserId).toBeUndefined();
});

// Regression guard: a normal Chasing lead with no do-not-contact flag is
// unaffected by the gate.
test("a non-blocked chasing lead is still auto-assigned", async () => {
  const t = convexTest(schema, modules);
  const { agentId, conversationId } = await seedChasing(t);

  const result = await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect(result.assigned).toBe(1);
  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.assignedToUserId).toBe(agentId);
});

test("an unread notification of a DIFFERENT type does not suppress chase_unassigned", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedChasing(t, { noAgents: true });

  // The dedupe must key on the type, not merely on "has unread mail" —
  // otherwise a single unread SLA alert would silence the sweep forever.
  await t.run(async (ctx) => {
    const owner = (
      await ctx.db
        .query("memberships")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .collect()
    ).find((m) => m.role === "owner")!;
    await ctx.db.insert("notifications", {
      accountId,
      userId: owner.userId,
      type: "sla_alert",
      title: "SLA breach",
    });
  });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(notes.filter((n) => n.type === "chase_unassigned")).toHaveLength(1);
});
