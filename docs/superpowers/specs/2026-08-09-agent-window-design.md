# Agent window — design

Date: 2026-08-09
Status: awaiting approval

## Problem

The roster shows ten agents and tells you almost nothing about any of them. To
change one you have to already know where its settings live, and they live in
five different places:

| Agent | Enable/disable | Settings live in |
|---|---|---|
| Reply | `aiConfigs.isActive` + `autoReplyEnabled` | AI Agents → Setup |
| Qualification | `qualificationConfigs.enabled` | Settings → Lead qualification |
| Lead scorer | `leadAnalysisConfigs.enabled` | Settings → Follow-up sequence |
| Revival | `revivalConfigs.enabled` | AI Agents → Revival |
| Checklist writer | none — follows qualification | nowhere |
| Tag suggester | none — follows `isActive` | nowhere |
| Ad matcher | none — `META_ADS_ACCESS_TOKEN` only | nowhere |

Nobody can answer "what is this agent told to do, and how do I change it?"
without reading the source.

## Goal

Clicking any agent on the roster opens a window showing, in the same shape for
every agent: what it is, whether it's on, what it's told, and everything about it
you can change.

## The window

A right-hand `Sheet` (the primitive already in `src/components/ui/sheet.tsx`),
opened by clicking a roster row and deep-linkable as
`/agents?tab=roster&agent=<key>` via the shallow URL sync `agents/page.tsx`
already uses for tabs.

Five sections, in this order, for all ten agents:

### 1. Header
Icon, name, duty, and the same status pill the roster shows. No new vocabulary.

### 2. On or off

For the four agents that own config — reply, qualification, lead scorer,
revival — a real switch writing that agent's own flag.

For the three that don't, **an honest statement of what actually controls them**,
with a link to that control:

- Checklist writer → "Runs whenever Lead qualification is on"
- Tag suggester → "Available whenever the AI assistant is active"
- Ad matcher → "Runs on every ad click. Needs `META_ADS_ACCESS_TOKEN`, which is
  not set."

A toggle that silently flips a different agent's setting would be worse than no
toggle. For the three unbuilt agents the section says so and nothing more.

### 3. Details

Registry-authored, so it cannot drift from behaviour: what triggers it, how often
it runs, what it reads, what it writes. Plus the live figures the roster already
computes — work today, last run, and any blocker.

### 4. Instructions

**Read-only**, and deliberately *not* the raw prompt. Six of the seven built
agents return structured JSON that gets parsed; their prompts are scaffolds full
of format contracts, and pasting one into a settings page invites someone to
break it. Instead the registry carries a plain-language `instructions` string per
agent — what it is actually told to do, in words a non-engineer can check.

The reply agent keeps its existing editable `aiConfigs.systemPrompt`, because it
has one, it is free-text, and nothing parses its output.

Below that, for every built agent, an **Additional instructions** box.

### 5. Settings

The agent's own tunables, inline. Lead qualification and Follow-up sequence
**move here** out of Settings; their entries in the settings rail become links
that open the corresponding agent window. One editor per row — two surfaces over
one config is how they drift.

## Additional instructions

A per-agent, per-account free-text field, appended to that agent's prompt. It
lets someone steer tone, priorities, and business rules without touching the
scaffold that keeps parsing working.

New table:

```
agentInstructions: { accountId, agentKey, extraInstructions, updatedAt }
  .index("by_account_agent", ["accountId", "agentKey"])
```

**Where it is inserted matters.** Every prompt builder places it *before* its
output-format contract, never after:

```
<the agent's own scaffold>

Additional instructions from the business:
<the text>

Return ONLY JSON: {...}
```

Putting business text after the format line invites it to override the format —
which is the exact failure mode read-only instructions exist to prevent. A test
per builder asserts the ordering.

Length is capped (2,000 characters) and the cap is enforced server-side. An empty
or whitespace-only value writes nothing and appends nothing, so the prompt is
byte-identical to today's for any agent nobody has customised.

## Backend

- `convex/lib/agentRegistry.ts` gains per-agent `instructions`, `trigger`,
  `reads`, `writes`, and either `configKey` or `dependsOn`. Still pure, still the
  single reviewable place agent identity lives.
- `agentRoster.detail({ agentKey })` — one member-safe query returning the
  window's contents, bounded like `roster`.
- `agentInstructions.get` / `.upsert` — admin-gated, since instructions change
  what customers are told.
- Each prompt builder takes an optional `extraInstructions` and appends it in the
  documented position.

## Access control

Reading the window matches `roster` — member-safe, no keys or prompts beyond the
registry prose. Every write (toggles, tunables, instructions) is admin-gated, and
the client skips those queries for non-admins rather than throwing, per the trap
`agents/page.tsx` documents.

## Phasing

Each phase ships on its own and is useful without the next.

1. **The window** — shell, details, status, honest dependencies, existing
   toggles. Delivers the IA immediately; settings still read-only.
2. **Additional instructions** — table, mutation, plumbing into all seven prompt
   builders with ordering tests.
3. **Settings migration** — qualification and lead-sequence editors move in; the
   settings rail entries become links.

## Testing

- Registry: every built agent has `instructions`, `trigger`, and exactly one of
  `configKey` or `dependsOn`. Unbuilt agents have neither.
- `detail` returns the right shape per agent and never leaks keys or prompts.
- Toggling writes only that agent's own flag.
- Instruction ordering: the appended text precedes the format contract in every
  builder.
- Empty instructions leave each prompt byte-identical.
- Component: each section renders for an agent with config and for one without,
  and the no-switch agents render a dependency line rather than a switch.

## Out of scope

- Editable raw prompts for the structured agents
- Per-agent switches for the three that have no config of their own
- Anything for the three unbuilt agents beyond "not built yet"
