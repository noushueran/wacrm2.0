# Qualification Phase 6 — Agent Orchestration over WhatsApp (Design draft)

**Status:** DRAFT — owner requested 2026-07-18; foundation shipped (member phone numbers,
admin relay channel, mandatory service tags); the orchestration below is NOT built yet.
**Builds on:** the live qualification engine (PR #18–#21), `memberships.phone`,
`adminInquiries` relay, service auto-tags.

## Owner requirements (verbatim intent)

1. **Consent-based auto-assignment.** On qualification, offer the lead to an eligible
   agent over WhatsApp ("New lead: UAE visa, score 82 — are you ready to take it?").
   Reply = accept → assign (existing `conversations.assign` semantics + lead charge) →
   tell the customer "«Agent» will contact you shortly" → **send the agent's contact
   card** into the customer chat ("save it in case you want to call"). No reply within
   T minutes → offer the next eligible agent.
2. **Services routing section.** A new Settings → Services area mapping each service
   tag to the agents who can work it (agents carry service tags). Eligibility for step 1
   = agents whose tags include the lead's service tag; rotate through them.
3. **Lead feedback loop.** After assignment, the agent must update the lead's status in
   the CRM. The AI collects status/feedback over WhatsApp and REMINDS the agent (no
   interrogation — wait, then remind) until the dashboard is updated.
4. **Staff window keepalive.** For every staff number (admin/supervisor/agents): if
   their 24h window is open, remind them daily to keep chatting; if it closed, send a
   dedicated approved template asking them to reply and reopen it. Requires one new
   utility template (e.g. `staff_checkin`).
5. **Leads workspace advancement.** Richer scoring display, assignee panel (shipped:
   RBAC agents-own-only / supervisor-all / admin-all; assignee names on the board).

## Proposed architecture (next build)

- **`leadOffers` table**: {accountId, sessionId, conversationId, agentUserId, status
  offered|accepted|declined|timed_out, offeredAt, respondedAt} + cron sweep for offer
  timeouts (reuse the follow-up sweep shape). Offers ride the SAME staff-channel
  machinery as `adminInquiries` (plain sends; `ensureAdminConversation` generalizes to
  `ensureStaffConversation(phone)` with the loop guards extended to ALL staff numbers).
- **Staff inbound router**: today `onAdminInbound` answers the latest pending inquiry.
  Phase 6 generalizes it: an inbound from a staff number resolves against that number's
  open items (lead offer → accept/decline via yes/no + LLM intent; else pending
  inquiry answer; else feedback update; else free chat ignored). Per-number routing —
  offers are per-agent, so the ambiguity stays small.
- **Contact card**: new `metaSend.sendContactCard` (Cloud API `type: "contacts"`
  payload with the agent's name + phone) — the one new Meta send surface.
- **Services routing**: tags already exist per service (auto-created on qualification);
  add `memberTags` (userId ↔ tagId per account) + Settings → Services editor; the
  offer engine walks matching agents ordered by fewest-open-leads.
- **Feedback/keepalive crons**: daily staff-checkin cron (window state derivable from
  the staff conversation's `lastCustomerMessageAt`-equivalent: their last inbound);
  assigned-lead reminder cron (leads qualified+assigned with no funnel/stage/status
  change in N hours → WhatsApp nudge to the assignee, escalating to supervisor).
- **Customer messaging**: on accept — assistant tells the customer who's coming +
  sends the contact card; on nobody-available — falls back to today's behavior
  (supervisor notifications, unassigned queue).

## Open decisions for the owner
1. Offer timeout per agent (suggest 10 min) and rotation order (suggest fewest open
   assigned leads, then round-robin).
2. Should the customer be told anything while agents are still being offered? (suggest:
   nothing — the closing message already promised contact "shortly").
3. Feedback reminder cadence (suggest: first nudge 4 working-hours after assignment,
   then daily, escalate to supervisor after 2 silent days).
4. `staff_checkin` template copy (needs Meta approval like the other two).
