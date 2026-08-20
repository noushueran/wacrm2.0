import { describe, expect, it } from "vitest";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "./validate";

describe("validateStepsForActivation", () => {
  it("rejects empty or missing step lists", () => {
    expect(validateStepsForActivation([])).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
    expect(
      validateStepsForActivation(undefined as unknown as never[]),
    ).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
  });

  it("passes a fully-populated step set", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "hi" } },
      {
        step_type: "wait",
        step_config: { amount: 5, unit: "minutes" },
      },
      { step_type: "add_tag", step_config: { tag_id: "tag-uuid" } },
      { step_type: "close_conversation", step_config: {} },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags every required field that is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "  " } },
      { step_type: "send_template", step_config: {} },
      { step_type: "add_tag", step_config: { tag_id: "" } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].text",
      "steps[1].template_name",
      "steps[2].tag_id",
    ]);
  });

  it("checks wait amount and unit boundaries", () => {
    const issues = validateStepsForActivation([
      { step_type: "wait", step_config: { amount: 0, unit: "minutes" } },
      { step_type: "wait", step_config: { amount: 5, unit: "seconds" } },
      { step_type: "wait", step_config: { amount: -1, unit: "hours" } },
      {
        step_type: "wait",
        step_config: { amount: Number.POSITIVE_INFINITY, unit: "days" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].amount",
      "steps[1].unit",
      "steps[2].amount",
      "steps[3].amount",
    ]);
  });

  it("validates webhook URLs", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "https://hooks.example.com/in" },
      },
    ]);
    expect(good).toEqual([]);

    const noUrl = validateStepsForActivation([
      { step_type: "send_webhook", step_config: {} },
    ]);
    expect(noUrl.map((i) => i.message)).toContain("webhook URL is required");

    const wrongProtocol = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "ftp://files.example.com" },
      },
    ]);
    expect(wrongProtocol.map((i) => i.message)).toContain(
      "webhook URL must use http or https",
    );

    const garbage = validateStepsForActivation([
      { step_type: "send_webhook", step_config: { url: "not a url" } },
    ]);
    expect(garbage.map((i) => i.message)).toContain(
      "webhook URL is not a valid URL",
    );
  });

  it("validates assign_conversation only when mode is 'specific'", () => {
    const roundRobinNoAgent = validateStepsForActivation([
      {
        step_type: "assign_conversation",
        step_config: { mode: "round_robin" },
      },
    ]);
    expect(roundRobinNoAgent).toEqual([]);

    const specificMissingAgent = validateStepsForActivation([
      { step_type: "assign_conversation", step_config: { mode: "specific" } },
    ]);
    expect(specificMissingAgent.map((i) => i.path)).toEqual([
      "steps[0].agent_id",
    ]);
  });

  it("flags create_deal when required fields are missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "create_deal", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].pipeline_id",
      "steps[0].stage_id",
      "steps[0].title",
    ]);
  });

  it("validates send_buttons / send_list interactive payloads", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_buttons",
        step_config: {
          kind: "buttons",
          body: "Pick one",
          buttons: [{ id: "yes", title: "Yes" }],
        },
      },
    ]);
    expect(good).toEqual([]);

    const tooMany = validateStepsForActivation([
      {
        step_type: "send_buttons",
        step_config: {
          kind: "buttons",
          body: "Pick one",
          buttons: [
            { id: "a", title: "A" },
            { id: "b", title: "B" },
            { id: "c", title: "C" },
            { id: "d", title: "D" },
          ],
        },
      },
    ]);
    expect(tooMany.map((i) => i.path)).toEqual(["steps[0].interactive"]);
  });

  it("flags update_contact_field when field or value is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "update_contact_field", step_config: { field: "name" } },
      {
        step_type: "update_contact_field",
        step_config: { field: "", value: "x" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].value",
      "steps[1].field",
    ]);
  });

  it("recursively walks condition branches with stable dot-paths", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "condition",
        step_config: { subject: "tag", operand: "vip" },
        branches: {
          yes: [{ step_type: "add_tag", step_config: { tag_id: "" } }],
          no: [
            {
              step_type: "send_message",
              step_config: { text: "" },
            },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].yes.steps[0].tag_id",
      "steps[0].no.steps[0].text",
    ]);
  });

  it("reports an issue for unknown step types", () => {
    const issues = validateStepsForActivation([
      { step_type: "do_a_barrel_roll", step_config: {} },
    ]);
    expect(issues).toEqual([
      { path: "steps[0]", message: "unknown step type: do_a_barrel_roll" },
    ]);
  });

  it("flags condition subject/operand independently", () => {
    const issues = validateStepsForActivation([
      { step_type: "condition", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].operand",
      "steps[0].subject",
    ]);
  });

  it("a send_message with only media is valid — text is no longer required", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { media: { type: "image", url: "https://x/a.jpg" } } },
    ]);
    expect(issues).toEqual([]);
  });

  it("a send_message with only buttons is valid", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "send_message",
        step_config: { interactive: { kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] } },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("a send_message with nothing to send is rejected", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: {} },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/needs text, media or buttons/);
  });

  it("media and buttons together are rejected", () => {
    // The interactive payload's button title is deliberately over Meta's
    // 20-char limit (also invalid on its own — see the next test) so that
    // the exclusivity check's `break` is actually exercised: without it,
    // `validateInteractivePayload` would run too and push a second issue,
    // which is exactly what `toHaveLength(1)` below is pinned to catch. A
    // validly-shaped interactive payload can't do this — with `media` set,
    // `planSend(...).kind` is always "media", never "empty", so the
    // "needs text, media or buttons" check can never fire here regardless
    // of `break`; the interactive-validity check is the only other check
    // `break` is actually guarding against for a send step with media set.
    const issues = validateStepsForActivation([
      {
        step_type: "send_message",
        step_config: {
          media: { type: "image", url: "https://x/a.jpg" },
          interactive: {
            kind: "buttons",
            body: "pick",
            buttons: [{ id: "a", title: "This title is far too long for Meta" }],
          },
        },
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/cannot carry both media and buttons/);
  });

  it("an invalid interactive payload still reports Meta's own limit message", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "send_message",
        step_config: {
          interactive: {
            kind: "buttons",
            body: "pick",
            buttons: [{ id: "a", title: "This title is far too long for Meta" }],
          },
        },
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(
      'Button label "This title is far too long for Meta" exceeds the 20-character limit.',
    );
  });

  it("a fallback template with no name is rejected", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "hi", fallback: { language: "en_US" } } },
    ]);
    expect(issues[0].message).toMatch(/fallback template name is required/);
  });

  it("a legacy { text } config is still valid", () => {
    expect(
      validateStepsForActivation([{ step_type: "send_message", step_config: { text: "hello" } }]),
    ).toEqual([]);
  });

  it("a stored send_buttons step is still valid", () => {
    expect(
      validateStepsForActivation([
        {
          step_type: "send_buttons",
          step_config: { kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] },
        },
      ]),
    ).toEqual([]);
  });
});

describe("validateTriggerForActivation", () => {
  it("accepts a valid keyword_match config", () => {
    expect(
      validateTriggerForActivation("keyword_match", {
        keywords: ["hello", "hi"],
        match_type: "exact",
      }),
    ).toEqual([]);
  });

  it("rejects keyword_match with empty keyword array", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: [],
      match_type: "exact",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.keywords");
  });

  it("rejects keyword_match with whitespace-only entries", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi", "   "],
      match_type: "contains",
    });
    expect(issues.map((i) => i.message)).toContain(
      "keywords cannot be empty strings",
    );
  });

  it("rejects keyword_match with an unknown match_type", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi"],
      match_type: "fuzzy",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.match_type");
  });

  it("accepts keyword_match with a missing match_type (defaults to contains)", () => {
    expect(
      validateTriggerForActivation("keyword_match", { keywords: ["hi"] }),
    ).toEqual([]);
  });

  it("requires both a daily schedule and an audience tag on time_based triggers", () => {
    expect(validateTriggerForActivation("time_based", {})).toEqual([
      { path: "trigger.schedule", message: "schedule is required" },
      { path: "trigger.tag_id", message: "tag is required" },
    ]);
    expect(
      validateTriggerForActivation("time_based", {
        schedule: "09:00",
        tag_id: "tag-uuid",
      }),
    ).toEqual([]);
  });

  it("rejects a time_based schedule the engine could never fire", () => {
    // This is the shape the old builder's "Cron expression or HH:mm"
    // placeholder invited, and the old validation accepted: it activated
    // cleanly and then never ran, because the sweep only understands a
    // daily HH:mm.
    expect(
      validateTriggerForActivation("time_based", {
        schedule: "0 9 * * *",
        tag_id: "tag-uuid",
      }),
    ).toEqual([
      {
        path: "trigger.schedule",
        message: 'schedule must be a daily time in 24-hour "HH:mm" form, e.g. "09:00"',
      },
    ]);
    expect(
      validateTriggerForActivation("time_based", {
        schedule: "25:00",
        tag_id: "tag-uuid",
      }),
    ).toHaveLength(1);
  });

  it("requires an audience even when the schedule is valid", () => {
    expect(
      validateTriggerForActivation("time_based", { schedule: "09:00" }),
    ).toEqual([{ path: "trigger.tag_id", message: "tag is required" }]);
  });

  it("requires tag_id on tag_added triggers", () => {
    expect(validateTriggerForActivation("tag_added", {})).toEqual([
      { path: "trigger.tag_id", message: "tag is required" },
    ]);
    expect(
      validateTriggerForActivation("tag_added", { tag_id: "tag-uuid" }),
    ).toEqual([]);
  });

  it("requires reply_ids on interactive_reply triggers", () => {
    expect(validateTriggerForActivation("interactive_reply", {})).toEqual([
      { path: "trigger.reply_ids", message: "at least one reply id is required" },
    ]);
    expect(
      validateTriggerForActivation("interactive_reply", { reply_ids: ["yes", "no"] }),
    ).toEqual([]);
    const empties = validateTriggerForActivation("interactive_reply", {
      reply_ids: ["yes", "  "],
    });
    expect(empties.map((i) => i.message)).toContain(
      "reply ids cannot be empty strings",
    );
  });

  it("does not flag unknown trigger types (handled elsewhere)", () => {
    expect(validateTriggerForActivation("some_future_trigger", {})).toEqual([]);
  });
});
