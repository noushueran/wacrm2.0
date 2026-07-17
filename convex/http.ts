import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  flattenInboundMessage,
  isRecipientStatus,
  isTemplateWebhookField,
  parseTemplateStatusUpdate,
  resolveContactName,
  type MetaRecipientStatus,
  type MetaWebhookBody,
  type MetaWebhookChange,
} from "./lib/whatsapp/webhookParse";

const http = httpRouter();

auth.addHttpRoutes(http);

// ============================================================
// WhatsApp webhook (Phase 8, Task 4b) — Convex port of the fan-out half
// of `src/app/api/whatsapp/webhook/route.ts` (its `processWebhook`/
// `handleStatusUpdate`; message-content parsing lives in
// `./lib/whatsapp/webhookParse.ts`, ported separately so it's testable).
//
// Architecture (a deliberate project decision, not this task's own
// call): Meta's webhook URL stays pointed at the Next.js route
// (`src/app/api/whatsapp/webhook/route.ts`), UNCHANGED. That route now
// only verifies Meta's `x-hub-signature-256` HMAC on the raw body (it
// holds `META_APP_SECRET`) and forwards the raw bytes here with a
// shared-secret header — so signature material stays in Next, and the
// parse + engine dispatch lives in Convex where the internal mutations/
// actions/queries actually are. `POST /whatsapp/ingest` below is
// therefore a SECOND trust boundary, not a duplicate of Meta's own: it
// gates on `x-wacrm-proxy-secret` (`WEBHOOK_PROXY_SECRET`, shared with
// the Next route — see that route's own header comment) precisely
// because this endpoint is otherwise a public, unauthenticated Convex
// HTTP route that anyone who knows the deployment's site URL could
// otherwise POST arbitrary "Meta" payloads to.
//
// `GET /whatsapp/webhook` (Meta's verify-token handshake) is gated the
// same way. Meta itself never calls either route directly under this
// architecture — only the Next proxy does, for both GET and POST — so
// gating GET costs nothing and closes off the same public-route
// exposure the POST gate exists for (probing which verify tokens are
// configured would otherwise need no secret at all).
//
// Fast-ack: `value.messages[]` dispatches to `internal.ingest.processInbound`
// (flows -> automations -> AI reply -> webhook delivery) via
// `ctx.scheduler.runAfter(0, ...)` rather than awaiting it directly —
// scheduling returns immediately, so this httpAction's own execution
// time is bounded by the (typically tiny) synchronous work below, not
// by the full fan-out. This is the Convex-native equivalent of the
// source's own `after()` escape hatch. Status/template updates ARE
// awaited inline — they're single-row patches, not a fan-out chain, so
// there's no fast-ack concern for them.
// ============================================================

function checkProxySecret(request: Request): boolean {
  const provided = request.headers.get("x-wacrm-proxy-secret");
  const expected = process.env.WEBHOOK_PROXY_SECRET;
  return !!expected && provided === expected;
}

/**
 * Buckets a `value.statuses[]` batch by wamid, preserving arrival order
 * within each bucket and dropping statuses we don't model (Meta is free to
 * add new ones; an unrecognized one is skipped, and a wamid left with none
 * yields no bucket at all).
 *
 * The grouping is what makes the batch safe to parallelize: both mutations
 * a status drives are read-modify-write against a single row, and
 * `broadcasts.isValidStatusTransition` enforces a
 * pending->sent->delivered->read ladder over that read. Two statuses for the
 * SAME wamid run concurrently would each read the same "before" state, each
 * pass the ladder check, and then race to write — leaving the recipient on
 * whichever landed last. Two statuses for DIFFERENT wamids touch different
 * rows and cannot interfere. Exported for direct unit testing: convex-test
 * runs mutations serially, so an end-to-end test can't reproduce the race
 * this prevents.
 */
export function groupStatusesByWamid(
  statuses: Array<{ id: string; status: string }>,
): Array<[string, MetaRecipientStatus[]]> {
  const groups = new Map<string, MetaRecipientStatus[]>();
  for (const status of statuses) {
    if (!isRecipientStatus(status.status)) {
      console.warn(
        "[webhook httpAction] unrecognized recipient status, skipping:",
        status.status,
      );
      continue;
    }
    const group = groups.get(status.id);
    if (group) group.push(status.status);
    else groups.set(status.id, [status.status]);
  }
  return [...groups];
}

/**
 * One `entry[].changes[]` element. Wrapped in its own try/catch by the
 * caller so one malformed/failing change can't abandon the rest of the
 * batch (mirrors this codebase's `runBestEffort` philosophy elsewhere —
 * see `convex/ingest.ts`).
 */
async function processChange(
  ctx: ActionCtx,
  change: MetaWebhookChange,
): Promise<void> {
  if (isTemplateWebhookField(change.field)) {
    if (change.field === "message_template_status_update") {
      const parsed = parseTemplateStatusUpdate(change.value);
      if (!parsed) {
        console.warn(
          "[webhook httpAction] template status update missing message_template_id/event:",
          change.value,
        );
        return;
      }
      await ctx.runMutation(internal.templates.applyMetaStatusWebhook, parsed);
      return;
    }
    // message_template_quality_update / message_template_components_update
    // have no corresponding internal mutation yet (see webhookParse.ts's
    // own comment on `parseTemplateStatusUpdate`) — flagged as a
    // follow-up in this task's report rather than mis-routed.
    console.info(
      `[webhook httpAction] ${change.field} received but not yet handled — see task report`,
    );
    return;
  }

  const value = change.value ?? {};
  const phoneNumberId = value.metadata?.phone_number_id;

  let accountId: Id<"accounts"> | null = null;
  if (phoneNumberId) {
    const config = await ctx.runQuery(
      internal.whatsappConfig.accountByPhoneNumberId,
      { phoneNumberId },
    );
    accountId = config?.accountId ?? null;
  }

  if (value.statuses) {
    // 2N sequential mutations on the inline, pre-ack path. The two per
    // status touch different tables and don't gate each other, so they go
    // together; distinct wamids own distinct rows, so those go together
    // too. Same-wamid statuses stay strictly ordered — see
    // `groupStatusesByWamid`.
    await Promise.all(
      groupStatusesByWamid(value.statuses).map(async ([wamid, statuses]) => {
        for (const status of statuses) {
          await Promise.all([
            ctx.runMutation(internal.messages.updateDeliveryStatusByWamid, {
              wamid,
              status,
              accountId: accountId ?? undefined,
            }),
            ctx.runMutation(internal.broadcasts.recordRecipientStatusByWamid, {
              wamid,
              status,
            }),
          ]);
        }
      }),
    );
  }

  if (value.messages) {
    if (!accountId) {
      console.error(
        "[webhook httpAction] no whatsappConfig for phone_number_id, dropping inbound message(s):",
        phoneNumberId,
      );
      return;
    }
    for (let i = 0; i < value.messages.length; i++) {
      const rawMessage = value.messages[i];
      const flattened = flattenInboundMessage(rawMessage);
      // `null` = a reaction (or another not-yet-supported shape) — see
      // webhookParse.ts's own comment on why this skips rather than
      // mis-stores it.
      if (!flattened) continue;
      const name = resolveContactName(value.contacts, i);
      await ctx.scheduler.runAfter(0, internal.ingest.processInbound, {
        accountId,
        from: rawMessage.from,
        name,
        message: flattened,
      });
    }
  }
}

const ingestWebhook = httpAction(async (ctx, request) => {
  if (!checkProxySecret(request)) {
    console.warn(
      "[webhook httpAction] rejected POST /whatsapp/ingest: missing/incorrect x-wacrm-proxy-secret",
    );
    return new Response("Unauthorized", { status: 401 });
  }

  let body: MetaWebhookBody;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      try {
        await processChange(ctx, change);
      } catch (err) {
        console.error("[webhook httpAction] change processing failed:", err);
      }
    }
  }

  return new Response(JSON.stringify({ status: "received" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const verifyWebhook = httpAction(async (ctx, request) => {
  if (!checkProxySecret(request)) {
    console.warn(
      "[webhook httpAction] rejected GET /whatsapp/webhook: missing/incorrect x-wacrm-proxy-secret",
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const challenge = url.searchParams.get("hub.challenge");
  const verifyToken = url.searchParams.get("hub.verify_token");

  if (mode !== "subscribe" || !challenge || !verifyToken) {
    return new Response("Missing verification parameters", { status: 400 });
  }

  const accountId = await ctx.runQuery(internal.whatsappConfig.matchVerifyToken, {
    verifyToken,
  });
  if (!accountId) {
    return new Response("Verification token mismatch", { status: 403 });
  }

  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
});

http.route({ path: "/whatsapp/ingest", method: "POST", handler: ingestWebhook });
http.route({ path: "/whatsapp/webhook", method: "GET", handler: verifyWebhook });

export default http;
