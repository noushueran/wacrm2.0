import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { requireConversationAccess } from "./lib/conversationAccess";
import { holidayysDefaultConfig } from "./lib/qualification/defaults";
import { validateConfigPatch, type QualificationConfigPatch } from "./lib/qualification/validate";

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
    const raw = { ...((args.patch ?? {}) as Record<string, unknown>) };
    delete raw._id;
    delete raw._creationTime;
    delete raw.accountId;
    delete raw.isPersisted;
    const patch = raw as QualificationConfigPatch;

    const error = validateConfigPatch(patch);
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
      .unique();
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
