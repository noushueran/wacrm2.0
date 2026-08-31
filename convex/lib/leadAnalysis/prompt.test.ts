import { expect, test } from "vitest";
import {
  buildScoreSystemPrompt,
  formatNotesForScoring,
  parseScoreResponse,
  SCORING_NOTES_MAX,
  SIGNAL_VOCABULARY,
  withScoringInstruction,
} from "./prompt";

test("the prompt states the 1-10 range and demands JSON only", () => {
  const p = buildScoreSystemPrompt({ serviceName: null, services: [], contact: {} });
  expect(p).toContain("1");
  expect(p).toContain("10");
  expect(p).toMatch(/JSON/i);
});

test("the prompt lists every allowed signal", () => {
  const p = buildScoreSystemPrompt({ serviceName: null, services: [], contact: {} });
  for (const s of SIGNAL_VOCABULARY) expect(p).toContain(s);
});

test("the prompt includes the matched service and the service catalogue", () => {
  const p = buildScoreSystemPrompt({
    serviceName: "UAE Visa",
    services: ["UAE Visa", "Holiday Packages"],
    contact: {},
  });
  expect(p).toContain("UAE Visa");
  expect(p).toContain("Holiday Packages");
});

test("the prompt includes known contact profile detail", () => {
  const p = buildScoreSystemPrompt({
    serviceName: null,
    services: [],
    contact: { name: "Asha", budget: "AED 3000", travelers: "2 adults" },
  });
  expect(p).toContain("Asha");
  expect(p).toContain("AED 3000");
  expect(p).toContain("2 adults");
});

test("the prompt omits absent profile fields rather than printing empties", () => {
  const p = buildScoreSystemPrompt({ serviceName: null, services: [], contact: {} });
  expect(p).not.toContain("undefined");
  expect(p).not.toContain("null");
});

// Task 9 (P3): unlike `buildSystemPrompt` (the reply bot), this prompt's
// output is a score and reason only an AGENT reads, so the team's own
// notes go in verbatim — no closed-vocabulary summarization.
test("the scoring prompt carries recent agent notes verbatim", () => {
  const prompt = buildScoreSystemPrompt({
    serviceName: null,
    services: [],
    contact: {},
    agentNotes: [
      "2026-08-01 · Alice · phone call: met him at the office, ready to book",
      "2026-08-02 · Alice · follow up: waiting on his passport copy",
    ],
  });
  expect(prompt).toContain("ready to book");
  expect(prompt).toContain("waiting on his passport copy");
});

test("the scoring prompt is unchanged when there are no notes", () => {
  const withoutArg = buildScoreSystemPrompt({ serviceName: null, services: [], contact: {} });
  const withEmpty = buildScoreSystemPrompt({
    serviceName: null,
    services: [],
    contact: {},
    agentNotes: [],
  });
  expect(withEmpty).toBe(withoutArg);
});

test("scoring notes are capped so a chatty thread can't inflate token spend", () => {
  const long = Array.from({ length: 50 }, (_, i) => ({
    _creationTime: 1_000_000 + i,
    noteText: "x".repeat(200),
    kind: "call",
  }));
  const formatted = formatNotesForScoring(long);
  expect(formatted.length).toBeLessThanOrEqual(10);
  expect(formatted.join("\n").length).toBeLessThanOrEqual(1500);
});

test("formatNotesForScoring drops the oldest notes first when over budget", () => {
  // Newest-first input (as `by_contact` + `.order("desc")` would supply),
  // each line short enough that the count cap (not the char cap) never
  // binds — only the oldest, tail-end notes should be dropped.
  const notes = Array.from({ length: 3 }, (_, i) => ({
    _creationTime: 1_000_000 + i,
    noteText: `note-${i}`,
    kind: "general" as const,
  }));
  const formatted = formatNotesForScoring(notes);
  expect(formatted[0]).toContain("note-0");
  expect(formatted[formatted.length - 1]).toContain(`note-${notes.length - 1}`);
});

// MINOR 4 (final review): nothing validates `noteText` length, so a
// single oversized newest note used to blank the entire section — the
// loop's `break` fired on the very first iteration before anything was
// ever pushed, and `formatNotesForScoring` returned `[]`.
test("an oversized NEWEST note is truncated, not dropped — the scoring model still sees it", () => {
  const notes = [
    { _creationTime: 1_000_000, noteText: "y".repeat(2000), kind: "call" as const },
    { _creationTime: 999_000, noteText: "an older, normal-length note", kind: "general" as const },
  ];
  const formatted = formatNotesForScoring(notes);

  // The newest note is represented (truncated), not silently dropped.
  expect(formatted.length).toBeGreaterThanOrEqual(1);
  expect(formatted[0]).toContain("y");
  // The older note has no room left at all — dropped outright, matching
  // "oldest dropped first".
  expect(formatted.some((line) => line.includes("older, normal-length note"))).toBe(false);

  // The joined string a real caller (`buildScoreSystemPrompt`) would
  // send to the model still respects the same 1500-char budget the
  // uncapped-count test above checks.
  expect(formatted.join("\n").length).toBeLessThanOrEqual(1500);
});

test("SCORING_NOTES_MAX is exported so the caller's read cap can share it", () => {
  expect(SCORING_NOTES_MAX).toBe(10);
});

test("parses a clean JSON response", () => {
  const parsed = parseScoreResponse(
    '{"score":8,"reason":"Gave dates and budget","signals":["dates_given","budget_given"]}',
  );
  expect(parsed).toEqual({
    score: 8,
    reason: "Gave dates and budget",
    signals: ["dates_given", "budget_given"],
  });
});

test("parses a response wrapped in a fenced code block", () => {
  const parsed = parseScoreResponse(
    '```json\n{"score":3,"reason":"Just browsing","signals":[]}\n```',
  );
  expect(parsed?.score).toBe(3);
});

test("parses JSON embedded in surrounding prose", () => {
  const parsed = parseScoreResponse(
    'Here is my assessment: {"score":5,"reason":"Unclear","signals":[]} Hope that helps.',
  );
  expect(parsed?.score).toBe(5);
});

test("clamps an out-of-range score instead of rejecting the response", () => {
  expect(parseScoreResponse('{"score":42,"reason":"x","signals":[]}')?.score).toBe(10);
  expect(parseScoreResponse('{"score":0,"reason":"x","signals":[]}')?.score).toBe(1);
});

test("accepts a numeric score delivered as a string", () => {
  expect(parseScoreResponse('{"score":"7","reason":"x","signals":[]}')?.score).toBe(7);
});

test("drops signals outside the vocabulary", () => {
  const parsed = parseScoreResponse(
    '{"score":6,"reason":"x","signals":["budget_given","totally_made_up"]}',
  );
  expect(parsed?.signals).toEqual(["budget_given"]);
});

test("de-duplicates repeated signals", () => {
  const parsed = parseScoreResponse(
    '{"score":6,"reason":"x","signals":["ghosted","ghosted"]}',
  );
  expect(parsed?.signals).toEqual(["ghosted"]);
});

test("tolerates a missing signals array", () => {
  expect(parseScoreResponse('{"score":6,"reason":"x"}')?.signals).toEqual([]);
});

test("truncates an overlong reason", () => {
  const parsed = parseScoreResponse(
    `{"score":6,"reason":"${"x".repeat(500)}","signals":[]}`,
  );
  expect(parsed!.reason.length).toBeLessThanOrEqual(240);
});

test("returns null for unparseable or structurally wrong output", () => {
  expect(parseScoreResponse("I cannot score this conversation.")).toBeNull();
  expect(parseScoreResponse("")).toBeNull();
  expect(parseScoreResponse('{"reason":"no score","signals":[]}')).toBeNull();
  expect(parseScoreResponse('{"score":"high","reason":"x","signals":[]}')).toBeNull();
  expect(parseScoreResponse('{"score":7,"signals":[]}')).toBeNull();
});

test("parses correctly when the reason contains a stray opening brace", () => {
  const parsed = parseScoreResponse(
    '{"score":6,"reason":"cost is {approx","signals":[]}',
  );
  expect(parsed?.score).toBe(6);
});

test("parses correctly when the reason contains a stray closing brace", () => {
  const parsed = parseScoreResponse(
    '{"score":6,"reason":"odd } here","signals":[]}',
  );
  expect(parsed?.score).toBe(6);
});

test("parses correctly when the reason contains a balanced brace pair, and the braces survive into reason", () => {
  const parsed = parseScoreResponse(
    '{"score":6,"reason":"budget is {AED 3000}","signals":[]}',
  );
  expect(parsed?.score).toBe(6);
  expect(parsed?.reason).toBe("budget is {AED 3000}");
});

test("parses correctly when the reason contains an escaped quote", () => {
  const parsed = parseScoreResponse(
    '{"score":6,"reason":"customer said \\"maybe\\"","signals":[]}',
  );
  expect(parsed?.score).toBe(6);
  expect(parsed?.reason).toBe('customer said "maybe"');
});

test("returns null rather than throwing for non-string input", () => {
  expect(parseScoreResponse(42 as unknown as string)).toBeNull();
  expect(parseScoreResponse({ score: 6 } as unknown as string)).toBeNull();
});

// ------------------------------------------------------------------
// Fix 1 (final whole-branch review of Lead Analysis P1): Anthropic's
// Messages API treats a TRAILING assistant turn as a response prefill —
// it continues that message instead of answering the system prompt.
// Every "awaiting them" lead (our reply is the last thing in the
// thread) ends its `chat` array on an assistant turn, so scoring it
// without this guard makes the model keep writing the agent's WhatsApp
// reply instead of returning JSON, `parseScoreResponse` returns null,
// and the row burns its whole attempt budget for nothing.
// ------------------------------------------------------------------
test("withScoringInstruction appends a final user turn when the chat ends on an assistant message", () => {
  const chat = [
    { role: "user" as const, content: "Goa in December, 2 adults" },
    { role: "assistant" as const, content: "Great! Any budget in mind?" },
  ];
  const result = withScoringInstruction(chat);
  expect(result[result.length - 1].role).toBe("user");
  // The original turns are preserved, in order, ahead of the new one.
  expect(result.slice(0, 2)).toEqual(chat);
});

test("withScoringInstruction still appends a user turn when the chat already ends on the customer", () => {
  const chat = [{ role: "user" as const, content: "hello" }];
  const result = withScoringInstruction(chat);
  expect(result[result.length - 1].role).toBe("user");
  expect(result).toHaveLength(2);
});

test("withScoringInstruction never mutates the input array", () => {
  const chat = [{ role: "assistant" as const, content: "Hi there!" }];
  const before = [...chat];
  withScoringInstruction(chat);
  expect(chat).toEqual(before);
});

test("withScoringInstruction handles an empty chat", () => {
  const result = withScoringInstruction([]);
  expect(result).toHaveLength(1);
  expect(result[0].role).toBe("user");
});
