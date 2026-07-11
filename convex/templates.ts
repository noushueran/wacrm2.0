import { accountMutation, accountQuery } from "./lib/auth";
import { internalMutation, internalQuery, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { hasMinRole } from "./lib/roles";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";

// ============================================================
// Message templates (Phase 4, Task 1) — the local catalog row for one
// Meta message-template (name, language) variant. This is the DB layer
// only: submitting to Meta and reacting to Meta's webhook status
// events are Phase 6 (see `src/app/api/whatsapp/templates/submit/
// route.ts` and `src/lib/whatsapp/template-webhook.ts`, which this
// module's `upsert`/`updateStatusByMetaId` are modeled after). Every
// query/mutation is built on `accountQuery`/`accountMutation` (never
// the raw `query`/`mutation`) — the same isolation model `contacts.ts`
// uses. `submit`/`syncFromMeta` at the bottom (Phase 8, Task 4) are the
// one exception — they're plain, authed `action`s (see their own doc
// comment for why), mirroring `send.ts`/`reactions.ts`'s `reactToMeta`.
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
 * Fields shared by `upsert` (public, `ctx.accountId`) and
 * `upsertInternal` (server-only, explicit `accountId` — see that
 * function's own doc comment for why it exists). `qualityScore` isn't
 * one of `upsert`'s own args (only Meta's sync list/webhook ever
 * populate it — `updateStatusByMetaId` below is the other place that
 * patches it) but lives here since `upsertTemplateRow` is the one
 * place both callers' fields funnel through.
 */
interface UpsertTemplateFields {
  name: string;
  language: string;
  category: "Marketing" | "Utility" | "Authentication";
  bodyText: string;
  headerType?: "text" | "image" | "video" | "document";
  headerContent?: string;
  headerMediaUrl?: string;
  headerHandle?: string;
  footerText?: string;
  buttons?: unknown;
  sampleValues?: { body?: string[]; header?: string[] };
  status?: "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED" | "IN_APPEAL" | "PENDING_DELETION";
  metaTemplateId?: string;
  submissionError?: string;
  lastSubmittedAt?: number;
  qualityScore?: "GREEN" | "YELLOW" | "RED";
}

/**
 * Finds-or-creates a template keyed by (accountId, name, language) via
 * `by_account_name_lang`, then patches or inserts the rest of the
 * payload. Every field beyond `name`/`language` is patched only when
 * the caller actually supplies it (the `...rest` spread over an
 * omitted field carries no key at all, so `ctx.db.patch` leaves that
 * column untouched) — the same "patch only what's provided" idiom
 * `contacts.update`/`deals.update` already use, rather than a full-row
 * replace that would silently null out fields the caller didn't mean
 * to touch. Shared by `upsert` and `upsertInternal` below so the
 * find-or-create logic itself lives in exactly one place.
 */
async function upsertTemplateRow(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  createdByUserId: Id<"users"> | undefined,
  args: UpsertTemplateFields,
): Promise<{ templateId: Id<"messageTemplates">; created: boolean }> {
  const { name, language, ...rest } = args;

  const existing = await ctx.db
    .query("messageTemplates")
    .withIndex("by_account_name_lang", (q) =>
      q.eq("accountId", accountId).eq("name", name).eq("language", language),
    )
    .first();

  if (existing) {
    await ctx.db.patch(existing._id, { ...rest, updatedAt: Date.now() });
    return { templateId: existing._id, created: false };
  }

  const templateId = await ctx.db.insert("messageTemplates", {
    accountId,
    createdByUserId,
    name,
    language,
    ...rest,
    updatedAt: Date.now(),
  });
  return { templateId, created: true };
}

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
    ctx.requireRole("supervisor");
    const { templateId } = await upsertTemplateRow(
      ctx,
      ctx.accountId,
      ctx.userId,
      args,
    );
    return templateId;
  },
});

/**
 * Server-only counterpart to `upsert`, for `convex/metaTemplates.ts`'s
 * submit/sync flow (Phase 8, Task 4) — same find-or-create via
 * `upsertTemplateRow`, but keyed on a caller-supplied `accountId`/
 * `userId` instead of `ctx.accountId`/`ctx.userId`, since the calling
 * action (`submit`/`syncFromMeta` below) has already derived + role-
 * checked the account itself before an action's `ctx.runMutation`
 * ever reaches here (mirrors `messages.appendInternal` vs the public
 * `messages.append` — see that pair's own comment). Adds
 * `qualityScore`, which `upsert`'s own args don't carry.
 */
export const upsertInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    userId: v.optional(v.id("users")),
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
    qualityScore: v.optional(
      v.union(v.literal("GREEN"), v.literal("YELLOW"), v.literal("RED")),
    ),
  },
  handler: async (ctx, args) => {
    const { accountId, userId, ...rest } = args;
    return await upsertTemplateRow(ctx, accountId, userId, rest);
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
    ctx.requireRole("supervisor");

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
    ctx.requireRole("supervisor");
    await requireOwnTemplate(ctx, args.templateId);
    await ctx.db.delete(args.templateId);
  },
});

type TemplateStatus = NonNullable<Doc<"messageTemplates">["status"]>;

const TEMPLATE_STATUS_VALUES: ReadonlySet<string> = new Set([
  "DRAFT",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PAUSED",
  "DISABLED",
  "IN_APPEAL",
  "PENDING_DELETION",
]);

/**
 * Normalizes a raw Meta template-lifecycle event string into
 * `messageTemplates.status`'s own enum. Convex port of
 * `src/lib/whatsapp/template-status-normalize.ts`'s `normalizeStatus`:
 * Meta's Cloud API sometimes sends `PENDING_REVIEW` where the docs say
 * `PENDING` — mapped through explicitly; anything else unrecognised
 * falls back to `PENDING` so the row stays visible rather than silently
 * dropped. Exported for direct unit testing, mirroring
 * `template-status-normalize.test.ts`'s own dedicated coverage of the
 * source function.
 */
export function normalizeTemplateStatus(raw: string): TemplateStatus {
  const upper = (raw ?? "").toUpperCase();
  if (upper === "PENDING_REVIEW") return "PENDING";
  return TEMPLATE_STATUS_VALUES.has(upper) ? (upper as TemplateStatus) : "PENDING";
}

/**
 * Meta template-lifecycle webhook handler (Phase 8, Task 4) — Convex
 * port of `src/lib/whatsapp/template-webhook.ts`'s `handleStatusUpdate`
 * (the `message_template_status_update` branch only; DETECTING that
 * field — as opposed to the sibling quality/components fields — is the
 * caller/httpAction's job, the same division of labor
 * `isTemplateWebhookField`/`handleTemplateWebhookChange` have in the
 * source).
 *
 * `by_meta_template_id` is NOT account-scoped (schema.ts's own comment
 * on this index) and this handler has no session/account to filter by
 * either — a webhook-triggered dispatch, exactly like every other
 * internal handler in this phase. Mirrors the source's own
 * account-agnostic behavior exactly (rather than `updateStatusByMetaId`'s
 * `ctx.accountId` filter, which only applies when there IS a session):
 * EVERY row sharing `metaTemplateId` gets patched (0..N), with a
 * `console.warn` if more than one matched ("investigate"), same as the
 * source. `rejectionReason` is unconditionally set-or-cleared alongside
 * `status` (cleared — `undefined` — on any non-REJECTED status, exactly
 * like the source clears it to `null`) and `submissionError` is always
 * cleared too, matching `handleStatusUpdate`'s own update object
 * byte-for-byte.
 */
export const applyMetaStatusWebhook = internalMutation({
  args: {
    metaTemplateId: v.string(),
    event: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const status = normalizeTemplateStatus(args.event);

    const candidates = await ctx.db
      .query("messageTemplates")
      .withIndex("by_meta_template_id", (q) =>
        q.eq("metaTemplateId", args.metaTemplateId),
      )
      .collect();

    if (candidates.length === 0) {
      console.warn(
        "[template-webhook] status update received for unknown template:",
        args.metaTemplateId,
      );
      return;
    }
    if (candidates.length > 1) {
      console.warn(
        `[template-webhook] status update matched ${candidates.length} rows for meta_template_id ${args.metaTemplateId} — investigate.`,
      );
    }

    for (const template of candidates) {
      await ctx.db.patch(template._id, {
        status,
        rejectionReason:
          status === "REJECTED" ? args.reason ?? "Rejected by Meta" : undefined,
        submissionError: undefined,
        updatedAt: Date.now(),
      });
    }
  },
});

// ============================================================
// submit / syncFromMeta — authed PUBLIC actions (Phase 8, Task 4)
// wrapping `convex/metaTemplates.ts`'s internalActions with the same
// three things `send.ts`/`reactions.ts`'s `reactToMeta` add on top of a
// plain `action` (which, unlike `accountQuery`/`accountMutation`, gets
// none of this for free):
//   1. deriving the caller's account + role from their session
//      (`getAuthUserId` + `internal.accounts.accountContextForUser`,
//      since an action has no `ctx.db` to run `lib/auth.ts`'s own
//      membership lookup inline);
//   2. role-gating at "agent" — the same floor `upsert`/`remove` above
//      already enforce;
//   3. persisting the Meta result via `upsertInternal` above (an
//      action can't call `ctx.db` directly, only `ctx.runMutation`).
//
// Both are the Convex counterpart to `src/app/api/whatsapp/templates/
// {submit,sync}/route.ts` — see `convex/metaTemplates.ts`'s own header
// for the Meta-call/DRY-RUN half of this port.
// ============================================================

const submitArgs = {
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
};

/**
 * Submit a new template to Meta for approval and persist it locally.
 * Auth + role → reject `category: "Authentication"` (not supported
 * here — same message the source route gave) → `metaTemplates
 * .submitToMeta` (Meta POST, or a DRY-RUN synthetic result) →
 * `upsertInternal` with the returned status + metaTemplateId.
 *
 * Mirrors the source submit route's two failure-recovery paths:
 *   - Meta itself rejects the submission → the attempt is persisted as
 *     a DRAFT with `submissionError` set (so it's visible + editable),
 *     then the Meta error message is rethrown.
 *   - Meta accepts it but the local `upsertInternal` write fails → a
 *     data-drift state; the thrown message names the `metaTemplateId`
 *     Meta already assigned so the user can recover via
 *     `syncFromMeta` below, exactly like the source route's own note.
 */
export const submit = action({
  args: submitArgs,
  handler: async (
    ctx,
    args,
  ): Promise<{
    templateId: Id<"messageTemplates">;
    metaTemplateId: string;
    status: TemplateStatus;
    dryRun: boolean;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });

    const context = await ctx.runQuery(internal.accounts.accountContextForUser, {
      userId,
    });
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "supervisor")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "supervisor" });
    }
    const { accountId } = context;

    // AUTHENTICATION templates aren't supported here yet — same guard
    // the source's submit route enforced; create them in Meta WhatsApp
    // Manager and pull them in via "Sync from Meta" instead.
    if (args.category === "Authentication") {
      throw new Error(
        'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
      );
    }

    const templateFields = {
      name: args.name,
      language: args.language,
      category: args.category,
      bodyText: args.bodyText,
      headerType: args.headerType,
      headerContent: args.headerContent,
      headerMediaUrl: args.headerMediaUrl,
      headerHandle: args.headerHandle,
      footerText: args.footerText,
      buttons: args.buttons,
      sampleValues: args.sampleValues,
    };

    let meta: { metaTemplateId: string; status: string; dryRun: boolean };
    try {
      meta = await ctx.runAction(internal.metaTemplates.submitToMeta, {
        accountId,
        ...templateFields,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Meta submit failed.";
      // Persist the failed attempt so the user can retry; row stays
      // DRAFT until they fix and re-submit — mirrors the source route's
      // own catch block.
      await ctx.runMutation(internal.templates.upsertInternal, {
        accountId,
        userId,
        ...templateFields,
        status: "DRAFT",
        submissionError: message,
        lastSubmittedAt: Date.now(),
      });
      throw new Error(message);
    }

    const status = normalizeTemplateStatus(meta.status);
    try {
      const { templateId } = await ctx.runMutation(internal.templates.upsertInternal, {
        accountId,
        userId,
        ...templateFields,
        status,
        metaTemplateId: meta.metaTemplateId,
        lastSubmittedAt: Date.now(),
      });
      return { templateId, metaTemplateId: meta.metaTemplateId, status, dryRun: meta.dryRun };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save locally.";
      throw new Error(
        `Submitted to Meta but failed to save locally: ${message}. Run "Sync from Meta" to recover. (meta_template_id: ${meta.metaTemplateId})`,
      );
    }
  },
});

// ============================================================
// editSubmit — authed PUBLIC action (template-EDIT task), the Convex
// counterpart to `src/app/api/whatsapp/templates/[id]/route.ts`'s PATCH
// handler, wrapping `convex/metaTemplates.ts`'s `editOnMeta`
// internalAction. Unlike `submit` above (role floor "agent"), this
// requires "admin" — editing a template already live/reviewed on Meta
// (and capped at 10 edits/30 days, 1/24h while APPROVED) is a bigger
// blast-radius operation than drafting a brand-new one.
// ============================================================

const EDITABLE_STATUSES: ReadonlySet<string> = new Set([
  "APPROVED",
  "REJECTED",
  "PAUSED",
]);

/**
 * Server-only, id-scoped fetch with no identity/role check of its own
 * (the calling action already resolved + is about to compare its own
 * `accountId`) — used by `editSubmit` to load the target template's
 * current `metaTemplateId`/`status` before deciding whether an edit is
 * even allowed. Mirrors `upsertInternal`'s own "internal, no auth,
 * caller already checked" convention.
 */
export const getInternal = internalQuery({
  args: { templateId: v.id("messageTemplates") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.templateId);
  },
});

/**
 * Server-only, id-scoped patch for `editSubmit`'s Meta-failure path —
 * mirrors the source PATCH route's own catch block, which touches ONLY
 * `submission_error`/`last_submitted_at` and deliberately leaves every
 * other column (the template's still-live approved content) untouched —
 * unlike `upsertInternal`'s find-or-create (used by the CREATE flow,
 * where no prior content exists to protect).
 */
export const applyEditFailureInternal = internalMutation({
  args: {
    templateId: v.id("messageTemplates"),
    submissionError: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.templateId, {
      submissionError: args.submissionError,
      lastSubmittedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Server-only, id-scoped patch for `editSubmit`'s Meta-success path.
 * Patches the exact row already resolved by id — not a find-or-create
 * by (accountId, name, language) like `upsertInternal`, since an edit's
 * target row is already known and name/language never change on edit
 * (mirrors the source route's own update object, which never touches
 * those two columns either). Flips `status` to PENDING and
 * unconditionally clears `submissionError`/`rejectionReason` —
 * hardcoded here rather than threaded through as args, so the clear
 * always happens regardless of what the caller passes (same defensive
 * "hardcode the reset" approach `applyMetaStatusWebhook` above uses).
 */
export const applyEditSuccessInternal = internalMutation({
  args: {
    templateId: v.id("messageTemplates"),
    category: categoryValidator,
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
    bodyText: v.string(),
    footerText: v.optional(v.string()),
    buttons: v.optional(v.any()),
    sampleValues: v.optional(
      v.object({
        body: v.optional(v.array(v.string())),
        header: v.optional(v.array(v.string())),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { templateId, ...rest } = args;
    await ctx.db.patch(templateId, {
      ...rest,
      status: "PENDING",
      submissionError: undefined,
      rejectionReason: undefined,
      lastSubmittedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Edit an existing APPROVED/REJECTED/PAUSED template on Meta
 * (edit-by-hsm_id — a different Graph call than `submit`'s create) and
 * persist the result locally. Auth + "admin" role → load the target row
 * and assert the caller's own account owns it → the same three
 * preflight guards the source PATCH route enforced (meta_template_id
 * must already be set; status must be one of `EDITABLE_STATUSES`;
 * category can't be Authentication) → `metaTemplates.editOnMeta` (Meta
 * POST, or a DRY-RUN synthetic success) → patch the local row.
 *
 * Mirrors the source route's two failure-recovery paths:
 *   - Meta rejects the edit → only `submissionError`/`lastSubmittedAt`
 *     are patched (the template's still-live approved content is left
 *     alone), then the Meta error message is rethrown.
 *   - Meta accepts it → the local row is patched with the edited
 *     content, `status: "PENDING"` (Meta re-reviews every edit), and
 *     `submissionError`/`rejectionReason` cleared.
 */
export const editSubmit = action({
  args: { templateId: v.id("messageTemplates"), ...submitArgs },
  handler: async (
    ctx,
    args,
  ): Promise<{
    templateId: Id<"messageTemplates">;
    status: TemplateStatus;
    dryRun: boolean;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });

    const context = await ctx.runQuery(internal.accounts.accountContextForUser, {
      userId,
    });
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "supervisor")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "supervisor" });
    }
    const { accountId } = context;

    const template = await ctx.runQuery(internal.templates.getInternal, {
      templateId: args.templateId,
    });
    if (!template || template.accountId !== accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "messageTemplate" });
    }
    if (!template.metaTemplateId) {
      throw new Error(
        'This template was never submitted to Meta — use New Template to submit it instead.',
      );
    }
    if (!template.status || !EDITABLE_STATUSES.has(template.status)) {
      throw new Error(
        `Templates in status ${template.status ?? "DRAFT"} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED.`,
      );
    }
    if (args.category === "Authentication") {
      throw new Error(
        'AUTHENTICATION templates are not editable here — manage them in Meta WhatsApp Manager.',
      );
    }

    const templateFields = {
      category: args.category,
      headerType: args.headerType,
      headerContent: args.headerContent,
      headerMediaUrl: args.headerMediaUrl,
      headerHandle: args.headerHandle,
      bodyText: args.bodyText,
      footerText: args.footerText,
      buttons: args.buttons,
      sampleValues: args.sampleValues,
    };

    let meta: { dryRun: boolean };
    try {
      meta = await ctx.runAction(internal.metaTemplates.editOnMeta, {
        accountId,
        metaTemplateId: template.metaTemplateId,
        name: args.name,
        language: args.language,
        ...templateFields,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Meta edit failed.";
      await ctx.runMutation(internal.templates.applyEditFailureInternal, {
        templateId: args.templateId,
        submissionError: message,
      });
      throw new Error(message);
    }

    await ctx.runMutation(internal.templates.applyEditSuccessInternal, {
      templateId: args.templateId,
      ...templateFields,
    });

    return { templateId: args.templateId, status: "PENDING", dryRun: meta.dryRun };
  },
});

/**
 * Pull every template on the account's WABA and upsert each locally.
 * Auth + role → `metaTemplates.syncFromMeta` (Meta GET, or a DRY-RUN
 * empty list) → `upsertInternal` per template, tallying inserted vs.
 * updated. A single template's persist failure is collected into
 * `errors` rather than aborting the whole sync — matches the source
 * sync route's own per-template error collection (one bad row
 * shouldn't block the rest of the account's templates from syncing).
 */
export const syncFromMeta = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    total: number;
    inserted: number;
    updated: number;
    errors: { name: string; language: string; message: string }[];
    truncated: boolean;
    dryRun: boolean;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });

    const context = await ctx.runQuery(internal.accounts.accountContextForUser, {
      userId,
    });
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "supervisor")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "supervisor" });
    }
    const { accountId } = context;

    const { templates, truncated, dryRun } = await ctx.runAction(
      internal.metaTemplates.syncFromMeta,
      { accountId },
    );

    let inserted = 0;
    let updated = 0;
    const errors: { name: string; language: string; message: string }[] = [];

    for (const tpl of templates) {
      try {
        const { created } = await ctx.runMutation(internal.templates.upsertInternal, {
          accountId,
          userId,
          ...tpl,
        });
        if (created) inserted++;
        else updated++;
      } catch (err) {
        errors.push({
          name: tpl.name,
          language: tpl.language,
          message: err instanceof Error ? err.message : "Failed to save locally.",
        });
      }
    }

    return { total: templates.length, inserted, updated, errors, truncated, dryRun };
  },
});
