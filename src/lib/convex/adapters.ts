import { ConvexError } from "convex/values";
import type { Doc } from "../../../convex/_generated/dataModel";
import type {
  Contact,
  ContactCustomValue,
  ContactNote,
  CustomField,
  Tag,
} from "@/types";

// ============================================================
// Shape-mapping adapters — Convex docs (camelCase, `_id`/`_creationTime`)
// -> the app's existing snake_case UI types (`src/types/index.ts`,
// `id`/`created_at`). Applied at the `useQuery`/`useMutation` boundary so
// component internals + `src/types` stay unchanged. Mirrors the
// convention `src/hooks/use-auth.tsx` established for Task 1
// (ternary-on-doc-presence, field-by-field rename) — see that file's
// `profile`/`account` construction for the original pattern.
//
// Every function here is a plain rename + `_creationTime` -> ISO string
// conversion; none of them fetch or mutate anything themselves.
//
// Legacy single-owner-era columns (`user_id` on Contact/Tag/CustomField/
// ContactNote) predate the accounts model and have no Convex equivalent
// (the Convex tables only carry an optional `createdByUserId`, and
// `tags` has no creator field at all). Mapped to `createdByUserId ?? ""`
// (or `""` for tags) rather than leaving the UI type's required `string`
// field unsatisfied — nothing in the contacts UI currently reads
// `Contact.user_id`/`Tag.user_id`/etc. for anything but display, and none
// of it displays these legacy fields.
// ============================================================

/** Convex has no `updatedAt` field on `contacts` yet — `Contact.updated_at`
 *  is required on the UI type, so it's backfilled from `_creationTime`
 *  until a real column exists. Every write path in this vertical updates
 *  reactively anyway, so no UI currently depends on this value changing
 *  independently of `created_at`. */
export function toUiTag(doc: Doc<"tags">): Tag {
  return {
    id: doc._id,
    user_id: "",
    name: doc.name,
    color: doc.color,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

export function toUiContact(
  doc: Doc<"contacts"> & { tags?: Doc<"tags">[] },
): Contact {
  const createdAt = new Date(doc._creationTime).toISOString();
  return {
    id: doc._id,
    user_id: doc.createdByUserId ?? "",
    account_id: doc.accountId,
    phone: doc.phone,
    phone_normalized: doc.phoneNormalized,
    name: doc.name,
    email: doc.email,
    company: doc.company,
    avatar_url: doc.avatarUrl,
    created_at: createdAt,
    updated_at: createdAt,
    tags: doc.tags ? doc.tags.map(toUiTag) : undefined,
  };
}

export function toUiCustomField(doc: Doc<"customFields">): CustomField {
  return {
    id: doc._id,
    user_id: doc.createdByUserId ?? "",
    account_id: doc.accountId,
    field_name: doc.fieldName,
    field_type: doc.fieldType,
    field_options: doc.fieldOptions as Record<string, unknown> | undefined,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

export function toUiContactCustomValue(
  doc: Doc<"contactCustomValues">,
): ContactCustomValue {
  return {
    id: doc._id,
    contact_id: doc.contactId,
    custom_field_id: doc.customFieldId,
    value: doc.value,
  };
}

export function toUiContactNote(doc: Doc<"contactNotes">): ContactNote {
  return {
    id: doc._id,
    contact_id: doc.contactId,
    user_id: doc.createdByUserId ?? "",
    note_text: doc.noteText,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}

// ============================================================
// ConvexError helpers — every account-scoped mutation in this codebase
// throws `new ConvexError({ code: "X", ...extra })`, so `.data` is a
// plain object (never a string) for all of contacts/tags/customFields/
// contactNotes. This consolidates the `errorMessage`/`isXError` pattern
// previously copy-pasted across `convex-demo/page.tsx`,
// `(auth)/login/page.tsx`, and `(auth)/signup/page.tsx` into one shared
// helper for the contacts vertical (and any later vertical that wants
// it) — those three call sites are untouched (out of scope here).
// ============================================================

/** The `{ code, ...extra }` payload of a ConvexError thrown by this
 *  codebase's account-scoped functions, or undefined for anything else
 *  (a plain Error, a network failure, or a string-data ConvexError like
 *  `convex/auth.ts`'s password-length check). */
export function convexErrorData(
  err: unknown,
): Record<string, unknown> | undefined {
  if (
    err instanceof ConvexError &&
    typeof err.data === "object" &&
    err.data !== null
  ) {
    return err.data as Record<string, unknown>;
  }
  return undefined;
}

/** True when `err` is a ConvexError whose `.data.code` matches `code`
 *  (e.g. `isConvexErrorCode(err, "DUPLICATE_PHONE")`). */
export function isConvexErrorCode(err: unknown, code: string): boolean {
  return convexErrorData(err)?.code === code;
}

/** Human-readable fallback for a caught error — same shape as the
 *  `errorMessage` helper in `convex-demo/page.tsx`/the auth pages. */
export function convexErrorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    return typeof err.data === "string" ? err.data : JSON.stringify(err.data);
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
