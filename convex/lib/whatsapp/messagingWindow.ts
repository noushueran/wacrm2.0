// Pure resolver for Meta's two WhatsApp messaging windows. Dependency-
// free (no Convex, no React) so it is unit-testable and callable from
// any layer — same convention as `./webhookParse.ts`.
//
// THE TWO CLOCKS ARE INDEPENDENT AND DO DIFFERENT JOBS:
//
//   24h customer service window  → governs message TYPE.
//        Resets on every inbound customer message. While open, free-form
//        (non-template) messages may be sent; while closed, templates only.
//
//   72h free entry point window  → governs COST.
//        Opened when the business replies to a Click-to-WhatsApp / Page-CTA
//        lead within 24h. While open, EVERY message is free — including
//        marketing and authentication templates that are otherwise billed.
//
// Conflating them is the bug class this module exists to prevent: a
// conversation can be template-only AND free at the same time.

/** Meta's customer service window: 24 hours. */
export const CSW_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Meta's free entry point window: 72 hours. */
export const FEP_WINDOW_MS = 72 * 60 * 60 * 1000;

export type CostReason = "fep" | "customer_service_window" | "billed";
export type FepSource = "meta" | "estimated" | "none";

export interface CostEntry {
  free: boolean;
  reason: CostReason;
}

export interface ResolveWindowInput {
  now: number;
  /** `conversations.lastInboundAt` — last CUSTOMER message. */
  lastInboundAt?: number;
  /** `conversations.metaWindow` — Meta's authoritative record. */
  metaWindow?: { expiresAt?: number; isFreeEntryPoint: boolean };
  /** `conversations.adReferral.startedAt` — the ad click. */
  adReferralStartedAt?: number;
  /** `conversations.firstReplyAt` — first outbound after the ad click. */
  firstReplyAt?: number;
}

export interface WindowState {
  csw: { open: boolean; expiresAt?: number; remainingMs: number };
  fep: {
    open: boolean;
    expiresAt?: number;
    remainingMs: number;
    source: FepSource;
  };
  /** Free-form (non-template) messages are permitted. Always `csw.open`. */
  canSendFreeForm: boolean;
  /** Cost per message kind. A DATA MAP, not a boolean: in quadrant 3
   *  free-form and utility are free while marketing and authentication
   *  are billed, which no single flag can express. */
  cost: {
    freeForm: CostEntry;
    templateUtility: CostEntry;
    templateMarketing: CostEntry;
    templateAuthentication: CostEntry;
  };
  confidence: "authoritative" | "estimated";
}

const BILLED: CostEntry = { free: false, reason: "billed" };

export function resolveWindowState(input: ResolveWindowInput): WindowState {
  const { now, lastInboundAt, metaWindow, adReferralStartedAt, firstReplyAt } =
    input;

  // ---- 24h customer service window
  const cswExpiresAt =
    lastInboundAt !== undefined ? lastInboundAt + CSW_WINDOW_MS : undefined;
  const cswRemaining =
    cswExpiresAt !== undefined ? Math.max(0, cswExpiresAt - now) : 0;
  const cswOpen = cswRemaining > 0;

  // ---- 72h free entry point window: Meta first, estimate only in the gap
  let fepExpiresAt: number | undefined;
  let fepSource: FepSource = "none";

  if (metaWindow?.isFreeEntryPoint && metaWindow.expiresAt !== undefined) {
    fepExpiresAt = metaWindow.expiresAt;
    fepSource = "meta";
  } else if (adReferralStartedAt !== undefined && firstReplyAt !== undefined) {
    // Meta opens the window only if the business replied within 24h of
    // the ad click. No reply in time ⇒ no free window, ever. Meta
    // anchors on the reply being DELIVERED; we anchor on sent, which is
    // typically seconds earlier and is superseded the moment the status
    // webhook lands.
    if (firstReplyAt - adReferralStartedAt < CSW_WINDOW_MS) {
      fepExpiresAt = firstReplyAt + FEP_WINDOW_MS;
      fepSource = "estimated";
    }
  }

  const fepRemaining =
    fepExpiresAt !== undefined ? Math.max(0, fepExpiresAt - now) : 0;
  const fepOpen = fepRemaining > 0;

  // ---- cost, in precedence order
  let cost: WindowState["cost"];
  if (fepOpen) {
    const free: CostEntry = { free: true, reason: "fep" };
    cost = {
      freeForm: free,
      templateUtility: free,
      templateMarketing: free,
      templateAuthentication: free,
    };
  } else if (cswOpen) {
    const free: CostEntry = { free: true, reason: "customer_service_window" };
    cost = {
      freeForm: free,
      templateUtility: free,
      templateMarketing: BILLED,
      templateAuthentication: BILLED,
    };
  } else {
    cost = {
      freeForm: BILLED,
      templateUtility: BILLED,
      templateMarketing: BILLED,
      templateAuthentication: BILLED,
    };
  }

  return {
    csw: { open: cswOpen, expiresAt: cswExpiresAt, remainingMs: cswRemaining },
    fep: {
      open: fepOpen,
      expiresAt: fepExpiresAt,
      remainingMs: fepRemaining,
      source: fepSource,
    },
    canSendFreeForm: cswOpen,
    cost,
    confidence: fepSource === "estimated" ? "estimated" : "authoritative",
  };
}
