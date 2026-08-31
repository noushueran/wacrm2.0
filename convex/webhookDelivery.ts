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
//
//     The literal-IP half is checked by PARSING, not by matching the
//     textual form: `isPrivateOrReservedIpv6` expands the address into
//     its eight groups first. An earlier version prefix-matched strings
//     and carried a `::ffff:<dotted-quad>` regex, which never fired —
//     `new URL()` normalizes `[::ffff:127.0.0.1]` to the hex form
//     `[::ffff:7f00:1]`, so loopback and cloud-metadata addresses passed
//     the guard. All three IPv4-embedding forms (IPv4-mapped,
//     IPv4-compatible, NAT64) now resolve to their embedded IPv4 and are
//     judged by the IPv4 rules, independent of spelling; an IPv6-shaped
//     host that will not parse fails CLOSED. See the `BLOCKED_URLS`
//     regression table in webhookDelivery.test.ts.
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
 * True for a literal loopback/private/link-local/reserved IPv4 address.
 * Pure string/number logic, no I/O.
 */
function isPrivateOrReservedIpv4(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
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

/**
 * Expand a (possibly `::`-compressed) IPv6 literal into its eight
 * 16-bit groups, or `null` if `ip` is not syntactically valid IPv6.
 *
 * Exists because the previous prefix-matching approach (`startsWith`
 * on the textual form, plus a `::ffff:<dotted-quad>` regex) could not
 * see an IPv4-mapped address in the form the platform actually hands
 * us. `new URL("http://[::ffff:127.0.0.1]/").hostname` normalizes to
 * `[::ffff:7f00:1]` — the HEX form — so the dotted-quad regex never
 * matched and loopback/metadata addresses sailed through the guard.
 * Parsing into groups makes the embedded-IPv4 check independent of
 * which textual spelling arrived.
 *
 * A trailing dotted-quad (`::ffff:1.2.3.4`) is folded into the final
 * two groups, per RFC 4291 §2.2.
 */
function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (text.includes("%")) text = text.slice(0, text.indexOf("%")); // zone id

  // Fold a trailing dotted-quad into two 16-bit groups.
  const tail = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (tail) {
    const octets = tail[1]!.split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = text.slice(0, tail.index) + `${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null; // at most one `::`

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0]!);
  if (!head) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const rest = parseGroups(halves[1]!);
  if (!rest) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null; // `::` must stand for at least one group
  return [...head, ...Array<number>(fill).fill(0), ...rest];
}

/**
 * True for a literal loopback/private/link-local/reserved IPv6 address,
 * INCLUDING the IPv4-embedding forms that carry a private IPv4 payload
 * (IPv4-mapped `::ffff:a.b.c.d`, IPv4-compatible `::a.b.c.d`, and NAT64
 * `64:ff9b::/96`) — each of which reaches the embedded IPv4 target on a
 * dual-stack host.
 *
 * Fails CLOSED: a colon-bearing host that will not parse as IPv6 is
 * treated as reserved rather than waved through, since we cannot reason
 * about where it would actually connect.
 */
function isPrivateOrReservedIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return true; // unparseable → fail closed

  const embeddedV4 = (): string =>
    `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;

  const allZero = (upTo: number) => g.slice(0, upTo).every((x) => x === 0);
  const zeroBetween = (from: number, to: number) =>
    g.slice(from, to).every((x) => x === 0);

  // ::/128 unspecified and ::1/128 loopback.
  if (allZero(7) && (g[7] === 0 || g[7] === 1)) return true;
  // fe80::/10 link-local.
  if ((g[0]! & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique-local.
  if ((g[0]! & 0xfe00) === 0xfc00) return true;
  // ::ffff:a.b.c.d — IPv4-mapped.
  if (allZero(5) && g[5] === 0xffff) return isPrivateOrReservedIpv4(embeddedV4());
  // ::a.b.c.d — deprecated IPv4-compatible (the all-zero prefix cases
  // above already returned, so anything left here embeds a real IPv4).
  if (allZero(6)) return isPrivateOrReservedIpv4(embeddedV4());
  // 64:ff9b::/96 — NAT64 well-known prefix.
  if (g[0] === 0x64 && g[1] === 0xff9b && zeroBetween(2, 6)) {
    return isPrivateOrReservedIpv4(embeddedV4());
  }
  return false;
}

/**
 * True for a literal loopback/private/link-local/reserved IPv4 or IPv6
 * address. Pure string/number logic, no I/O, fully portable.
 */
function isPrivateOrReservedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) {
    return isPrivateOrReservedIpv4(bare);
  }
  return isPrivateOrReservedIpv6(bare);
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
