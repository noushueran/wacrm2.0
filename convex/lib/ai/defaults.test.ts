import { afterEach, expect, test, vi } from "vitest";
import {
  aiJudgeModel,
  aiJudgeReasoningEffort,
  aiKnowledgeTopK,
  aiReplyReasoningEffort,
  buildSystemPrompt,
  DEFAULT_JUDGE_MODEL,
  formatDubaiNow,
  maxOutputTokensFor,
  promptCacheKey,
  MAX_OUTPUT_TOKENS,
  supportsReasoningEffort,
} from "./defaults";
import { deriveCustomerState, type CustomerState, type OfflineNoteKind } from "../notes/signals";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("buildSystemPrompt renders the qualification objectives block in auto_reply mode", () => {
  const prompt = buildSystemPrompt({
    userPrompt: "Be friendly.",
    mode: "auto_reply",
    qualification: {
      collected: [{ label: "Destination", value: "Bali" }],
      nextQuestion: "When are you planning to travel?",
    },
  });
  expect(prompt).toContain("Lead qualification objective");
  expect(prompt).toContain("Destination: Bali");
  expect(prompt).toContain("never re-ask");
  expect(prompt).toContain("When are you planning to travel?");
  // The no-repeat rule rides with the block, not with the field lists —
  // the transcript, not extraction, is the record of what was asked.
  expect(prompt).toContain("re-read your own earlier messages");
});

test("buildSystemPrompt surfaces low-confidence answers as confirm-don't-re-ask", () => {
  const prompt = buildSystemPrompt({
    userPrompt: null,
    mode: "auto_reply",
    qualification: {
      collected: [],
      unconfirmed: [{ label: "Visa duration", value: "30 days" }],
      nextQuestion: null,
    },
  });
  expect(prompt).toContain("Visa duration: 30 days");
  expect(prompt).toContain("treat these as ANSWERED");
  // Omitted entirely when there is nothing unconfirmed — the prompt
  // prefix stays byte-identical for the common case.
  expect(
    buildSystemPrompt({
      userPrompt: null,
      mode: "auto_reply",
      qualification: { collected: [], unconfirmed: [], nextQuestion: null },
    }),
  ).not.toContain("treat these as ANSWERED");
});

test("buildSystemPrompt omits the block without the arg, without a next question stays quiet about asking, and never renders it in draft mode", () => {
  expect(
    buildSystemPrompt({ userPrompt: null, mode: "auto_reply" }),
  ).not.toContain("Lead qualification objective");

  const noQuestion = buildSystemPrompt({
    userPrompt: null,
    mode: "auto_reply",
    qualification: { collected: [{ label: "Email", value: "a@b.com" }], nextQuestion: null },
  });
  expect(noQuestion).toContain("Email: a@b.com");
  expect(noQuestion).not.toContain("weave in exactly ONE question");

  expect(
    buildSystemPrompt({
      userPrompt: null,
      mode: "draft",
      qualification: { collected: [], nextQuestion: "Q?" },
    }),
  ).not.toContain("Lead qualification objective");
});

test("auto_reply prompt never teaches a handoff escape — always answer, team follows up, ask-admin for unknowns", () => {
  const auto = buildSystemPrompt({ userPrompt: null, mode: "auto_reply" });
  expect(auto).not.toContain("[[HANDOFF]]");
  expect(auto).toContain("ALWAYS answer");
  expect(auto).toContain("team member will follow up");
  expect(auto).toContain("ASK_ADMIN");
});

test("the prompt teaches honest attachment handling in both modes", () => {
  const auto = buildSystemPrompt({ userPrompt: null, mode: "auto_reply" });
  expect(auto).toContain("[voice note]");
  expect(auto).toContain("never pretend");
  const draft = buildSystemPrompt({ userPrompt: null, mode: "draft" });
  expect(draft).toContain("[voice note]");
});

// The reply-language policy is the second half of the wrong-language
// fix. `media.ts`'s script guard drops a Cyrillic/CJK hallucination, but
// cannot see a LATIN-script one — measured 2026-07-25, silence made
// `gpt-4o-transcribe` emit Polish and German, and the bot (told to
// mirror the customer's language) answered fluently in both.
test("the prompt bounds reply language to what the business serves, with an English fallback", () => {
  for (const mode of ["auto_reply", "draft"] as const) {
    const p = buildSystemPrompt({ userPrompt: null, mode });
    expect(p).toContain("English");
    expect(p).toContain("Malayalam");
    expect(p).toContain("Hindi");
    // The rule the Polish/German cases needed: don't answer in it.
    expect(p).toContain("never reply in that language");
  }
});

test("the served-language list is tunable without a deploy", () => {
  vi.stubEnv("AI_REPLY_LANGUAGES", "English, Malayalam, Swahili");
  const p = buildSystemPrompt({ userPrompt: null, mode: "auto_reply" });
  expect(p).toContain("Swahili");
  expect(p).not.toContain("Tagalog");
});

test("the prompt warns that a transcript is machine-made and may be wrong", () => {
  const p = buildSystemPrompt({ userPrompt: null, mode: "auto_reply" });
  expect(p).toContain("automatic transcript");
  expect(p).toContain("ask them to repeat");
});

test("formatDubaiNow renders GST wall-clock — fixed +4, 12-hour, and the day rolls over with the shift", () => {
  // 21:30 UTC on a Friday is 1:30 AM SATURDAY in Dubai — the +4 shift
  // must roll the weekday and date, not just the hour.
  expect(formatDubaiNow(new Date("2026-07-24T21:30:00Z"))).toBe("Saturday, 25 July 2026, 1:30 AM");
  // Noon boundary: 12 PM, never 0 PM.
  expect(formatDubaiNow(new Date("2026-07-24T08:00:00Z"))).toBe("Friday, 24 July 2026, 12:00 PM");
  // Midnight in Dubai is 12:0x AM, with minutes zero-padded.
  expect(formatDubaiNow(new Date("2026-07-23T20:05:00Z"))).toBe("Friday, 24 July 2026, 12:05 AM");
});

test("buildSystemPrompt stamps Dubai time between business context and knowledge; absent → no trace", () => {
  const prompt = buildSystemPrompt({
    userPrompt: "Be friendly.",
    mode: "auto_reply",
    now: new Date("2026-07-24T10:37:00Z"), // 2:37 PM GST
    knowledge: ["Visa facts."],
  });
  expect(prompt).toContain("Right now it is Friday, 24 July 2026, 2:37 PM Gulf Standard Time");
  // Cache-friendly placement: the frozen scaffold + business context must
  // precede the minute-fresh timestamp, and the per-question knowledge
  // must come after — provider prefix caching reuses bytes only up to
  // the first change.
  expect(prompt.indexOf("Be friendly.")).toBeLessThan(prompt.indexOf("Right now it is"));
  expect(prompt.indexOf("Right now it is")).toBeLessThan(prompt.indexOf("Knowledge base"));
  // Strictly additive: without `now` the prompt carries no timestamp.
  expect(buildSystemPrompt({ userPrompt: null, mode: "auto_reply" })).not.toContain(
    "Right now it is",
  );
});

test("auto_reply prompt teaches the ask-admin protocol instead of handoff-on-unknown; draft does not", () => {
  const auto = buildSystemPrompt({ userPrompt: null, mode: "auto_reply" });
  expect(auto).toContain("ASK_ADMIN");
  expect(auto).toContain("check with");
  const draft = buildSystemPrompt({ userPrompt: null, mode: "draft" });
  expect(draft).not.toContain("ASK_ADMIN");
});

// ------------------------------------------------------------
// Token-spend controls (audit 2026-07-27). The reply prompt is dominated
// by a static prefix and the output budget is shared with reasoning, so
// these four knobs are what the whole optimisation rests on.
// ------------------------------------------------------------

test("reasoning effort defaults to none for both replies and judges, and is env-tunable", () => {
  expect(aiReplyReasoningEffort()).toBe("none");
  expect(aiJudgeReasoningEffort()).toBe("none");

  vi.stubEnv("AI_REPLY_REASONING_EFFORT", "low");
  vi.stubEnv("AI_JUDGE_REASONING_EFFORT", "medium");
  expect(aiReplyReasoningEffort()).toBe("low");
  expect(aiJudgeReasoningEffort()).toBe("medium");
});

test("an unrecognised effort falls back rather than being sent to the provider", () => {
  // A typo'd env var must not become a 400 on every reply.
  vi.stubEnv("AI_REPLY_REASONING_EFFORT", "maximum");
  expect(aiReplyReasoningEffort()).toBe("none");
});

test("the output budget gains reasoning headroom only when the model will reason", () => {
  // The bug this closes: reasoning tokens come out of the SAME budget as
  // the visible reply, so a bare 320 could be spent entirely on thinking
  // and return empty content — billed, retried, and delivered to the
  // customer as the generic fallback.
  expect(maxOutputTokensFor(null)).toBe(MAX_OUTPUT_TOKENS);
  expect(maxOutputTokensFor("none")).toBe(MAX_OUTPUT_TOKENS);
  expect(maxOutputTokensFor("low")).toBeGreaterThan(MAX_OUTPUT_TOKENS);
  expect(maxOutputTokensFor("high")).toBeGreaterThan(MAX_OUTPUT_TOKENS);
});

test("supportsReasoningEffort gates on the model family", () => {
  expect(supportsReasoningEffort("gpt-5.6-terra")).toBe(true);
  expect(supportsReasoningEffort("gpt-5.6-luna")).toBe(true);
  expect(supportsReasoningEffort("o3-mini")).toBe(true);
  expect(supportsReasoningEffort("gpt-4o-mini")).toBe(false);
  // Non-reasoning models inside the gpt-5 namespace 400 on the argument.
  // `aiConfigs.model` is free text, so this guard is the only thing
  // standing between a typo'd model id and every AI call failing.
  expect(supportsReasoningEffort("gpt-5-chat-latest")).toBe(false);
  expect(supportsReasoningEffort("GPT-5-Chat-Latest")).toBe(false);
  // Casing and stray whitespace must not defeat the family gate either.
  expect(supportsReasoningEffort("  GPT-5.6-terra  ")).toBe(true);
});

test("the judge model swaps in for OpenAI only, and is env-overridable", () => {
  // An Anthropic account must keep its configured model — an OpenAI
  // model id would simply 404 against the Messages API.
  expect(aiJudgeModel("anthropic", "claude-haiku-4-5-20251001")).toBe(
    "claude-haiku-4-5-20251001",
  );
  expect(aiJudgeModel("openai", "gpt-5.6-terra")).toBe(DEFAULT_JUDGE_MODEL);

  // Setting it to the account's own model disables the split.
  vi.stubEnv("AI_JUDGE_MODEL", "gpt-5.6-terra");
  expect(aiJudgeModel("openai", "gpt-5.6-terra")).toBe("gpt-5.6-terra");
});

test("knowledge retrieval depth stays at 5 unless the deployment says otherwise", () => {
  expect(aiKnowledgeTopK()).toBe(5);
  vi.stubEnv("AI_KNOWLEDGE_TOP_K", "3");
  expect(aiKnowledgeTopK()).toBe(3);
});

test("the cache key partitions by account AND prompt shape", () => {
  // Same account, different prefixes must NOT share a key: the key routes
  // to a cache shard, so pointing two different prefixes at one just makes
  // them evict each other.
  expect(promptCacheKey("acct1", "reply")).toBe("acct1:reply");
  expect(promptCacheKey("acct1", "score")).not.toBe(promptCacheKey("acct1", "reply"));
  // Different accounts never share — the Business Context is the bulk of
  // the prefix, and it is per account.
  expect(promptCacheKey("acct2", "reply")).not.toBe(promptCacheKey("acct1", "reply"));
  // Stable across calls, or it would never hit.
  expect(promptCacheKey("acct1", "reply")).toBe(promptCacheKey("acct1", "reply"));
});

// ============================================================
// customerState — the notes → prompt bridge
// ============================================================

test("buildSystemPrompt is byte-identical when customerState is omitted", () => {
  const base = buildSystemPrompt({ userPrompt: "Be warm.", mode: "auto_reply" });
  const explicitUndefined = buildSystemPrompt({
    userPrompt: "Be warm.",
    mode: "auto_reply",
    customerState: undefined,
  });
  expect(explicitUndefined).toBe(base);
});

test("buildSystemPrompt renders the off-platform contact and the follow-up flag", () => {
  const prompt = buildSystemPrompt({
    userPrompt: null,
    mode: "auto_reply",
    now: new Date("2026-08-05T10:00:00Z"),
    customerState: {
      lastOfflineContact: { kind: "call", atMs: Date.parse("2026-08-03T09:00:00Z") },
      followUpFlaggedAtMs: Date.parse("2026-08-03T09:00:00Z"),
      markedNotInterested: false,
    },
  });
  expect(prompt).toContain("CUSTOMER STATE");
  expect(prompt.toLowerCase()).toContain("phone call");
  // The model must be told not to surface any of it.
  expect(prompt.toLowerCase()).toMatch(/never mention|do not mention/);
});

test("buildSystemPrompt omits the customer-state block when every signal is empty", () => {
  const prompt = buildSystemPrompt({
    userPrompt: null,
    mode: "auto_reply",
    customerState: {
      lastOfflineContact: null,
      followUpFlaggedAtMs: null,
      markedNotInterested: false,
    },
  });
  // An all-empty state is no information — rendering an empty header
  // would spend tokens on every reply for nothing.
  expect(prompt).not.toContain("CUSTOMER STATE");
});

// ============================================================
// LEAK REGRESSION — this is the test that protects the phase's central
// invariant. If someone later widens CustomerState with a free-text
// field, or pipes noteText into this builder, this must fail.
//
// This exercises the REAL pipeline rather than a hand-written fixture:
// rows shaped like actual `contactNotes` documents (carrying the same
// `noteText` field the schema declares, even though `NoteSignalInput`
// doesn't) go through `deriveCustomerState`, and ONLY that function's
// output goes into `buildSystemPrompt`. If `deriveCustomerState` (or a
// future edit to `CustomerState`) ever let `noteText` survive into the
// distilled state, this test fails. A hand-written `state` object that
// never contained the secret in the first place — the previous version
// of this test — cannot prove that; this one does, because the secret's
// only route into `prompt` is through the real distillation step.
// ============================================================

test("no agent-authored note text can reach the customer-facing prompt", () => {
  const SECRET = "he is a time-waster, quote him double";

  // Rows shaped like real `contactNotes` documents. `noteText` is not
  // part of `NoteSignalInput`'s declared shape — that's deliberate: this
  // is exactly what a raw note row looks like before distillation, and
  // the test proves the extra field cannot survive it. (Assigned to a
  // variable rather than passed as a literal so TypeScript's
  // excess-property check — which only fires on direct object-literal
  // assignment — doesn't get in the way of constructing a realistic,
  // over-shaped row.)
  const rawNotes: Array<{
    _creationTime: number;
    kind: string;
    outcome: string | null;
    noteText: string;
  }> = [
    {
      _creationTime: Date.now(),
      kind: "call",
      outcome: "not_interested",
      noteText: SECRET,
    },
  ];

  const state: CustomerState = deriveCustomerState(rawNotes);
  // Sanity: deriveCustomerState actually picked up the signals we
  // planted, so the assertion below is testing the real thing, not a
  // no-op over an empty state.
  expect(state.lastOfflineContact?.kind).toBe("call");
  expect(state.markedNotInterested).toBe(true);

  const prompt = buildSystemPrompt({
    userPrompt: null,
    mode: "auto_reply",
    customerState: state,
  });

  expect(prompt).not.toContain(SECRET);
});

// ------------------------------------------------------------
// Type-level guard: fails `tsc`, not just the test run, the moment
// `CustomerState` gains a field whose value isn't one of the closed
// shapes below (in particular, any plain `string` — the shape a
// free-text note field would take). Never executed; its only job is to
// make an unsafe widening of `CustomerState` a compile error.
// ------------------------------------------------------------
type AllowedCustomerStateValue =
  | boolean
  | number
  | null
  | { kind: OfflineNoteKind; atMs: number };

type ClosedVocabulary<T> = {
  [K in keyof T]: T[K] extends AllowedCustomerStateValue ? true : false;
};

// Union of every field's true/false verdict. Any `false` in the union
// means some field escaped the closed vocabulary.
type PerFieldVerdict = ClosedVocabulary<CustomerState>[keyof CustomerState];
type AllFieldsClosed = Exclude<PerFieldVerdict, true> extends never ? true : false;

type Assert<T extends true> = T;
// If this line fails to compile, `CustomerState` has a field that is not
// a boolean, a number, null, or `{ kind: OfflineNoteKind; atMs: number }`
// — e.g. someone added `noteText?: string`. That is the bug class this
// whole phase exists to prevent.
type _CustomerStateStaysClosedVocabulary = Assert<AllFieldsClosed>;
