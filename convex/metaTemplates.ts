import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { decrypt } from "./lib/whatsappEncryption";
import {
  submitMessageTemplate,
  listMessageTemplates,
  type MetaTemplateButtonRaw,
  type MetaTemplateComponentRaw,
  type MetaTemplateListItem,
} from "./lib/whatsapp/metaApi";
import {
  buildMetaTemplatePayload,
  type TemplateButtonInput,
} from "./lib/whatsapp/templateComponents";
import { normalizeTemplateStatus } from "./templates";

// ============================================================
// Meta TEMPLATE management (Phase 8, Task 4) — create a message
// template on the WABA (`submitToMeta`) and list every template
// already on the WABA (`syncFromMeta`). A DIFFERENT Graph API surface
// than `convex/metaSend.ts` (`/{waba-id}/message_templates` vs
// `/{phone-number-id}/messages`) — mirrors that file's own "load
// config, decrypt, POST — unless CONVEX_META_DRY_RUN, then a synthetic
// result" shape. Convex port of `src/app/api/whatsapp/templates/
// {submit,sync}/route.ts`.
//
// Both actions here are `internalAction`s: they take a caller-supplied
// `accountId` (no user session) and do nothing but talk to Meta — the
// public, authed wrappers (`templates.submit`/`templates.syncFromMeta`
// in `convex/templates.ts`) derive + role-check the caller's account
// first, then persist the result via `templates.upsertInternal`. This
// module never touches `ctx.db`.
// ============================================================

function isDryRun(): boolean {
  return !!process.env.CONVEX_META_DRY_RUN;
}

/**
 * Synthetic template id used in DRY-RUN mode. Same construction as
 * `metaSend.ts`'s `dryRunWamid` (random hex via Web Crypto, not
 * `crypto.randomUUID`) — see that function's own comment for why.
 */
function dryRunTemplateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `dry-run-${hex}`;
}

/**
 * Load + decrypt the account's WhatsApp config, plus the `wabaId` the
 * send-side `metaSend.ts`'s `loadDecryptedConfig` doesn't need (message
 * templates live on the WABA, not the phone number). Throws the same
 * two messages the Next.js submit/sync routes returned as 400s
 * ("WhatsApp not configured" / "WABA ... ID missing"), for familiarity
 * across the two codebases during the migration.
 */
async function loadWabaConfig(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
): Promise<{ wabaId: string; accessToken: string }> {
  const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
    accountId,
  });
  if (!config) {
    throw new Error("WhatsApp not configured for this account");
  }
  if (!config.wabaId) {
    throw new Error(
      "WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.",
    );
  }
  return {
    wabaId: config.wabaId,
    accessToken: await decrypt(config.accessToken),
  };
}

const categoryValidator = v.union(
  v.literal("Marketing"),
  v.literal("Utility"),
  v.literal("Authentication"),
);
const headerTypeValidator = v.union(
  v.literal("text"),
  v.literal("image"),
  v.literal("video"),
  v.literal("document"),
);

/**
 * Create a new message template on Meta. DRY-RUN
 * (`CONVEX_META_DRY_RUN`) skips the network call entirely and returns
 * a synthetic `dry-run-<hex>` id with status `PENDING` — mirrors the
 * source's own `WHATSAPP_TEMPLATES_DRY_RUN` short-circuit, and is what
 * lets `templates.submit`'s tests (and local dev) exercise the full
 * submit-then-persist flow without a live Meta app.
 */
export const submitToMeta = internalAction({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
    language: v.string(),
    category: categoryValidator,
    bodyText: v.string(),
    headerType: v.optional(headerTypeValidator),
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
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ metaTemplateId: string; status: string; dryRun: boolean }> => {
    if (isDryRun()) {
      return { metaTemplateId: dryRunTemplateId(), status: "PENDING", dryRun: true };
    }

    const { wabaId, accessToken } = await loadWabaConfig(ctx, args.accountId);
    const payload = buildMetaTemplatePayload({
      name: args.name,
      language: args.language,
      category: args.category,
      bodyText: args.bodyText,
      headerType: args.headerType,
      headerContent: args.headerContent,
      headerMediaUrl: args.headerMediaUrl,
      headerHandle: args.headerHandle,
      footerText: args.footerText,
      buttons: args.buttons as TemplateButtonInput[] | undefined,
      sampleValues: args.sampleValues,
    });
    const result = await submitMessageTemplate({ wabaId, accessToken, payload });
    return { metaTemplateId: result.id, status: result.status, dryRun: false };
  },
});

// ============================================================
// syncFromMeta — list every template on the WABA and parse each into
// the shape `templates.upsertInternal` accepts. Port of the sync
// route's per-template transform (`normalizeCategory`, `parseButtons`,
// `extractSampleValues`, `normalizeQualityScore`, header-type
// derivation) — see that route's own comments for the Meta shapes
// being unpacked below.
// ============================================================

export interface ParsedMetaTemplate {
  name: string;
  language: string;
  category: "Marketing" | "Utility" | "Authentication";
  bodyText: string;
  headerType?: "text" | "image" | "video" | "document";
  headerContent?: string;
  headerHandle?: string;
  footerText?: string;
  buttons?: TemplateButtonInput[];
  sampleValues?: { body?: string[]; header?: string[] };
  status: ReturnType<typeof normalizeTemplateStatus>;
  metaTemplateId: string;
  qualityScore?: "GREEN" | "YELLOW" | "RED";
}

function normalizeMetaCategory(
  meta: string,
): "Marketing" | "Utility" | "Authentication" {
  const upper = meta.toUpperCase();
  if (upper === "UTILITY") return "Utility";
  if (upper === "AUTHENTICATION") return "Authentication";
  return "Marketing";
}

function normalizeMetaQualityScore(
  raw: MetaTemplateListItem["quality_score"],
): "GREEN" | "YELLOW" | "RED" | undefined {
  const score =
    typeof raw === "string" ? raw : raw?.score ? String(raw.score) : null;
  if (!score) return undefined;
  const upper = score.toUpperCase();
  return upper === "GREEN" || upper === "YELLOW" || upper === "RED"
    ? (upper as "GREEN" | "YELLOW" | "RED")
    : undefined;
}

function parseMetaButtons(
  metaButtons: MetaTemplateButtonRaw[] | undefined,
): TemplateButtonInput[] {
  if (!metaButtons?.length) return [];
  const out: TemplateButtonInput[] = [];
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case "QUICK_REPLY":
        out.push({ type: "QUICK_REPLY", text: b.text });
        break;
      case "URL":
        out.push({
          type: "URL",
          text: b.text,
          url: b.url ?? "",
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        });
        break;
      case "PHONE_NUMBER":
        out.push({
          type: "PHONE_NUMBER",
          text: b.text,
          phone_number: b.phone_number ?? "",
        });
        break;
      case "COPY_CODE":
        out.push({
          type: "COPY_CODE",
          text: b.text,
          example: Array.isArray(b.example) ? b.example[0] ?? "" : b.example ?? "",
        });
        break;
      // OTP, FLOW, etc — out of scope for v1; drop silently (matches source).
    }
  }
  return out;
}

function extractSampleValues(
  body: MetaTemplateComponentRaw | undefined,
  header: MetaTemplateComponentRaw | undefined,
): { body?: string[]; header?: string[] } | undefined {
  // Meta returns body_text as a 2D array — one row per example set. We
  // take the first row (most templates have exactly one).
  const bodySample = body?.example?.body_text?.[0];
  const headerSample = header?.example?.header_text;
  if (!bodySample?.length && !headerSample?.length) return undefined;
  const sv: { body?: string[]; header?: string[] } = {};
  if (bodySample?.length) sv.body = bodySample;
  if (headerSample?.length) sv.header = headerSample;
  return sv;
}

function parseMetaTemplate(t: MetaTemplateListItem): ParsedMetaTemplate {
  const components = t.components ?? [];
  const body = components.find((c) => c.type === "BODY");
  const header = components.find((c) => c.type === "HEADER");
  const footer = components.find((c) => c.type === "FOOTER");
  const buttonsComponent = components.find((c) => c.type === "BUTTONS");

  const parsedButtons = parseMetaButtons(buttonsComponent?.buttons);
  const sampleValues = extractSampleValues(body, header);

  const headerFormat = header?.format?.toUpperCase();
  const headerType =
    headerFormat === "TEXT" ||
    headerFormat === "IMAGE" ||
    headerFormat === "VIDEO" ||
    headerFormat === "DOCUMENT"
      ? (headerFormat.toLowerCase() as "text" | "image" | "video" | "document")
      : undefined;

  return {
    name: t.name,
    language: t.language,
    category: normalizeMetaCategory(t.category),
    bodyText: body?.text ?? "",
    headerType,
    headerContent: header?.text,
    headerHandle: header?.example?.header_handle?.[0],
    footerText: footer?.text,
    buttons: parsedButtons.length ? parsedButtons : undefined,
    sampleValues,
    status: normalizeTemplateStatus(t.status),
    metaTemplateId: t.id,
    qualityScore: normalizeMetaQualityScore(t.quality_score),
  };
}

/**
 * List every template on the account's WABA and parse each into a row
 * shape `templates.upsertInternal` accepts. DRY-RUN returns an empty
 * list (no whatsappConfig row required) so `templates.syncFromMeta`'s
 * tests (and local dev) can exercise the full sync-then-persist flow
 * without a live Meta app.
 */
export const syncFromMeta = internalAction({
  args: { accountId: v.id("accounts") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    templates: ParsedMetaTemplate[];
    truncated: boolean;
    dryRun: boolean;
  }> => {
    if (isDryRun()) {
      return { templates: [], truncated: false, dryRun: true };
    }

    const { wabaId, accessToken } = await loadWabaConfig(ctx, args.accountId);
    const { templates, truncated } = await listMessageTemplates({
      wabaId,
      accessToken,
    });
    return { templates: templates.map(parseMetaTemplate), truncated, dryRun: false };
  },
});
