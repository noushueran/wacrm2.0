# Inbox assignment tabs — design

- **Date:** 2026-07-12
- **Status:** Approved (pending spec review)
- **Branch / worktree:** `worktree-inbox-assignment-tabs` (based on `origin/main` @ `7cf629f`)

## Problem

The inbox shows every conversation in one flat list. An agent (or admin) cannot
tell which chats are assigned to them, which sit unclaimed in the pool, or which
belong to a teammate — the only way to know is to open a chat and read its
assign dropdown. There is no way to focus on "my" chats or on the claimable
pool.

## Goal

Add a lightweight **assignment tab bar** to the top of the conversation list —
`All · Mine · Unassigned` — that filters the list server-side, plus a small
per-row indicator showing assignment at a glance. Keep the existing design and
every existing control (search, status filter, tags, company) unchanged.

## Non-goals

- No change to the assign/unassign mutations or the assign dropdown in the thread.
- No change to role visibility rules (`conversationScope`) — tabs filter *within*
  what a role may already see.
- No bulk-assign, no drag-to-assign, no saved/remembered tab across reloads
  (tab resets to `All` on a fresh load — in-memory state only).
- No count badges on the tabs (possible later enhancement).

## Approved decisions

1. **Tabs:** `All · Mine · Unassigned`. `All` is the **default**, so the inbox
   opens exactly as today (nothing breaks). Role-agnostic: works for agents and
   admins alike.
2. **Filtering is server-side.** Each tab fetches its *complete* set, correctly
   paginated with its own "Load more" — not a client-side filter of the loaded
   page. This avoids a "where are my other chats?" undercount for dormant chats
   deep in the list. Chosen over client-side because the list is cursor-paginated
   (~30 rows at a time).

## Architecture

The page already owns the paginated query, so the active tab lives there and
flows down as a prop. The filter itself is one predicate added to the query that
already composes role-scope + status server-side.

### 1. Server — `convex/conversations.ts › list`

Add one optional arg and one AND-composed predicate to the **existing** filter
builder:

```ts
args: {
  status: v.optional(v.union(v.literal("open"), v.literal("pending"), v.literal("closed"))),
  assignment: v.optional(v.union(v.literal("mine"), v.literal("unassigned"))), // NEW
  paginationOpts: paginationOptsValidator,
},
handler: async (ctx, args) => {
  const { status, assignment, paginationOpts } = args;
  const scope = conversationScope(ctx.role);
  const base = ctx.db.query("conversations")
    .withIndex("by_account_last_message", (q) => q.eq("accountId", ctx.accountId))
    .order("desc");

  const query =
    status || assignment || scope !== "all"   // `|| assignment` is the new gate term
      ? base.filter((q) => {
          const parts = [];
          if (status) parts.push(q.eq(q.field("status"), status));
          if (scope === "own_and_pool") {
            parts.push(q.or(
              q.eq(q.field("assignedToUserId"), ctx.userId),
              q.eq(q.field("assignedToUserId"), undefined),
            ));
          } else if (scope === "unassigned") {
            parts.push(q.eq(q.field("assignedToUserId"), undefined));
          }
          // NEW — assignment tab narrows within the role scope:
          if (assignment === "mine") {
            parts.push(q.eq(q.field("assignedToUserId"), ctx.userId));
          } else if (assignment === "unassigned") {
            parts.push(q.eq(q.field("assignedToUserId"), undefined));
          }
          return parts.reduce((a, b) => q.and(a, b));
        })
      : base;
  // …paginate + embedContact unchanged…
}
```

**"Mine" resolves against `ctx.userId` server-side** — the client never sends a
user id for filtering. `All` = omit the arg (existing behavior, existing callers
and the REST API `apiV1` are untouched). `parts` is never empty inside the
filter branch, so `reduce` is safe.

Composition is correct for every role (AND of scope × tab):

| Role (scope) | All | Mine | Unassigned |
|---|---|---|---|
| owner/admin/supervisor (`all`) | everything | assigned to me | the pool |
| agent (`own_and_pool`) | mine + pool | assigned to me | the pool |
| viewer (`unassigned`) | the pool | ∅ (pool ∧ mine) | the pool |

The viewer × Mine empty set is harmless.

### 2. Page — `src/app/(dashboard)/inbox/page.tsx`

```ts
type AssignmentTab = "all" | "mine" | "unassigned";
const [assignment, setAssignment] = useState<AssignmentTab>("all");

const conv = usePaginatedQuery(
  api.conversations.list,
  { assignment: assignment === "all" ? undefined : assignment },
  { initialNumItems: 30 },
);
```

Pass `assignment` and `onAssignmentChange={setAssignment}` into `<ConversationList>`.
Changing the tab changes the query args, which resets the Convex paginated
subscription — each tab paginates its own set. The cached-query provider already
smooths the re-subscribe.

### 3. List — `src/components/inbox/conversation-list.tsx`

- **New props:** `assignment: AssignmentTab`, `onAssignmentChange: (t: AssignmentTab) => void`.
- **Tab bar:** a 3-item segmented control rendered at the top of the list header,
  **below `<OwnSpendLine />`, above the search box**. Reuse the existing
  active/inactive idiom (`text-primary` active vs `text-muted-foreground`) so it
  matches the current filter styling — no new colors, no layout shift to rows.
- **Empty state:** tab-aware copy ("No chats assigned to you yet" for Mine, "No
  unassigned chats" for Unassigned, existing generic text for All).
- **Per-row indicator (row chip):** reuse the pattern already in
  `message-thread.tsx` — `useQuery(api.members.list)` mapped via
  `toUiMemberProfile`, into a `Map<user_id, Profile>`. `api.members.list` is
  already loaded by the inbox thread and carries denormalized `fullName` /
  `avatarUrl`, so this adds no new backend query.
  - `assigned_agent_id == null` → subtle "Unassigned" marker (muted).
  - `assigned_agent_id == useAuth().user.id` → "You" chip (primary tint).
  - else → teammate's avatar/initial + name (muted), name shown on the chip /
    via `title`.
  - The chip is compact and right-aligned in the row, consistent with the
    existing unread-count / status-dot cluster.

The existing client-side status / tags / company / search filters continue to
apply *on top of* the server-filtered page, unchanged. Assignment (which bucket)
and status/tags (refinements within it) are independent axes.

### 4. i18n

Add keys to the `Inbox.conversationList` namespace in **every** locale file
(this repo has had i18n-parity regressions, so all locales get the keys, not
just English):

- `tabAll`, `tabMine`, `tabUnassigned`
- `assignedToYou` (chip), `unassigned` (chip / empty)
- `emptyMine`, `emptyUnassigned` (tab-aware empty states)

## Edge cases

- **Reactive move-on-assign:** assigning a chat patches `assignedToUserId`;
  Convex pushes the update, so the row leaves *Unassigned* and appears under
  *Mine* automatically, no refresh. (This is the "when we assign, it should move"
  behavior from the request.)
- **Deep link `?c=<id>`:** if a deep-linked chat is not in the active tab's set,
  selection still works (the thread loads via `conversations.get`, which is not
  tab-scoped). Acceptable; no special handling.
- **Viewer role:** Mine is empty (see table). Tabs still render; harmless.
- **Masked-phone rows:** unaffected — the chip reads `assigned_agent_id`, not the
  contact phone.

## Testing

- **Unit (server):** extend the Convex query test coverage for
  `conversations.list` — assert the returned set for each `(role × assignment)`
  pair, including the viewer × Mine empty case and that `All` (omitted arg)
  equals today's behavior. Follow the existing convex test harness pattern.
- **Full suite** stays green (`npm test`, baseline 1406 passing).
- **Manual (preview):** drive the real inbox — switch tabs, assign a pool chat
  and watch it move Unassigned → Mine, confirm the row chip renders for
  self/teammate/unassigned, confirm existing search/status/tags still work.

## Files touched

- `convex/conversations.ts` (list: +1 arg, +1 predicate, +1 gate term)
- `src/app/(dashboard)/inbox/page.tsx` (tab state + query arg + 2 props)
- `src/components/inbox/conversation-list.tsx` (tab bar + row chip + empty states)
- `messages/*` locale files (new `Inbox.conversationList` keys)
- Convex query test file for `conversations.list`

## Rollback

Purely additive. Reverting the branch restores the current single-list inbox with
no data migration (no schema change — `assignedToUserId` already exists).
