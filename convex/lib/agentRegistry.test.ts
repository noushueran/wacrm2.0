import { expect, test } from "vitest";
import {
  AGENT_REGISTRY,
  EXTRA_INSTRUCTIONS_MAX,
  withExtraInstructions,
  deriveAgentStatus,
  tallyWork,
  type AgentStatusInput,
} from "./agentRegistry";

function input(over: Partial<AgentStatusInput> = {}): AgentStatusInput {
  return {
    built: true,
    configured: true,
    enabled: true,
    onDemand: false,
    lastRunStatus: null,
    blockedReason: null,
    ...over,
  };
}

test("an unbuilt agent is never hired, whatever else is true", () => {
  expect(deriveAgentStatus(input({ built: false }))).toBe("not_hired");
  expect(
    deriveAgentStatus(input({ built: false, enabled: true, configured: true })),
  ).toBe("not_hired");
});

test("a built but unconfigured agent is not hired", () => {
  expect(deriveAgentStatus(input({ configured: false }))).toBe("not_hired");
});

test("a configured but disabled agent is off duty", () => {
  expect(deriveAgentStatus(input({ enabled: false }))).toBe("off_duty");
});

test("attention outranks working", () => {
  expect(
    deriveAgentStatus(input({ lastRunStatus: "running", blockedReason: "no token" })),
  ).toBe("attention");
  expect(deriveAgentStatus(input({ lastRunStatus: "failed" }))).toBe("attention");
});

test("a disabled agent with a blocker reads as off duty, not attention", () => {
  expect(
    deriveAgentStatus(input({ enabled: false, blockedReason: "no token" })),
  ).toBe("off_duty");
});

test("an in-flight run is working; an on-demand agent is on call", () => {
  expect(deriveAgentStatus(input({ lastRunStatus: "running" }))).toBe("working");
  expect(deriveAgentStatus(input({ onDemand: true }))).toBe("on_call");
});

test("a healthy enabled agent is on duty", () => {
  expect(deriveAgentStatus(input({ lastRunStatus: "success" }))).toBe("on_duty");
  expect(deriveAgentStatus(input())).toBe("on_duty");
});

test("tallyWork buckets per-mode tallies by owning agent", () => {
  const counts = tallyWork([
    { mode: "auto_reply", calls: 2 },
    { mode: "draft", calls: 1 },
    { mode: "qualify", calls: 1 },
    { mode: "classify", calls: 1 },
    { mode: "match_service", calls: 1 },
  ]);
  expect(counts.reply).toBe(3);
  expect(counts.qualify).toBe(1);
  expect(counts.tags).toBe(1);
  expect(counts.admatch).toBe(1);
  expect(counts.score).toBe(0);
});

test("repeated entries for one mode accumulate, never overwrite", () => {
  // One entry per mode per HOUR bucket, so a full day hands the same
  // mode over twenty times. Assigning instead of adding would report
  // the last hour and call it the day.
  const counts = tallyWork([
    { mode: "qualify", calls: 40 },
    { mode: "qualify", calls: 55 },
    { mode: "qualify", calls: 12 },
  ]);
  expect(counts.qualify).toBe(107);
});

test("match_service counts to the ad matcher, never the tag suggester", () => {
  const counts = tallyWork([
    { mode: "match_service", calls: 1 },
    { mode: "match_service", calls: 1 },
  ]);
  expect(counts.admatch).toBe(2);
  expect(counts.tags).toBe(0);
});

test("shared-sense modes are attributed to no agent", () => {
  const counts = tallyWork([
    { mode: "transcribe", calls: 31 },
    { mode: "describe", calls: 4 },
    { mode: "embed", calls: 1963 },
  ]);
  expect(Object.values(counts).every((n) => n === 0)).toBe(true);
});

test("the registry holds ten agents with unique keys", () => {
  expect(AGENT_REGISTRY).toHaveLength(10);
  const keys = AGENT_REGISTRY.map((a) => a.key);
  expect(new Set(keys).size).toBe(10);
});

test("only built agents may claim a cron or usage modes", () => {
  for (const agent of AGENT_REGISTRY) {
    if (!agent.built) {
      expect(agent.cronName).toBeNull();
      expect(agent.modes).toEqual([]);
    }
  }
});

test("the revival agent is built, and claims its cron and mode", () => {
  const revival = AGENT_REGISTRY.find((a) => a.key === "revival")!;
  expect(revival.built).toBe(true);
  expect(revival.cronName).toBe("revival-sweep");
  expect(revival.modes).toEqual(["revive"]);
});

test("every built agent can describe itself", () => {
  // The window renders the same five sections for all ten agents, so an
  // agent missing any of these would render a blank panel rather than an
  // obvious error.
  for (const agent of AGENT_REGISTRY) {
    if (!agent.built) continue;
    expect(agent.instructions, `${agent.key} has no instructions`).toBeTruthy();
    expect(agent.trigger, `${agent.key} has no trigger`).toBeTruthy();
    expect(agent.reads, `${agent.key} has no reads`).toBeTruthy();
    expect(agent.writes, `${agent.key} has no writes`).toBeTruthy();
  }
});

test("a built agent either owns a switch or names what controls it — never both, never neither", () => {
  // This is the honesty rule. An agent with no switch must say what
  // actually turns it on, rather than showing a toggle that secretly
  // flips a different agent's setting.
  for (const agent of AGENT_REGISTRY) {
    if (!agent.built) continue;
    const owns = agent.configKey !== null;
    const depends = agent.dependsOn !== null;
    expect(owns !== depends, `${agent.key} must have exactly one of configKey/dependsOn`).toBe(true);
  }
});

test("unbuilt agents claim no config and no dependency", () => {
  for (const agent of AGENT_REGISTRY) {
    if (agent.built) continue;
    expect(agent.configKey).toBeNull();
    expect(agent.dependsOn).toBeNull();
    expect(agent.instructions).toBeNull();
  }
});

test("the config-owning agents are exactly the ones with their own table", () => {
  const owning = AGENT_REGISTRY.filter((a) => a.configKey !== null).map((a) => a.key);
  expect(owning.sort()).toEqual(["coach", "kbgap", "qualify", "reply", "revival", "score"]);
});

test("every dependency points at a real agent when it names one", () => {
  const keys = new Set(AGENT_REGISTRY.map((a) => a.key));
  for (const agent of AGENT_REGISTRY) {
    if (!agent.dependsOn?.agentKey) continue;
    expect(keys.has(agent.dependsOn.agentKey), `${agent.key} depends on a missing agent`).toBe(true);
  }
});

test("extra instructions land BEFORE the format contract, never after", () => {
  const out = withExtraInstructions(
    "You classify things.",
    'Return ONLY JSON: {"a": string}',
    "Always prefer visa services.",
  );
  const businessAt = out.indexOf("Always prefer visa services");
  const formatAt = out.indexOf("Return ONLY JSON");
  expect(businessAt).toBeGreaterThan(-1);
  expect(formatAt).toBeGreaterThan(-1);
  // The ordering IS the safety property: prose after the format line
  // reads as the newest instruction and invites the model to ignore the
  // format, which silently breaks parsing.
  expect(businessAt).toBeLessThan(formatAt);
});

test("an agent nobody customised sends a byte-identical prompt", () => {
  const head = "You classify things.";
  const closing = 'Return ONLY JSON: {"a": string}';
  const plain = `${head}\n${closing}`;
  expect(withExtraInstructions(head, closing, null)).toBe(plain);
  expect(withExtraInstructions(head, closing, undefined)).toBe(plain);
  expect(withExtraInstructions(head, closing, "")).toBe(plain);
  expect(withExtraInstructions(head, closing, "   \n  ")).toBe(plain);
  // And nothing announces a section that has no content.
  expect(withExtraInstructions(head, closing, "")).not.toContain("Additional instructions");
});

test("the length cap is enforced in the prompt, not just the form", () => {
  const long = "x".repeat(EXTRA_INSTRUCTIONS_MAX + 500);
  const out = withExtraInstructions("head", "closing", long);
  expect(out).toContain("x".repeat(EXTRA_INSTRUCTIONS_MAX));
  expect(out).not.toContain("x".repeat(EXTRA_INSTRUCTIONS_MAX + 1));
});

test("the business section is labelled so the model knows whose words they are", () => {
  const out = withExtraInstructions("head", "closing", "Mention 3-day visas.");
  expect(out).toContain("Additional instructions from the business:");
});

test("an agent with no format contract still gets a byte-identical prompt when uncustomised", () => {
  // The reply agent's output is free text — there is no JSON contract to
  // protect, and an empty closing must not leave a stray newline.
  expect(withExtraInstructions("Just the prompt.", "", null)).toBe("Just the prompt.");
  expect(withExtraInstructions("Just the prompt.", "", "  ")).toBe("Just the prompt.");
});

test("with no format contract the business text is simply appended", () => {
  const out = withExtraInstructions("Just the prompt.", "", "Mention visas.");
  expect(out).toContain("Just the prompt.");
  expect(out).toContain("Mention visas.");
  expect(out.endsWith("Mention visas.")).toBe(true);
  // And no empty trailing section where the contract would have been.
  expect(out).not.toMatch(/\n\n$/);
});

test("every built agent reads extra instructions, and no unbuilt one claims to", () => {
  // The flag is a promise: the box appears where this is true. It flips
  // only in the commit that plumbs that agent's builder.
  for (const agent of AGENT_REGISTRY) {
    expect(
      agent.supportsExtraInstructions,
      `${agent.key} flag should match built=${agent.built}`,
    ).toBe(agent.built);
  }
});
