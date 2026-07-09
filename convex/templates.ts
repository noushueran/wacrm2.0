import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Message templates (Phase 4, Task 1) — the local catalog row for one
// Meta message-template (name, language) variant. This is the DB layer
// only: submitting to Meta and reacting to Meta's webhook status
// events are Phase 6 (see `src/app/api/whatsapp/templates/submit/
// route.ts` and `src/lib/whatsapp/template-webhook.ts`, which this
// module's `upsert`/`updateStatusByMetaId` are modeled after). Every
// function is built on `accountQuery`/`accountMutation` (never the raw
// `query`/`mutation`) — the same isolation model `contacts.ts` uses.
// ============================================================

/**
 * Loads a template and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — same error for "doesn't exist" and "exists
 * but isn't yours" on purpose (mirrors `contacts.ts`'s
 * `requireOwnContact`), so a cross-account probe can't distinguish the
 * two.
 */
async function requireOwnTemplate(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  templateId: Id<"messageTemplates">,
) {
  const template = await ctx.db.get(templateId);
  if (!template || template.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "messageTemplate" });
  }
  return template;
}

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("messageTemplates")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .collect();
  },
});

export const get = accountQuery({
  args: { templateId: v.id("messageTemplates") },
  handler: async (ctx, args) => {
    return await requireOwnTemplate(ctx, args.templateId);
  },
});

const categoryValidator = v.union(
  v.literal("Marketing"),
  v.literal("Utility"),
  v.literal("Authentication"),
);

const statusValidator = v.union(
  v.literal("DRAFT"),
  v.literal("PENDING"),
  v.literal("APPROVED"),
  v.literal("REJECTED"),
  v.literal("PAUSED"),
  v.literal("DISABLED"),
  v.literal("IN_APPEAL"),
  v.literal("PENDING_DELETION"),
);

/**
 * Finds-or-creates a template keyed by (accountId, name, language) via
 * `by_account_name_lang`, then patches or inserts the rest of the
 * payload. Every field beyond `name`/`language` is patched only when
 * the caller actually supplies it (the `...rest` spread over an
 * omitted `v.optional(...)` arg carries no key at all, so `ctx.db
 * .patch` leaves that column untouched) — the same "patch only what's
 * provided" idiom `contacts.update`/`deals.update` already use, rather
 * than a full-row replace that would silently null out fields the
 * caller didn't mean to touch.
 */
export const upsert = accountMutation({
  args: {
    name: v.string(),
    language: v.string(),
    category: categoryValidator,
    bodyText: v.string(),
    headerType: v.optional(
      v.union(
        v.literal("text"),
        v.literal("image"),
        v.literal("video"),
        v.literal("document"),
      ),
    ),
    headerContent: v.optional(v.string()),
    headerMediaUrl: v.optional(v.string()),
    headerHandle: v.optional(v.string()),
    footerText: v.optional(v.string()),
    buttons: v.optional(v.any()),
    sampleValues: v.optional(
      v.object({
        body: v.optional(v.array(v.string())),
        header: v.optional(v.array(v.string())),
      }),
    ),
    status: v.optional(statusValidator),
    metaTemplateId: v.optional(v.string()),
    submissionError: v.optional(v.string()),
    lastSubmittedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const { name, language, ...rest } = args;

    const existing = await ctx.db
      .query("messageTemplates")
      .withIndex("by_account_name_lang", (q) =>
        q.eq("accountId", ctx.accountId).eq("name", name).eq("language", language),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...rest, updatedAt: Date.now() });
      return existing._id;
    }

    return await ctx.db.insert("messageTemplates", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      name,
      language,
      ...rest,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Patches the status (+ rejectionReason, + clears submissionError) on
 * the account's own template matching `metaTemplateId`.
 *
 * `by_meta_template_id` is NOT account-scoped (Meta ids are globally
 * unique per WABA in practice — see schema.ts's comment on this
 * index), so this deliberately does not `.first()` off the index: it
 * collects every row sharing that id and picks the one (if any)
 * belonging to `ctx.accountId`. That is the whole point of this
 * function's own cross-account test — two different accounts sharing
 * the same `metaTemplateId` is a contrived scenario in practice, but
 * this must still never patch the wrong tenant's row.
 *
 * `rejectionReason` is unconditionally set-or-cleared alongside
 * `status` (mirrors `handleStatusUpdate` in
 * `src/lib/whatsapp/template-webhook.ts`, which always overwrites it —
 * `null` on any non-REJECTED status — rather than leaving a stale
 * reason behind after a later approval). `qualityScore` is the
 * opposite: it comes from a wholly separate Meta webhook field
 * (`message_template_quality_update`) that fires independently of
 * status changes, so it's only patched when the caller actually
 * supplies one — omitting it here must never clobber a previously
 * recorded quality score.
 */
export const updateStatusByMetaId = accountMutation({
  args: {
    metaTemplateId: v.string(),
    status: statusValidator,
    rejectionReason: v.optional(v.string()),
    qualityScore: v.optional(
      v.union(v.literal("GREEN"), v.literal("YELLOW"), v.literal("RED")),
    ),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");

    const candidates = await ctx.db
      .query("messageTemplates")
      .withIndex("by_meta_template_id", (q) =>
        q.eq("metaTemplateId", args.metaTemplateId),
      )
      .collect();
    const template = candidates.find((row) => row.accountId === ctx.accountId);
    if (!template) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "messageTemplate" });
    }

    await ctx.db.patch(template._id, {
      status: args.status,
      rejectionReason: args.rejectionReason,
      submissionError: undefined,
      ...(args.qualityScore !== undefined
        ? { qualityScore: args.qualityScore }
        : {}),
      updatedAt: Date.now(),
    });
    return template._id;
  },
});

export const remove = accountMutation({
  args: { templateId: v.id("messageTemplates") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnTemplate(ctx, args.templateId);
    await ctx.db.delete(args.templateId);
  },
});
