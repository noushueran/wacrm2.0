import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Custom fields — the account-wide field *catalogue* (supervisor-gated
// create/rename/remove; any member can read, mirroring Postgres's own
// `custom_fields_select` policy, which had no role floor) plus the
// per-contact *values* attached to it (agent-gated write, matching
// `contact_custom_values_modify`'s `is_account_member(..., 'agent')`).
// Built on `accountQuery`/`accountMutation` (never the raw
// `query`/`mutation`), mirroring `contacts.ts`/`deals.ts`:
// `ctx.accountId` always comes from the caller's own `memberships`
// row, never a client-supplied argument. Every write re-checks the
// target row's own `accountId` before mutating it, and `setForContact`
// additionally re-checks every referenced `customFieldId` — defense-
// in-depth that doesn't rely solely on "the index we queried by
// happened to be account-scoped" (same philosophy as `deals.ts`'s
// pipeline/stage cross-checks).
// ============================================================

/**
 * Loads a custom field and throws `NOT_FOUND` unless it belongs to
 * the caller's own account — the same error for "doesn't exist" and
 * "exists but isn't yours" on purpose (mirrors `contacts.ts`'s
 * `requireOwnContact`), so a cross-account probe can't distinguish the
 * two.
 */
async function requireOwnCustomField(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  fieldId: Id<"customFields">,
) {
  const field = await ctx.db.get(fieldId);
  if (!field || field.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "customField" });
  }
  return field;
}

/**
 * Loads a contact and throws `NOT_FOUND` unless it belongs to the
 * caller's own account. Duplicated from `contacts.ts` (private there)
 * — same one-helper-per-file style as `deals.ts`/`messages.ts`.
 */
async function requireOwnContact(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  contactId: Id<"contacts">,
) {
  const contact = await ctx.db.get(contactId);
  if (!contact || contact.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
  }
  return contact;
}

/**
 * Case-insensitive `fieldName` clash within the caller's account —
 * mirrors `CustomFieldsPanel.isDuplicate` (`src/components/contacts/
 * custom-fields-manager.tsx`), which was previously enforced only as a
 * client-side UX nicety (Postgres's own `custom_fields.field_name` had
 * no UNIQUE constraint). `exceptFieldId` lets `rename` exclude the
 * field being renamed from colliding with itself.
 */
async function findDuplicateFieldName(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  fieldName: string,
  exceptFieldId?: Id<"customFields">,
) {
  const all = await ctx.db
    .query("customFields")
    .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
    .collect();
  const lower = fieldName.toLowerCase();
  return all.find(
    (field) =>
      field._id !== exceptFieldId && field.fieldName.toLowerCase() === lower,
  );
}

const FIELD_OPTIONS = v.object({ options: v.array(v.string()) });

/** Validates one value string against a field's declared type. Throws
 *  INVALID_VALUE on mismatch. Empty strings are the caller's concern
 *  (setForContact skips them before calling this). */
function assertValidFieldValue(
  field: { _id: Id<"customFields">; fieldType: string; fieldOptions?: unknown },
  value: string,
) {
  const bad = () =>
    new ConvexError({ code: "INVALID_VALUE", customFieldId: field._id });
  const opts =
    (field.fieldOptions as { options?: string[] } | undefined)?.options ?? [];
  switch (field.fieldType) {
    case "number":
      if (!Number.isFinite(Number(value))) throw bad();
      return;
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
        throw bad();
      return;
    case "select":
      if (!opts.includes(value)) throw bad();
      return;
    case "multiselect": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw bad();
      }
      if (!Array.isArray(parsed) || parsed.some((x) => !opts.includes(x as string)))
        throw bad();
      return;
    }
    default:
      return; // "text" and any legacy freeform type
  }
}

// ============================================================
// Field catalogue (supervisor)
// ============================================================

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    // No index sorts by `fieldName` (schema.ts only gives `customFields`
    // a `by_account` index), so the account-scoped page is collected
    // then sorted in memory — mirrors `CustomFieldsPanel.fetchFields`'s
    // `.order('field_name')`. Custom-field catalogues are small
    // (account settings, not high-volume data), so this never needs
    // pagination.
    const fields = await ctx.db
      .query("customFields")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    return fields.sort((a, b) => a.fieldName.localeCompare(b.fieldName));
  },
});

export const create = accountMutation({
  args: {
    fieldName: v.string(),
    fieldType: v.string(),
    fieldOptions: v.optional(FIELD_OPTIONS),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");

    const dup = await findDuplicateFieldName(ctx, args.fieldName);
    if (dup) {
      throw new ConvexError({ code: "DUPLICATE_FIELD", fieldId: dup._id });
    }

    return await ctx.db.insert("customFields", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      fieldName: args.fieldName,
      fieldType: args.fieldType,
      fieldOptions: args.fieldOptions,
    });
  },
});

export const rename = accountMutation({
  args: { fieldId: v.id("customFields"), fieldName: v.string() },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    await requireOwnCustomField(ctx, args.fieldId);

    // Re-check the invariant `create` establishes — without this, two
    // fields could end up sharing a name by renaming one to match the
    // other (mirrors `CustomFieldsPanel.handleRename`'s own
    // `isDuplicate(name, field.id)` guard).
    const dup = await findDuplicateFieldName(ctx, args.fieldName, args.fieldId);
    if (dup) {
      throw new ConvexError({ code: "DUPLICATE_FIELD", fieldId: dup._id });
    }

    await ctx.db.patch(args.fieldId, { fieldName: args.fieldName });
    return args.fieldId;
  },
});

export const update = accountMutation({
  args: {
    fieldId: v.id("customFields"),
    fieldType: v.optional(v.string()),
    fieldOptions: v.optional(FIELD_OPTIONS),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    await requireOwnCustomField(ctx, args.fieldId);
    const patch: Record<string, unknown> = {};
    if (args.fieldType !== undefined) patch.fieldType = args.fieldType;
    if (args.fieldOptions !== undefined) patch.fieldOptions = args.fieldOptions;
    await ctx.db.patch(args.fieldId, patch);
    return args.fieldId;
  },
});

export const remove = accountMutation({
  args: { fieldId: v.id("customFields") },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    await requireOwnCustomField(ctx, args.fieldId);

    // Explicit cascade: Postgres had `contact_custom_values.custom_
    // field_id ... REFERENCES custom_fields(id) ON DELETE CASCADE`;
    // Convex has no ON DELETE, so every value row referencing this
    // field is deleted first (same pattern as `contacts.remove`'s
    // explicit `contactTags` cascade). Ranged on `by_account_field`
    // rather than scanning the account's `by_account` range and
    // filtering down to this field: `.filter()` applies after the index
    // scan, so the old form read every custom value in the account
    // (contacts × fields) to delete one field's. `requireOwnCustomField`
    // above already proves `fieldId` is this account's own, so every
    // matching row is guaranteed to belong to it too.
    const values = await ctx.db
      .query("contactCustomValues")
      .withIndex("by_account_field", (q) =>
        q.eq("accountId", ctx.accountId).eq("customFieldId", args.fieldId),
      )
      .collect();
    for (const value of values) {
      await ctx.db.delete(value._id);
    }

    await ctx.db.delete(args.fieldId);
  },
});

// ============================================================
// Per-contact values (agent)
// ============================================================

export const getForContact = accountQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    await requireOwnContact(ctx, args.contactId);
    return await ctx.db
      .query("contactCustomValues")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();
  },
});

export const setForContact = accountMutation({
  args: {
    contactId: v.id("contacts"),
    values: v.array(
      v.object({
        customFieldId: v.id("customFields"),
        value: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnContact(ctx, args.contactId);

    // Last-value-wins if the caller supplies the same customFieldId
    // more than once — the array has no built-in uniqueness guarantee
    // the way the UI's `Record<string, string>` state does (see
    // `ContactDetailView`'s `customValues` state).
    const byField = new Map<Id<"customFields">, string>();
    for (const { customFieldId, value } of args.values) {
      byField.set(customFieldId, value);
    }

    // Every referenced field must belong to this account too — a
    // client could otherwise smuggle in another account's real
    // customFieldId (defense-in-depth, same reasoning as `deals.create`'s
    // pipeline/stage cross-checks).
    for (const customFieldId of byField.keys()) {
      await requireOwnCustomField(ctx, customFieldId);
    }

    // Replace-all: delete every existing value row for this contact,
    // then insert fresh rows for the non-empty values supplied —
    // mirrors `ContactDetailView.saveCustomFields`'s delete-then-
    // reinsert (`.delete().eq('contact_id', contactId)` followed by a
    // filtered re-insert).
    const existing = await ctx.db
      .query("contactCustomValues")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }

    for (const [customFieldId, value] of byField) {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const field = await ctx.db.get(customFieldId);
      if (field) assertValidFieldValue(field, trimmed);
      await ctx.db.insert("contactCustomValues", {
        accountId: ctx.accountId,
        contactId: args.contactId,
        customFieldId,
        value: trimmed,
      });
    }
  },
});
