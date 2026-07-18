// Phase 6: interpret an agent's WhatsApp reply to a lead offer. Pure and
// deliberately conservative — anything ambiguous is "other" (the offer
// stays open until the timeout), because mis-reading "yes we spoke
// yesterday" as an accept would silently assign a lead.

const ACCEPT = new Set([
  "yes", "y", "yes!", "yep", "yeah", "ok", "okay", "sure", "accept",
  "accepted", "ready", "take", "taking", "i'll take it", "ill take it",
  "👍", "✅", "done",
]);
const DECLINE = new Set([
  "no", "n", "no!", "nope", "pass", "busy", "later", "can't", "cant",
  "cannot", "not now", "skip", "decline", "❌", "🚫",
]);

export function parseStaffReply(text: string): "accept" | "decline" | "other" {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 40) return "other"; // long messages are conversation, not consent
  if (ACCEPT.has(t)) return "accept";
  if (DECLINE.has(t)) return "decline";
  const first = t.split(/\s+/)[0]?.replace(/[.,!]+$/, "");
  if (ACCEPT.has(first)) return "accept";
  if (DECLINE.has(first)) return "decline";
  return "other";
}
