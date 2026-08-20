/// <reference types="vite/client" />
import { expect, test } from "vitest";
import { buildClassifyPrompt } from "./ai/classify";
import { buildChecklistPrompt } from "./salesChecklist";
import { buildScoreSystemPrompt } from "./leadAnalysis/prompt";
import { buildRevivalPrompt } from "./revival/prompt";
import { buildSystemPrompt } from "./ai/defaults";

// ============================================================
// The ordering guarantee, asserted against the REAL builders rather
// than only against the helper.
//
// Every structured agent ends its prompt with an output-format contract.
// Business prose placed after that line reads as the newest, most
// specific instruction and invites the model to abandon the format,
// which silently breaks parsing. A unit test on `withExtraInstructions`
// proves the helper does the right thing; these prove each builder
// actually calls it, and calls it the right way round.
// ============================================================

const EXTRA = "ZZBUSINESSMARKERZZ";

const CASES: Array<{ agent: string; build: (extra: string | null) => string; contract: string }> = [
  {
    agent: "tags",
    build: (e) => buildClassifyPrompt({ groups: [] }, e),
    contract: "Reply with ONLY a JSON object",
  },
  {
    agent: "checklist",
    build: (e) =>
      buildChecklistPrompt({ excerpts: ["step one"], serviceName: null, extraInstructions: e }),
    contract: "Reply with ONLY a JSON array",
  },
  {
    agent: "score",
    build: (e) =>
      buildScoreSystemPrompt(
        { serviceName: null, services: [], contact: {} },
        e,
      ),
    contract: "Reply with JSON ONLY",
  },
  {
    agent: "revival",
    build: (e) =>
      buildRevivalPrompt({
        contactName: "Ravi",
        serviceName: null,
        profileLines: [],
        quietHours: 5,
        extraInstructions: e,
      }),
    contract: "Return ONLY JSON",
  },
];

for (const { agent, build, contract } of CASES) {
  test(`${agent}: business instructions land before the format contract`, () => {
    const out = build(EXTRA);
    const businessAt = out.indexOf(EXTRA);
    const contractAt = out.indexOf(contract);
    expect(businessAt, `${agent} never included the instructions`).toBeGreaterThan(-1);
    expect(contractAt, `${agent} lost its format contract`).toBeGreaterThan(-1);
    expect(businessAt).toBeLessThan(contractAt);
  });

  test(`${agent}: an uncustomised prompt is byte-identical`, () => {
    // Anyone who has never touched the box must get exactly the prompt
    // this agent sent before the feature existed.
    expect(build(null)).toBe(build(""));
    expect(build(null)).not.toContain("Additional instructions");
  });
}

test("reply: instructions append at the end, since it has no format contract", () => {
  const out = buildSystemPrompt({
    userPrompt: null,
    mode: "auto_reply",
    extraInstructions: EXTRA,
  });
  expect(out).toContain(EXTRA);
  // Its output is free text a customer reads — nothing parses it, so
  // there is no contract for the business text to undercut.
  expect(out.trimEnd().endsWith(EXTRA)).toBe(true);
});

test("reply: an uncustomised prompt is byte-identical", () => {
  const plain = buildSystemPrompt({ userPrompt: null, mode: "auto_reply" });
  expect(buildSystemPrompt({ userPrompt: null, mode: "auto_reply", extraInstructions: null })).toBe(plain);
  expect(buildSystemPrompt({ userPrompt: null, mode: "auto_reply", extraInstructions: "  " })).toBe(plain);
});
