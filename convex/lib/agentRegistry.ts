/**
 * The agent roster — identity, duty, and status derivation for every AI
 * agent on the platform.
 *
 * A static registry in code, not a table: agents are software, not user
 * data, so identity and the rules that decide their status belong in one
 * reviewable place. Mirrors `CRON_REGISTRY` in `./cronSummary.ts`.
 *
 * Kept PURE (no ctx, no `_generated` imports) for the same reason
 * `summarizeSystemTasks` is: convex-test cannot emulate every ctx
 * surface, and the derivation rules carry the unit tests.
 */

export type AgentKey =
  | "reply"
  | "qualify"
  | "score"
  | "checklist"
  | "tags"
  | "admatch"
  | "revival"
  | "kbgap"
  | "coach"
  | "quote";

export type AgentStatus =
  | "working"
  | "on_duty"
  | "on_call"
  | "attention"
  | "off_duty"
  | "not_hired";

export interface AgentEntry {
  key: AgentKey;
  name: string;
  duty: string;
  /** The `CRON_REGISTRY` name whose run history is this agent's heartbeat. */
  cronName: string | null;
  /** Acts only when a human asks — never on its own schedule. */
  onDemand: boolean;
  /** False for agents that are specced but not written yet. */
  built: boolean;
  /**
   * `aiUsageHourlyStats.modes[].mode` values whose call tallies count as
   * this agent's work — no longer `aiUsageLog` rows.
   */
  modes: string[];
  /** Shown under the status pill when the agent cannot be hired yet. */
  notHiredReason: string | null;

  /**
   * What this agent is told to do, in plain language. Null until built.
   *
   * Deliberately NOT the raw prompt. Six of the seven built agents send
   * scaffolds full of JSON format contracts; showing one would tell a
   * reader what shape the model must reply in, not what the agent does,
   * and would invite someone to edit a contract that parsing depends on.
   * This is the human-checkable version — keep it true to the prompt.
   */
  instructions: string | null;
  /** When it acts, in human terms. */
  trigger: string | null;
  /** What it looks at. */
  reads: string | null;
  /** What it changes. Says plainly when it sends nothing. */
  writes: string | null;

  /**
   * The config table owning this agent's on/off switch, when it has one
   * of its own. Exactly one of `configKey` / `dependsOn` is set on every
   * built agent — see `dependsOn`.
   */
  configKey:
    | "aiConfigs"
    | "qualificationConfigs"
    | "leadAnalysisConfigs"
    | "revivalConfigs"
    | "kbGapConfigs"
    | "salesCoachConfigs"
    | null;

  /**
   * What actually controls an agent that has no switch of its own.
   *
   * These three are real: the checklist writer fires when qualification
   * completes, the tag suggester rides `aiConfigs.isActive`, and the ad
   * matcher runs on every ad click and needs an env var. Rendering a
   * toggle for any of them would mean secretly writing a different
   * agent's setting, so the window states the truth and links to the
   * control that does exist.
   */
  dependsOn: { label: string; note: string; agentKey?: AgentKey } | null;

  /**
   * Whether this agent's prompt actually reads the account's extra
   * instructions.
   *
   * The window shows the box only where this is true. Offering a text
   * area that silently does nothing would be worse than not offering
   * one — flip this in the same commit that plumbs the agent's builder,
   * never before.
   */
  supportsExtraInstructions: boolean;
}

export const AGENT_REGISTRY: readonly AgentEntry[] = [
  {
    key: "reply",
    name: "Reply agent",
    duty: "Answers customer questions from the knowledge base, in their own language",
    cronName: null,
    onDemand: false,
    built: true,
    modes: ["auto_reply", "draft"],
    instructions:
      "Answers the customer's question using the knowledge base, in whatever language and script they wrote in, including Manglish. Says it will check rather than inventing an answer it does not have, and hands over to a person when asked.",
    trigger: "Every inbound message, when auto-reply is on",
    reads: "The thread, the knowledge base, and any image or voice note",
    writes: "Sends a reply to the customer",
    configKey: "aiConfigs",
    dependsOn: null,
    supportsExtraInstructions: true,
    notHiredReason: null,
  },
  {
    key: "qualify",
    name: "Qualification agent",
    duty: "Asks the trip questions, builds the profile, spots buying intent",
    cronName: "qualification-follow-ups",
    onDemand: false,
    built: true,
    modes: ["qualify"],
    instructions:
      "Reads the conversation and pulls out the trip: destination, dates, travellers and budget. Asks for whichever of those is still missing, one at a time, and decides when the lead is qualified enough to hand to a salesperson. Also spots when someone is ready to buy, or asks to be left alone.",
    trigger: "Every inbound message on a live session",
    reads: "The thread and the account's qualification questions",
    writes: "Asks the customer questions, and updates the contact's trip profile",
    configKey: "qualificationConfigs",
    dependsOn: null,
    supportsExtraInstructions: true,
    notHiredReason: null,
  },
  {
    key: "score",
    name: "Lead scorer",
    // 1–10, per `leadAnalyses.score`'s own comment — NOT 0–100, which is
    // what this line claimed until 2026-08-09.
    duty: "Scores every lead one to ten and sorts them into bands",
    cronName: "lead-scoring",
    onDemand: false,
    built: true,
    modes: ["score"],
    instructions:
      "Reads the whole conversation and scores how promising the lead is, one to ten, with a short reason. The score sorts leads into bands so the best ones get attention first.",
    trigger: "A sweep every 5 minutes",
    reads: "The thread and any notes on the contact",
    writes: "A score and band on the lead. Sends nothing to the customer",
    configKey: "leadAnalysisConfigs",
    dependsOn: null,
    supportsExtraInstructions: true,
    notHiredReason: null,
  },
  {
    key: "checklist",
    name: "Checklist writer",
    duty: "Writes the salesperson's task list the moment a lead qualifies",
    cronName: null,
    onDemand: false,
    built: true,
    modes: ["checklist"],
    instructions:
      "Turns the knowledge base's sales steps into a specific task list for this lead — what to call about, what to quote, what to send — so the salesperson starts with a plan rather than a blank thread.",
    trigger: "The moment a lead qualifies",
    reads: "The qualification answers and the knowledge base",
    writes: "A checklist for the salesperson. Sends nothing to the customer",
    configKey: null,
    dependsOn: { label: "Lead qualification", note: "Runs whenever the qualification agent is on. It has no switch of its own.", agentKey: "qualify" },
    supportsExtraInstructions: true,
    notHiredReason: null,
  },
  {
    key: "tags",
    name: "Tag suggester",
    duty: "Reads a thread and proposes the right tags, when asked",
    cronName: null,
    onDemand: true,
    built: true,
    modes: ["classify"],
    instructions:
      "Reads a thread and proposes tags from the account's own catalogue, with a confidence and a one-line note. A person accepts or dismisses them; it never applies a tag on its own.",
    trigger: "Only when someone asks for it",
    reads: "The thread and the tag catalogue",
    writes: "A pending tag suggestion. Sends nothing to the customer",
    configKey: null,
    dependsOn: { label: "AI assistant", note: "Available whenever the AI assistant is active. It has no switch of its own.", agentKey: "reply" },
    supportsExtraInstructions: true,
    notHiredReason: null,
  },
  {
    key: "admatch",
    name: "Ad matcher",
    duty: "Matches each ad click to the service it was advertising",
    cronName: "retry-ad-resolution",
    onDemand: false,
    built: true,
    modes: ["match_service"],
    instructions:
      "Works out which service an ad click was actually about, by matching the ad's wording against the account's services, so the lead arrives already tagged.",
    trigger: "Every click-to-WhatsApp ad referral",
    reads: "The ad's headline and body, and the service list",
    writes: "A service tag on the conversation. Sends nothing to the customer",
    configKey: null,
    dependsOn: { label: "Meta access token", note: "Runs on every ad click. Needs META_ADS_ACCESS_TOKEN on the deployment to resolve ad and campaign names." },
    supportsExtraInstructions: true,
    notHiredReason: null,
  },
  {
    key: "revival",
    name: "Revival agent",
    duty: "Chases leads that went quiet, in their own words",
    cronName: "revival-sweep",
    onDemand: false,
    built: true,
    modes: ["revive"],
    instructions:
      "Finds leads that went quiet while there is still time to reach them, and writes one short follow-up that references their actual trip in their own language. Never invents a price or availability, and always ends with one easy question. Every message waits for a person to approve it.",
    trigger: "A sweep every 30 minutes",
    reads: "The thread, the trip profile, and the lead score",
    writes: "A draft into the approval queue. Sends nothing by itself",
    configKey: "revivalConfigs",
    dependsOn: null,
    supportsExtraInstructions: true,
    notHiredReason: null,
  },
  {
    key: "kbgap",
    name: "Knowledge gap agent",
    duty: "Turns questions nobody could answer into knowledge entries",
    cronName: "kbgap-sweep",
    onDemand: false,
    built: true,
    modes: ["kb_gap"],
    instructions:
      "Reads the questions the assistant had to escalate to staff. Where a person answered, it turns that answer into a knowledge-base draft so the assistant can answer it itself next time — rewriting only what the answer says, never adding facts. Where nobody answered, it groups the questions into themes and reports them, deliberately without inventing an answer.",
    trigger: "A sweep every 6 hours",
    reads: "Escalated questions, their staff answers, and the knowledge base",
    writes: "Knowledge-base drafts and a gap report. Sends nothing to the customer",
    configKey: "kbGapConfigs",
    dependsOn: null,
    supportsExtraInstructions: true,
    notHiredReason: null,
  },
  {
    key: "coach",
    name: "Sales coach",
    duty: "Reads every handled thread and coaches the team on it",
    cronName: "sales-coach-sweep",
    onDemand: false,
    built: true,
    modes: ["coach"],
    instructions:
      "Reads conversations a person actually handled and writes specific observations about the handling — a question the customer asked and never got answered, a checklist step never done, a slow or missing first reply, a curt or confusing message. Every observation quotes the thread, and it says what went well too. It does NOT score or rank anyone, and it judges only what is in the thread, never what might have happened on a call.",
    trigger: "A sweep once a day",
    reads: "Threads a person handled, and their sales checklist",
    writes: "Coaching notes for that person. Sends nothing to the customer",
    configKey: "salesCoachConfigs",
    dependsOn: null,
    supportsExtraInstructions: true,
    notHiredReason: null,
  },
  {
    key: "quote",
    name: "Quote drafter",
    duty: "Drafts the itinerary, inclusions, and visa notes",
    cronName: null,
    onDemand: false,
    built: false,
    modes: [],
    instructions: null,
    trigger: null,
    reads: null,
    writes: null,
    configKey: null,
    dependsOn: null,
    supportsExtraInstructions: false,
    notHiredReason: "needs a pricing catalogue",
  },
] as const;

export interface AgentStatusInput {
  built: boolean;
  /** A config row exists for this account. */
  configured: boolean;
  enabled: boolean;
  onDemand: boolean;
  /** Status of the most recent run of this agent's cron, if it claims one. */
  lastRunStatus: "running" | "success" | "failed" | null;
  /** A declared, currently-tripped blocker (e.g. a missing env var). */
  blockedReason: string | null;
}

/**
 * Precedence is deliberate and load-bearing:
 *
 *  - `not_hired` first — an unbuilt agent has no config to interpret.
 *  - `off_duty` before `attention` — a switched-off agent is not broken,
 *    it is off, and a blocker on it is not news.
 *  - `attention` before `working` — an agent that is failing while
 *    mid-run must read as broken, not busy. This is the one ordering a
 *    naive implementation gets wrong.
 */
export function deriveAgentStatus(input: AgentStatusInput): AgentStatus {
  if (!input.built) return "not_hired";
  if (!input.configured) return "not_hired";
  if (!input.enabled) return "off_duty";
  if (input.blockedReason !== null) return "attention";
  if (input.lastRunStatus === "failed") return "attention";
  if (input.lastRunStatus === "running") return "working";
  if (input.onDemand) return "on_call";
  return "on_duty";
}

/**
 * Bucket per-mode call tallies onto the agent that earned them.
 *
 * Takes tallies rather than rows because the source is
 * `aiUsageHourlyStats`, which already counted the calls at write time —
 * one `{ mode, calls }` entry per mode per UTC hour. It therefore
 * ACCUMULATES: a mode reappears in every hour it was used, so assigning
 * would report the last hour of the day and call it the whole day.
 *
 * `transcribe`, `describe`, and `embed` are deliberately attributed to
 * NOBODY. They are shared senses — the vision pass, the voice pass, and
 * the retrieval embedding are used by several agents on one another's
 * behalf, so charging them to any single agent would misreport all of
 * them. They remain visible in aggregate on the usage tab. They are also
 * roughly half of this deployment's daily call volume, which is why the
 * old row-scanning version spent half its read budget on rows that could
 * not increment anything.
 */
export function tallyWork(
  tallies: Array<{ mode: string; calls: number }>,
): Record<AgentKey, number> {
  const owner = new Map<string, AgentKey>();
  for (const agent of AGENT_REGISTRY) {
    for (const mode of agent.modes) owner.set(mode, agent.key);
  }

  const counts = Object.fromEntries(
    AGENT_REGISTRY.map((a) => [a.key, 0]),
  ) as Record<AgentKey, number>;

  for (const tally of tallies) {
    const key = owner.get(tally.mode);
    if (key) counts[key] += tally.calls;
  }
  return counts;
}

/**
 * Everything the four config tables say, flattened to booleans.
 *
 * Flattened so the resolution below stays pure and testable: the rules
 * for which flag governs which agent are business logic, and belong
 * beside the registry rather than inside a query.
 */
export interface AgentConfigState {
  aiConfigured: boolean;
  aiActive: boolean;
  autoReplyEnabled: boolean;
  qualConfigured: boolean;
  qualEnabled: boolean;
  leadConfigured: boolean;
  leadEnabled: boolean;
  revivalConfigured: boolean;
  revivalEnabled: boolean;
  kbGapConfigured: boolean;
  kbGapEnabled: boolean;
  coachConfigured: boolean;
  coachEnabled: boolean;
  adTokenMissing: boolean;
}

/**
 * Which config governs this agent, and what it currently says.
 *
 * Shared by the roster and the per-agent window on purpose. Two copies
 * of these rules is precisely how a board and a detail panel come to
 * disagree about whether an agent is on.
 */
export function resolveAgentState(
  key: AgentKey,
  s: AgentConfigState,
): { configured: boolean; enabled: boolean; blockedReason: string | null } {
  switch (key) {
    case "reply":
      return {
        configured: s.aiConfigured,
        enabled: s.aiActive && s.autoReplyEnabled,
        blockedReason: null,
      };
    case "tags":
      // Never needed `autoReplyEnabled` — a human asks for it.
      return { configured: s.aiConfigured, enabled: s.aiActive, blockedReason: null };
    case "qualify":
    case "checklist":
      // The checklist writer has no switch of its own; it fires when
      // qualification completes, so it lives and dies with that config.
      return { configured: s.qualConfigured, enabled: s.qualEnabled, blockedReason: null };
    case "score":
      return { configured: s.leadConfigured, enabled: s.leadEnabled, blockedReason: null };
    case "revival":
      return {
        configured: s.revivalConfigured,
        enabled: s.revivalEnabled,
        blockedReason: null,
      };
    case "coach":
      return {
        configured: s.coachConfigured,
        enabled: s.coachEnabled,
        blockedReason: null,
      };
    case "kbgap":
      return {
        configured: s.kbGapConfigured,
        enabled: s.kbGapEnabled,
        blockedReason: null,
      };
    case "admatch":
      // No config row: it runs on every ad click. "Configured" means the
      // credential it needs to do the job at all.
      return {
        configured: true,
        enabled: true,
        blockedReason: s.adTokenMissing ? "no Meta token — ad names unresolved" : null,
      };
    default:
      // Not built. `deriveAgentStatus` short-circuits before reading these.
      return { configured: false, enabled: false, blockedReason: null };
  }
}

/**
 * How long an account's extra instructions for one agent may be.
 * Enforced server-side; the box counts against it client-side.
 */
export const EXTRA_INSTRUCTIONS_MAX = 2000;

/**
 * Splice an account's own instructions into an agent's prompt.
 *
 * PLACEMENT IS THE WHOLE CONTRACT. The text goes BEFORE the caller's
 * closing section — which for every structured agent is its output
 * format ("Return ONLY JSON: ..."). Business prose placed AFTER a format
 * line reads as the most recent, most specific instruction and invites
 * the model to override the format, which would silently break parsing.
 * That failure is exactly what read-only instructions exist to prevent,
 * so the append helper enforces the ordering rather than trusting seven
 * call sites to remember it.
 *
 * Empty or whitespace-only input returns `head` and `tail` joined
 * unchanged, so an agent nobody has customised sends a byte-identical
 * prompt to the one it sent before this feature existed.
 */
export function withExtraInstructions(
  head: string,
  closing: string,
  extra: string | null | undefined,
): string {
  const text = extra?.trim() ?? "";
  // An empty `closing` means the agent has no output-format contract to
  // protect — the reply agent, whose output is free text. Joining an
  // empty string would append a stray newline and break the
  // byte-identical guarantee, so it is dropped rather than joined.
  if (!text) return closing ? `${head}\n${closing}` : head;
  const clipped = text.slice(0, EXTRA_INSTRUCTIONS_MAX);
  return [
    head,
    "",
    "Additional instructions from the business:",
    clipped,
    ...(closing ? ["", closing] : []),
  ].join("\n");
}
