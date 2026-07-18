import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { requireConversationAccess } from "./lib/conversationAccess";
import { holidayysDefaultConfig } from "./lib/qualification/defaults";
import {
  validateConfigPatch,
  CONFIG_PATCH_KEYS,
  type QualificationConfigPatch,
} from "./lib/qualification/validate";

// ============================================================
// Lead-qualification config CRUD (P0 — spec §11/§12). Admin-gated on
// BOTH read and write: the config carries the admin alert phone
// numbers. The engine itself never reads through here — it uses
// `lib/qualification/track.ts`'s `loadEnabledConfig` (internal,
// caller-supplied accountId), the same split `aiConfig.loadDecrypted`
// keeps from its own settings CRUD.
//
// `patch: v.any()` + the pure `validateConfigPatch` (not a giant
// validator literal): the patch is admin-only input, the schema's own
// table validator still enforces shape on insert/patch, and the pure
// function gives friendlier errors + direct unit-testability.
// ============================================================

export const getConfig = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const row = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();
    if (row) return { ...row, isPersisted: true as const };
    return {
      ...holidayysDefaultConfig(),
      accountId: ctx.accountId,
      isPersisted: false as const,
    };
  },
});

export const updateConfig = accountMutation({
  args: { patch: v.any() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    // Whitelist (review fix): only known config keys survive, so a stray
    // client field fails HERE as a clean no-op instead of surfacing as a
    // raw schema-validation error from db.insert/patch.
    const raw = (args.patch ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of CONFIG_PATCH_KEYS) {
      if (raw[key] !== undefined) patch[key] = raw[key];
    }

    const error = validateConfigPatch(patch as QualificationConfigPatch);
    if (error) throw new ConvexError({ code: "BAD_REQUEST", reason: error });

    const existing = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    // Merge over the stored row (or the seeded defaults on first save) so
    // a partial patch — e.g. just {enabled:true} from the settings toggle
    // — always lands on a complete, schema-valid document.
    const base = existing ?? {
      ...holidayysDefaultConfig(),
      accountId: ctx.accountId,
    };
    const merged = { ...base, ...patch, updatedAt: Date.now() };
    if (merged.workStartMinute >= merged.workEndMinute) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "workStartMinute must be before workEndMinute",
      });
    }

    if (existing) {
      const { _id, _creationTime, ...update } = merged as typeof existing;
      await ctx.db.patch(existing._id, update);
      return existing._id;
    }
    return await ctx.db.insert("qualificationConfigs", merged);
  },
});

/**
 * Inbox chip data (spec §10): one conversation's qualification progress.
 * Access mirrors the thread itself — `requireConversationAccess(...,
 * "view")` (agents: own + unassigned; supervisor+: all; viewers may
 * look). Null when the conversation has no session (feature off, admin
 * channel, or pre-feature history) so the chip simply doesn't render.
 */
export const getSessionForConversation = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversationAccess(ctx, args.conversationId, "view");
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();
    if (!session || session.accountId !== ctx.accountId) return null;

    // Tooltip hint: the next thing the engine wants to know.
    let missingHint: string | null = session.pendingQuestion?.text ?? null;
    if (!missingHint && session.status === "collecting") {
      const config = await ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .unique();
      const answered = new Set(
        session.fields.filter((f) => f.confidence !== "low").map((f) => f.key),
      );
      // Same absent-row fallback as `getConfig` above: defaults apply
      // until an admin persists a config.
      const basicFields = config?.basicFields ?? holidayysDefaultConfig().basicFields;
      missingHint =
        basicFields.find((f) => f.required && !answered.has(f.key))?.label ?? null;
    }

    return {
      status: session.status,
      answeredCount: session.answeredCount,
      expectedCount: session.expectedCount,
      score: session.score ?? null,
      serviceName: session.serviceName ?? null,
      ready: !!session.checklistSatisfiedAt,
      missingHint,
    };
  },
});

// ============================================================
// The Leads workspace query (P4 — spec §10). Supervisor+ (matches the
// app's nav philosophy: agents work their assigned leads from the
// Inbox; the cross-account sales queue is a supervisor surface).
// ONE round-trip: summary counts + the score-sorted lead list with the
// joins the board renders (contact, assignee, source, answers).
// Bounded: per-status `take` caps — no unbounded collects (the
// campaigns.overview scale lesson).
// ============================================================

const LEAD_STATUSES = [
  "collecting",
  "qualified",
  "expired",
  "opted_out",
  "disqualified",
] as const;

export const leadsBoard = accountQuery({
  args: {},
  handler: async (ctx) => {
    // v4 RBAC (owner rule): agents work ONLY their own assigned leads;
    // supervisor+ see everything (with assignee details). Viewers have
    // no lead queue.
    ctx.requireRole("agent");
    const ownOnly = ctx.role === "agent";

    const caps: Record<(typeof LEAD_STATUSES)[number], number> = {
      collecting: 200,
      qualified: 200,
      expired: 50,
      opted_out: 50,
      disqualified: 50,
    };

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    // No `email` fallback: `members.list` nulls a member's email below
    // admin (staff PII), and this board is served to agents/supervisors —
    // a name or the generic "Member", never the email.
    const memberName = new Map(
      memberships.map((m) => [m.userId, m.fullName ?? "Member"]),
    );

    const summary: Record<string, number> = {};
    const leads: {
      sessionId: string;
      conversationId: string;
      status: string;
      origin: string;
      score: number | null;
      serviceName: string | null;
      summary: string | null;
      answeredCount: number;
      expectedCount: number;
      followUpsSent: number;
      nextFollowUpAt: number | null;
      qualifiedAt: number | null;
      closedReason: string | null;
      startedAt: number;
      contactName: string;
      contactPhone: string;
      source: "ad" | "website" | "organic";
      assigneeName: string | null;
      fields: { key: string; label: string | null; value: string; confidence: string }[];
      scoreBreakdown: { criterion: string; marks: number; maxMarks: number; reason: string | null }[];
      assignment: {
        acceptedAt: number | null;
        offersMade: number;
        lastFeedback: string | null;
        lastFeedbackAt: number | null;
      };
      funnelStage: string | null;
      funnelStageUpdatedAt: number | null;
      saleValue: number | null;
      saleCurrency: string | null;
      checklist: {
        checklistId: string;
        source: "kb" | "default";
        doneCount: number;
        total: number;
        outcome: {
          result: "won" | "lost";
          lossCategory: string | null;
          lossDetail: string | null;
          at: number;
        } | null;
        items: {
          key: string;
          title: string;
          description: string | null;
          done: boolean;
          doneAt: number | null;
          doneByName: string | null;
          note: string | null;
        }[];
      } | null;
    }[] = [];

    for (const status of LEAD_STATUSES) {
      const rows = await ctx.db
        .query("qualificationSessions")
        .withIndex("by_account_status", (q) =>
          q.eq("accountId", ctx.accountId).eq("status", status),
        )
        .order("desc")
        .take(caps[status]);

      for (const s of rows) {
        const contact = await ctx.db.get(s.contactId);
        const conversation = await ctx.db.get(s.conversationId);
        if (!contact || !conversation) continue;
        if (ownOnly && conversation.assignedToUserId !== ctx.userId) continue;
        const source: "ad" | "website" | "organic" =
          conversation.attribution?.lane === "ctwa" || conversation.adReferral
            ? "ad"
            : conversation.attribution?.lane === "code"
              ? "website"
              : "organic";
        // P6 assignment trail for the board (offers, acceptance, agent
        // feedback) — one small indexed collect per rendered session.
        const offers = await ctx.db
          .query("leadOffers")
          .withIndex("by_session", (q) => q.eq("sessionId", s._id))
          .collect();
        const accepted = offers
          .filter((o) => o.status === "accepted")
          .sort((a, b) => (b.respondedAt ?? 0) - (a.respondedAt ?? 0))[0];
        // The lead's sales checklist (pipeline discipline) — one indexed
        // point read per rendered session.
        const checklistRow = await ctx.db
          .query("salesChecklists")
          .withIndex("by_session", (q) => q.eq("sessionId", s._id))
          .unique();
        leads.push({
          sessionId: s._id,
          conversationId: s.conversationId,
          status: s.status,
          origin: s.origin,
          score: s.score ?? null,
          serviceName: s.serviceName ?? null,
          summary: s.summary ?? null,
          answeredCount: s.answeredCount,
          expectedCount: s.expectedCount,
          followUpsSent: s.followUpsSent,
          nextFollowUpAt: s.nextFollowUpAt ?? null,
          qualifiedAt: s.qualifiedAt ?? null,
          closedReason: s.closedReason ?? null,
          startedAt: s._creationTime,
          contactName: contact.name?.trim() || contact.phone,
          contactPhone: contact.phone, // supervisor+ always sees phones (canSeeContactPhone)
          source,
          assigneeName: conversation.assignedToUserId
            ? (memberName.get(conversation.assignedToUserId) ?? null)
            : null,
          fields: s.fields.map((f) => ({
            key: f.key,
            label: f.label ?? null,
            value: f.value,
            confidence: f.confidence,
          })),
          scoreBreakdown: (s.scoreBreakdown ?? []).map((b) => ({
            criterion: b.criterion,
            marks: b.marks,
            maxMarks: b.maxMarks,
            reason: b.reason ?? null,
          })),
          assignment: {
            acceptedAt: accepted?.respondedAt ?? null,
            offersMade: offers.length,
            lastFeedback: accepted?.feedback ?? null,
            lastFeedbackAt: accepted?.feedbackAt ?? null,
          },
          funnelStage: conversation.funnel?.stage ?? null,
          funnelStageUpdatedAt: conversation.funnel?.stageUpdatedAt ?? null,
          saleValue: conversation.funnel?.saleValue ?? null,
          saleCurrency: conversation.funnel?.saleCurrency ?? null,
          checklist: checklistRow
            ? {
                checklistId: checklistRow._id,
                source: checklistRow.source,
                doneCount: checklistRow.items.filter((i) => i.done).length,
                total: checklistRow.items.length,
                outcome: checklistRow.outcome
                  ? {
                      result: checklistRow.outcome.result,
                      lossCategory: checklistRow.outcome.lossCategory ?? null,
                      lossDetail: checklistRow.outcome.lossDetail ?? null,
                      at: checklistRow.outcome.at,
                    }
                  : null,
                items: checklistRow.items.map((i) => ({
                  key: i.key,
                  title: i.title,
                  description: i.description ?? null,
                  done: i.done,
                  doneAt: i.doneAt ?? null,
                  doneByName: i.doneByUserId
                    ? (memberName.get(i.doneByUserId) ?? null)
                    : null,
                  note: i.note ?? null,
                })),
              }
            : null,
        });
      }
    }

    // The sales queue: qualified first by score desc, then in-progress by
    // score desc, then the closed states, newest first within ties.
    const statusRank: Record<string, number> = {
      qualified: 0,
      collecting: 1,
      expired: 2,
      opted_out: 3,
      disqualified: 4,
    };
    leads.sort((a, b) => {
      const rank = statusRank[a.status] - statusRank[b.status];
      if (rank !== 0) return rank;
      const score = (b.score ?? -1) - (a.score ?? -1);
      if (score !== 0) return score;
      return b.startedAt - a.startedAt;
    });

    for (const status of LEAD_STATUSES) {
      summary[status] = leads.filter((l) => l.status === status).length;
    }

    const qualifiedScores = leads
      .filter((l) => l.status === "qualified" && l.score !== null)
      .map((l) => l.score as number);
    const totalTracked = LEAD_STATUSES.reduce((n, s) => n + (summary[s] ?? 0), 0);

    return {
      summary: {
        collecting: summary.collecting ?? 0,
        qualified: summary.qualified ?? 0,
        expired: summary.expired ?? 0,
        opted_out: summary.opted_out ?? 0,
        disqualified: summary.disqualified ?? 0,
        total: totalTracked,
        qualificationRate:
          totalTracked > 0 ? Math.round(((summary.qualified ?? 0) / totalTracked) * 100) : 0,
        avgScore:
          qualifiedScores.length > 0
            ? Math.round(qualifiedScores.reduce((a, b) => a + b, 0) / qualifiedScores.length)
            : 0,
      },
      leads,
    };
  },
});
