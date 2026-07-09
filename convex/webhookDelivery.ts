import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// ============================================================
// Outbound webhook delivery (Phase 6, Task 2) — Convex counterpart to
// `src/lib/webhooks/deliver.ts`'s `dispatchWebhookEvent`. Same contract:
// best-effort, NEVER throws, at-most-one-attempt-per-endpoint per call,
// and the exact `X-Wacrm-Signature` wire format
// (`t=<unix_seconds>,v1=<hex HMAC-SHA256>` over `${t}.${rawBody}`, see
// `src/lib/webhooks/sign.ts`) so a receiver validates identically
// regardless of which side delivered.
//
// Deliberately NOT `"use node"` + `node:crypto`/`node:dns`/`node:net`
// (what the original literally imports) — this codebase's own
// `convex/**/*.test.ts` project runs under the `edge-runtime` vitest
// environment (see vitest.config.ts), a Web-standard-only VM with NO
// Node built-ins reachable at all, including inside a "use node" file:
// `convex-test` calls every handler directly in that one JS
// environment — it does not spin up a real Node subprocess for "use
// node" functions the way an actual Convex deployment does. The same
// restriction holds in a REAL (non-"use node") Convex action too: its
// runtime only exposes Web-standard globals, same as every other
// `convex/lib/*.ts` crypto port already documents (`apiKey.ts`,
// `inviteToken.ts`, `whatsappEncryption.ts`).
//
//   - HMAC signing: Web Crypto (`crypto.subtle.importKey` + `.sign`)
//     produces byte-for-byte the same hex digest Node's
//     `createHmac('sha256', ...)` does for the same key/message — same
//     reasoning those three files give for SHA-256/AES.
//   - Per-delivery `id`: hand-rolled UUIDv4 via `crypto.getRandomValues`
//     rather than `crypto.randomUUID()`, matching `metaSend.ts`'s own
//     stated convention of not assuming `randomUUID` over the more
//     conservatively-supported Web Crypto primitive.
//   - SSRF guard: a REDUCED-FIDELITY port of `ssrf.ts`'s
//     `isDeliverableUrl`. That function's core defense is a
//     `node:dns/promises` `lookup()` call, and there is no Web-standard
//     hostname-resolution API — a plain Convex action cannot resolve a
//     hostname to an IP at all, full stop, not just under test. What
//     IS ported and fully portable: rejecting a literal private/
//     loopback/link-local/reserved IP address, and rejecting the same
//     obviously-internal hostname suffixes (`localhost`, `*.local`,
//     `*.internal`) the original fast-paths on before ever calling
//     `lookup()`. A public-looking HOSTNAME that actually resolves to a
//     private address (the deeper case the original's own header
//     comment already flags as a documented residual risk for DNS
//     rebinding) is a residual gap here too — now for a structural
//     runtime reason, not just a rebinding-timing one. `redirect:
//     'manual'` is kept, so a public URL still can't 3xx-bounce to an
//     internal one.
// ============================================================

/** Per-endpoint HTTP timeout. Mirrors `deliver.ts`'s own constant. */
export const DELIVERY_TIMEOUT_MS = 5000;

/** Auto-disable an endpoint after this many consecutive failures. */
export const MAX_CONSECUTIVE_FAILURES = 15;

const HEX_CHARS = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX_CHARS[byte >> 4] + HEX_CHARS[byte & 0x0f];
  }
  return out;
}

/**
 * Hand-rolled UUIDv4 (RFC 4122 §4.4 version/variant bits set over 16
 * CSPRNG bytes) — see this file's header for why not
 * `crypto.randomUUID()`. Only needs to be unique + UUID-*shaped* for
 * receiver-side dedup, same contract as the original's `randomUUID()`.
 */
function randomUuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * True for a literal loopback/private/link-local/reserved IPv4 or IPv6
 * address — ported verbatim from `ssrf.ts`'s `isPrivateOrReservedIp`
 * (pure string/number logic, no I/O, fully portable).
 */
function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::1" || v6 === "::") return true; // loopback / unspecified
  if (
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb")
  )
    return true; // fe80::/10 link-local
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // fc00::/7 ULA
  const mapped = v6.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateOrReservedIp(mapped[1]!); // IPv4-mapped
  return false;
}

/** True if `host` is a literal IPv4 or IPv6 address (not a hostname). */
function isLiteralIp(host: string): boolean {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return host.includes(":"); // bracketed IPv6 hostnames always contain ':'
}

/**
 * Reduced-fidelity port of `ssrf.ts`'s `isDeliverableUrl` — see this
 * file's header comment for exactly what's preserved vs. what can't be
 * (real DNS resolution) in Convex's action runtime. Synchronous (the
 * original is async only because of the `dns.lookup` call this version
 * can't make).
 *
 * Exported (Phase 6, Task 3): the automations engine's `send_webhook`
 * step POSTs to an arbitrary, per-step-configured URL — a different
 * feature from this file's own `dispatch` (which fans out to the
 * account's *registered* `webhookEndpoints`), so it doesn't call
 * `dispatch` itself, but it needs the exact same SSRF guard before
 * making its own outbound `fetch`. Reused here rather than
 * copy-pasted, to avoid two copies of a security-critical check
 * drifting apart.
 */
export function isDeliverableUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (!host) return false;

  if (isLiteralIp(host)) return !isPrivateOrReservedIp(host);

  const lower = host.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  ) {
    return false;
  }

  return true;
}

/**
 * `X-Wacrm-Signature` header value — Web Crypto port of `sign.ts`'s
 * `buildSignatureHeader`. Same scheme: HMAC-SHA256 over
 * `${timestampSeconds}.${rawBody}`, hex-encoded.
 */
async function buildSignatureHeader(
  rawBody: string,
  secret: string,
  timestampSeconds: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestampSeconds}.${rawBody}`),
  );
  return `t=${timestampSeconds},v1=${bytesToHex(new Uint8Array(signature))}`;
}

function isDryRun(): boolean {
  return !!process.env.CONVEX_META_DRY_RUN;
}

/**
 * Deliver `event` (+ `payload`) to every ACTIVE endpoint of `accountId`
 * subscribed to it. Never throws — callers (the webhook route's
 * `after()` block, and Task 3's `send_webhook` automation step) must
 * never have their own outcome affected by a delivery problem.
 */
export const dispatch = internalAction({
  args: {
    accountId: v.id("accounts"),
    event: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const endpoints = await ctx.runQuery(
        internal.webhookEndpoints.listActiveForEvent,
        { accountId: args.accountId, event: args.event },
      );
      if (endpoints.length === 0) return;

      // Sign the exact bytes sent so a receiver can recompute the HMAC
      // over the raw request body. `id` is a per-delivery uuid the
      // receiver can dedupe on (deliveries are at-least-once and may
      // repeat / arrive out of order) — same envelope shape as
      // `deliver.ts`'s own payload, including its snake_case keys,
      // since this is a cross-side wire format.
      const body = JSON.stringify({
        id: randomUuidV4(),
        event: args.event,
        occurred_at: new Date().toISOString(),
        account_id: args.accountId,
        data: args.payload,
      });
      const tsSeconds = Math.floor(Date.now() / 1000);

      await Promise.allSettled(
        endpoints.map((endpoint) =>
          deliverOne(ctx, endpoint, args.event, body, tsSeconds),
        ),
      );
    } catch (err) {
      // Never let a delivery problem bubble into the caller.
      console.error("[webhooks] dispatch failed:", err);
    }
  },
});

async function deliverOne(
  ctx: ActionCtx,
  endpoint: Doc<"webhookEndpoints">,
  event: string,
  body: string,
  tsSeconds: number,
): Promise<void> {
  // SSRF guard — see this file's header for what this does and doesn't
  // catch in this runtime. Counts as a failure so a misconfigured
  // internal URL surfaces and eventually auto-disables, same as the
  // original.
  if (!isDeliverableUrl(endpoint.url)) {
    console.warn(
      "[webhooks] refusing non-public delivery target for",
      endpoint._id,
    );
    await recordFailure(ctx, endpoint._id);
    return;
  }

  // DRY-RUN: skip the real network call entirely (test/dev mode, same
  // env var `metaSend.ts` reads), but still run the success bookkeeping
  // a real delivery would — this is what lets `webhookDelivery.test.ts`
  // assert on endpoint selection + bookkeeping without a live receiver.
  if (isDryRun()) {
    await recordSuccess(ctx, endpoint._id);
    return;
  }

  try {
    const signature = await buildSignatureHeader(
      body,
      endpoint.secret,
      tsSeconds,
    );
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Wacrm-Event": event,
        "X-Wacrm-Webhook-Id": endpoint._id,
        "X-Wacrm-Signature": signature,
      },
      body,
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, bypassing the SSRF check above.
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`endpoint responded ${res.status}`);

    await recordSuccess(ctx, endpoint._id);
  } catch (err) {
    console.warn(
      `[webhooks] delivery to ${endpoint._id} failed:`,
      err instanceof Error ? err.message : err,
    );
    await recordFailure(ctx, endpoint._id);
  }
}

async function recordSuccess(
  ctx: ActionCtx,
  endpointId: Id<"webhookEndpoints">,
): Promise<void> {
  // `await` (rather than `return`-ing the call directly) so this
  // function's own return type is `Promise<void>` — `ctx.runMutation`
  // resolves to `Promise<null>` for a mutation with no explicit return
  // (Convex serializes an `undefined` handler return as `null` over the
  // wire), which isn't assignable to `void` on its own.
  await ctx.runMutation(internal.webhookEndpoints.recordDeliverySuccess, {
    endpointId,
  });
}

async function recordFailure(
  ctx: ActionCtx,
  endpointId: Id<"webhookEndpoints">,
): Promise<void> {
  await ctx.runMutation(internal.webhookEndpoints.recordDeliveryFailure, {
    endpointId,
    maxFailures: MAX_CONSECUTIVE_FAILURES,
  });
}
