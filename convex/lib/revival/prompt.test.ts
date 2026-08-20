import { expect, test } from "vitest";
import {
  SYNTHETIC_REVIVAL_RAW,
  buildRevivalPrompt,
  parseRevivalDraft,
  sanitizeContactName,
} from "./prompt";

test("the prompt carries the trip detail the message must reference", () => {
  const p = buildRevivalPrompt({
    contactName: "Ravi",
    serviceName: "UAE Visa Services",
    profileLines: ["destination: Dubai", "dates: mid December", "pax: 2 adults"],
    quietHours: 5,
  });
  expect(p).toContain("Ravi");
  expect(p).toContain("UAE Visa Services");
  expect(p).toContain("mid December");
  expect(p).toContain("5");
});

test("the prompt still works when nothing was captured", () => {
  const p = buildRevivalPrompt({
    contactName: null,
    serviceName: null,
    profileLines: [],
    quietHours: 4,
  });
  expect(p).toContain("(not known)");
  expect(p).toContain("nothing captured yet");
});

test("the prompt forbids inventing commercial facts", () => {
  const p = buildRevivalPrompt({
    contactName: null,
    serviceName: null,
    profileLines: [],
    quietHours: 4,
  }).toLowerCase();
  expect(p).toContain("price");
  expect(p).toContain("do not");
});

test("a well-formed reply parses into body, reason, and confidence", () => {
  const parsed = parseRevivalDraft(
    JSON.stringify({
      body: "Hi Ravi, still planning Dubai for December?",
      reason: "Asked about visa timing, went quiet 5h ago",
      confidence: "high",
    }),
  );
  expect(parsed?.body).toContain("Dubai");
  expect(parsed?.reason).toContain("visa");
  expect(parsed?.confidence).toBe("high");
});

test("parsing never throws on junk — it returns null", () => {
  expect(parseRevivalDraft("not json at all")).toBeNull();
  expect(parseRevivalDraft("{}")).toBeNull();
  expect(parseRevivalDraft(JSON.stringify({ body: "   " }))).toBeNull();
  expect(parseRevivalDraft("[1,2,3]")).toBeNull();
  expect(parseRevivalDraft("null")).toBeNull();
});

test("an unknown confidence degrades to low rather than being trusted", () => {
  const parsed = parseRevivalDraft(
    JSON.stringify({ body: "Hello", reason: "r", confidence: "certain" }),
  );
  expect(parsed?.confidence).toBe("low");
});

test("fenced JSON from a chatty model still parses", () => {
  const parsed = parseRevivalDraft(
    '```json\n{"body":"Hi","reason":"r","confidence":"medium"}\n```',
  );
  expect(parsed?.body).toBe("Hi");
  expect(parsed?.confidence).toBe("medium");
});

test("the synthetic draft parses, so dry-run exercises the real path", () => {
  expect(parseRevivalDraft(SYNTHETIC_REVIVAL_RAW)).not.toBeNull();
});

test("emoji and decoration are stripped from a display name", () => {
  // Real production value: a genuine Tamil name wrapped in fire emoji.
  expect(sanitizeContactName("\u0b95\u0ba3\u0bcd\u0ba3\u0baa\u0bcd\u0baa\u0b95\u0bc7\u0bbe\u0ba9\u0bbe\u0bb0\u0bcd \ud83d\udd25\ud83d\udd25\u0ba4\u0bc0\u0bb0\u0ba9\u0bcd"))
    .toBe("\u0b95\u0ba3\u0bcd\u0ba3\u0baa\u0bcd\u0baa\u0b95\u0bc7\u0bbe\u0ba9\u0bbe\u0bb0\u0bcd \u0ba4\u0bc0\u0bb0\u0ba9\u0bcd");
});

test("a name that is nothing but decoration becomes no name at all", () => {
  expect(sanitizeContactName("\ud83d\udd25\ud83d\udd25")).toBeNull();
  expect(sanitizeContactName("   ")).toBeNull();
  expect(sanitizeContactName("")).toBeNull();
  expect(sanitizeContactName(null)).toBeNull();
  // One surviving character is decoration, not an address.
  expect(sanitizeContactName("A \ud83d\ude0a")).toBeNull();
});

test("ordinary names survive untouched, in any script", () => {
  expect(sanitizeContactName("Ravi")).toBe("Ravi");
  expect(sanitizeContactName("Dr Sanjay Paithankar")).toBe("Dr Sanjay Paithankar");
  // Not our job to decide this is not a person — the prompt handles that.
  expect(sanitizeContactName("Alhamdulillah")).toBe("Alhamdulillah");
});

test("the prompt warns that the profile name may not be a person", () => {
  const p = buildRevivalPrompt({
    contactName: "Alhamdulillah",
    serviceName: null,
    profileLines: [],
    quietHours: 5,
  });
  expect(p).toContain("WhatsApp profile name");
  expect(p).toContain("ONLY");
  expect(p.toLowerCase()).toContain("shop name");
});

test("an unusable name is reported as unknown, not as the word null", () => {
  const p = buildRevivalPrompt({
    contactName: "\ud83d\udd25",
    serviceName: null,
    profileLines: [],
    quietHours: 5,
  });
  expect(p).toContain("(not known)");
  expect(p).not.toContain("null");
});
