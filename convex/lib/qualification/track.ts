import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { normalizePhone } from "../phone";

// ============================================================
// P0 tracking core (spec §6) — every helper is a cheap building block
// called from hot paths (the ingest fan-out, the shared message-persist
// mutation), so:
//   - `loadEnabledConfig` is the single dormancy gate: one indexed
//     read; null (absent row or enabled:false) means every caller
//     no-ops and the deployed feature stays invisible.
//   - db helpers take `{ db }` (the `lib/leadCharge.ts` pattern) so any
//     mutation's ctx can call them without threading the full ctx type.
// P1 (analysis) and P3 (follow-ups) build on these same rows.
// ============================================================

type DbCtx = { db: MutationCtx["db"] };
// Reader-typed ctx for the read-only gate below, so `internalQuery`
// handlers (whose `db` has no write methods) can call it too — a
// MutationCtx's db is a strict superset, so both call sites typecheck.
type DbReadCtx = { db: QueryCtx["db"] };

export async function loadEnabledConfig(
  ctx: DbReadCtx,
  accountId: Id<"accounts">,
): Promise<Doc<"qualificationConfigs"> | null> {
  const config = await ctx.db
    .query("qualificationConfigs")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .unique();
  return config?.enabled ? config : null;
}

/**
 * Loop guard (spec §9): the bot must never open a qualification session
 * on its own admin-alert channel. Compared on normalized digits so the
 * config can hold human-formatted numbers ("+971 50 111 2222").
 */
export function isAdminAlertNumber(
  config: Doc<"qualificationConfigs">,
  phoneNormalized: string,
): boolean {
  return config.adminAlertPhones.some(
    (p) => normalizePhone(p) === phoneNormalized,
  );
}

/**
 * Idempotent create — one session per conversation, first-wins (an
 * existing session's origin/status are never rewritten here; Convex
 * serializes mutations, so `by_conversation` uniqueness holds without a
 * DB constraint). Inbound-origin sessions start their 72h clock at
 * creation; outbound-origin ones wait for the first customer reply.
 */
export async function ensureSession(
  ctx: DbCtx,
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
    origin: "inbound" | "outbound";
    now: number;
  },
): Promise<Id<"qualificationSessions">> {
  const existing = await ctx.db
    .query("qualificationSessions")
    .withIndex("by_conversation", (q) =>
      q.eq("conversationId", args.conversationId),
    )
    .order("desc")
    .first();
  if (existing) return existing._id;
  return await ctx.db.insert("qualificationSessions", {
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    status: "collecting",
    origin: args.origin,
    fields: [],
    expectedCount: 0,
    answeredCount: 0,
    followUpsSent: 0,
    phrasingCursor: 0,
    sendAttemptErrors: 0,
    ...(args.origin === "inbound" ? { lastCustomerMessageAt: args.now } : {}),
  });
}

/**
 * Any inbound message = engagement: bump the 24h/72h clocks, cancel the
 * pending follow-up, reset the send-error streak. Terminal sessions are
 * left untouched (a reply to an already-qualified/expired thread is the
 * human team's business, not this engine's).
 */
export async function recordInboundActivity(
  ctx: DbCtx,
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
    now: number;
  },
): Promise<void> {
  const sessionId = await ensureSession(ctx, { ...args, origin: "inbound" });
  const session = await ctx.db.get(sessionId);
  if (!session || session.status !== "collecting") return;
  await ctx.db.patch(sessionId, {
    lastCustomerMessageAt: args.now,
    nextFollowUpAt: undefined,
    sendAttemptErrors: 0,
  });
}

/**
 * Outbound persist hook (spec §6): ensures an outbound-origin session
 * exists for chats WE start (agent outreach, broadcasts, engine sends);
 * a manual agent send additionally stamps `humanTouchedAt` so the
 * follow-up engine yields to the human working the thread. Takes the
 * already-loaded enabled config so it can apply the SAME admin-number
 * loop guard as `onInbound` — the lead-alert send itself flows through
 * this hook, and must never open a session on its own alert channel.
 */
export async function recordOutboundSend(
  ctx: DbCtx,
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    senderType: "agent" | "bot";
    now: number;
    config: Doc<"qualificationConfigs">;
  },
): Promise<void> {
  const conversation = await ctx.db.get(args.conversationId);
  if (!conversation || conversation.accountId !== args.accountId) return;
  if (conversation.status === "closed") return; // mirror onInbound (review fix)
  const contact = await ctx.db.get(conversation.contactId);
  if (contact) {
    const staff = await loadStaffPhoneSet(ctx, args.accountId, args.config);
    if (isStaffNumber(staff, contact.phoneNormalized)) {
      return; // loop guard (spec §9; P6: all staff numbers)
    }
  }
  const sessionId = await ensureSession(ctx, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: conversation.contactId,
    origin: "outbound",
    now: args.now,
  });
  if (args.senderType === "agent") {
    const session = await ctx.db.get(sessionId);
    if (session && session.status === "collecting") {
      await ctx.db.patch(sessionId, { humanTouchedAt: args.now });
    }
  }
}

/**
 * Phase 6: the full STAFF phone set — admin alert numbers PLUS every
 * member's own WhatsApp number. All engine loop guards key off this set
 * (a staff chat must never become a lead), and the offer/keepalive
 * machinery messages exactly these numbers. One indexed collect over the
 * account's memberships (small) per call.
 */
export async function loadStaffPhoneSet(
  ctx: DbReadCtx,
  accountId: Id<"accounts">,
  config: Doc<"qualificationConfigs">,
): Promise<Set<string>> {
  const set = new Set<string>(
    config.adminAlertPhones.map((p) => normalizePhone(p)).filter(Boolean),
  );
  const members = await ctx.db
    .query("memberships")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();
  for (const m of members) {
    if (m.phone) {
      const digits = normalizePhone(m.phone);
      if (digits) set.add(digits);
    }
  }
  return set;
}

export function isStaffNumber(staff: Set<string>, phoneNormalized: string): boolean {
  return staff.has(phoneNormalized);
}
