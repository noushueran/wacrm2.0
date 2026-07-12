# Inbox Assignment Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `All · Mine · Unassigned` tab bar to the inbox chat list that filters conversations server-side, plus a per-row assignee chip.

**Architecture:** The inbox page already owns the paginated `conversations.list` query. Add an optional `assignment` arg to that query (one AND-composed predicate in the existing filter builder), lift a tab-state to the page, and render a tab bar + assignee chip in the list component. "Mine" resolves against the authenticated `ctx.userId` server-side; the assignee chip reuses the already-loaded `api.members.list`.

**Tech Stack:** Next.js (custom build — see `wacrm2.0/AGENTS.md`), Convex (self-hosted), convex-test + vitest, next-intl (single `messages/en.json`), Tailwind.

## Global Constraints

- Base: worktree `worktree-inbox-assignment-tabs` @ `origin/main` `7cf629f`. Baseline: **1406 tests passing**.
- No schema change — `conversations.assignedToUserId` already exists.
- Purely additive; do not restyle or remove any existing control (search, status filter, tags, company). `All` tab must reproduce today's default view exactly.
- `assignment` values are the string literals `"mine"` | `"unassigned"`; `"all"` = omit the arg.
- Server filter must AND-compose with the existing role `conversationScope` (never widen a role's visibility).
- i18n: add every new user-facing string to `messages/en.json` under `Inbox.conversationList` (single locale — no other files).
- Run commands from the worktree root: `/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0/.claude/worktrees/inbox-assignment-tabs`.
- Convex test target: `npx vitest run --project convex convex/conversations.test.ts`. Src test target: `npx vitest run --project src <file>`.

---

### Task 1: Server — optional `assignment` filter on `conversations.list`

**Files:**
- Modify: `convex/conversations.ts` (the `list` query, ~lines 90-137)
- Test: `convex/conversations.test.ts` (append after the "list scopes conversations by role" test at ~line 1559)

**Interfaces:**
- Produces: `api.conversations.list` gains optional arg `assignment?: "mine" | "unassigned"`. Omitted = unchanged behavior. Filters within the caller's role scope: `mine` → `assignedToUserId === ctx.userId`; `unassigned` → `assignedToUserId === undefined`.

- [ ] **Step 1: Write the failing test**

Append to `convex/conversations.test.ts`:

```ts
test("list filters by the assignment tab within the role scope", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });

  await seedConv(t, accountId, { phone: "111", name: "Mine", assignedToUserId: a.userId });
  await seedConv(t, accountId, { phone: "222", name: "Pool" });
  await seedConv(t, accountId, { phone: "333", name: "Bees", assignedToUserId: b.userId });

  // Agent "Mine" → only their own assigned chat.
  const aMine = await a.asUser.query(api.conversations.list, { assignment: "mine", ...onePage });
  expect(aMine.page.map((c) => c.contact?.name)).toEqual(["Mine"]);

  // Agent "Unassigned" → the pool only.
  const aPool = await a.asUser.query(api.conversations.list, { assignment: "unassigned", ...onePage });
  expect(aPool.page.map((c) => c.contact?.name)).toEqual(["Pool"]);

  // Supervisor "Mine" → owns none.
  const sMine = await s.asUser.query(api.conversations.list, { assignment: "mine", ...onePage });
  expect(sMine.page).toHaveLength(0);

  // Supervisor "Unassigned" → the pool only (not Bees, not Mine).
  const sPool = await s.asUser.query(api.conversations.list, { assignment: "unassigned", ...onePage });
  expect(sPool.page.map((c) => c.contact?.name)).toEqual(["Pool"]);

  // Supervisor, no assignment arg → unchanged: sees all three.
  const sAll = await s.asUser.query(api.conversations.list, onePage);
  expect(sAll.page).toHaveLength(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project convex convex/conversations.test.ts -t "assignment tab"`
Expected: FAIL — `ArgumentValidationError` (the `assignment` arg is not in the validator yet).

- [ ] **Step 3: Write minimal implementation**

In `convex/conversations.ts`, edit the `list` query. Add the arg to the validator:

```ts
  args: {
    status: v.optional(
      v.union(v.literal("open"), v.literal("pending"), v.literal("closed")),
    ),
    assignment: v.optional(
      v.union(v.literal("mine"), v.literal("unassigned")),
    ),
    paginationOpts: paginationOptsValidator,
  },
```

Destructure it and add it to the gate + the filter builder:

```ts
  handler: async (ctx, args) => {
    const { status, assignment, paginationOpts } = args;
    const scope = conversationScope(ctx.role);

    const base = ctx.db
      .query("conversations")
      .withIndex("by_account_last_message", (q) =>
        q.eq("accountId", ctx.accountId),
      )
      .order("desc");

    const query =
      status || assignment || scope !== "all"
        ? base.filter((q) => {
            const parts = [];
            if (status) parts.push(q.eq(q.field("status"), status));
            if (scope === "own_and_pool") {
              parts.push(
                q.or(
                  q.eq(q.field("assignedToUserId"), ctx.userId),
                  q.eq(q.field("assignedToUserId"), undefined),
                ),
              );
            } else if (scope === "unassigned") {
              parts.push(q.eq(q.field("assignedToUserId"), undefined));
            }
            // Assignment tab — narrows within the role scope above.
            if (assignment === "mine") {
              parts.push(q.eq(q.field("assignedToUserId"), ctx.userId));
            } else if (assignment === "unassigned") {
              parts.push(q.eq(q.field("assignedToUserId"), undefined));
            }
            return parts.reduce((a, b) => q.and(a, b));
          })
        : base;

    const result = await query.paginate(paginationOpts);
    const page = await Promise.all(
      result.page.map((conversation) => embedContact(ctx, conversation)),
    );
    return { ...result, page };
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project convex convex/conversations.test.ts -t "assignment tab"`
Expected: PASS.

- [ ] **Step 5: Run the whole conversations suite (no regressions)**

Run: `npx vitest run --project convex convex/conversations.test.ts`
Expected: all tests PASS (existing + the new one).

- [ ] **Step 6: Commit**

```bash
git add convex/conversations.ts convex/conversations.test.ts
git commit -m "feat(inbox): add optional assignment filter to conversations.list

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Client — pure `resolveAssignee` helper (assignee chip logic)

**Files:**
- Modify: `src/lib/inbox/conversations.ts` (append the helper + type)
- Test: `src/lib/inbox/conversations.test.ts` (append)

**Interfaces:**
- Produces: `resolveAssignee(conversation, currentUserId, profilesById): AssigneeDisplay` where
  `AssigneeDisplay = { kind: "unassigned" } | { kind: "you" } | { kind: "other"; name: string; avatarUrl?: string }`.
  `profilesById` is a `Map<string, { full_name: string | null; avatar_url?: string | null }>` keyed by `user_id`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/inbox/conversations.test.ts`:

```ts
import { resolveAssignee } from "./conversations";

describe("resolveAssignee", () => {
  const profiles = new Map([
    ["u-b", { full_name: "Bob", avatar_url: "http://x/bob.png" }],
    ["u-c", { full_name: null, avatar_url: null }],
  ]);

  it("returns unassigned when there is no assignee", () => {
    expect(resolveAssignee({ assigned_agent_id: undefined }, "u-a", profiles)).toEqual({
      kind: "unassigned",
    });
  });

  it("returns 'you' when assigned to the current user", () => {
    expect(resolveAssignee({ assigned_agent_id: "u-a" }, "u-a", profiles)).toEqual({
      kind: "you",
    });
  });

  it("returns the teammate's name + avatar when assigned to someone else", () => {
    expect(resolveAssignee({ assigned_agent_id: "u-b" }, "u-a", profiles)).toEqual({
      kind: "other",
      name: "Bob",
      avatarUrl: "http://x/bob.png",
    });
  });

  it("falls back to 'Assigned' when the teammate has no name / is not in the roster", () => {
    expect(resolveAssignee({ assigned_agent_id: "u-c" }, "u-a", profiles)).toEqual({
      kind: "other",
      name: "Assigned",
      avatarUrl: undefined,
    });
    expect(resolveAssignee({ assigned_agent_id: "u-z" }, "u-a", profiles)).toEqual({
      kind: "other",
      name: "Assigned",
      avatarUrl: undefined,
    });
  });
});
```

Confirm `src/lib/inbox/conversations.test.ts` already imports `describe`/`it`/`expect` from vitest; if it uses `test` instead of `it`, match the existing file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project src src/lib/inbox/conversations.test.ts -t "resolveAssignee"`
Expected: FAIL — `resolveAssignee` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/inbox/conversations.ts`:

```ts
export type AssigneeDisplay =
  | { kind: "unassigned" }
  | { kind: "you" }
  | { kind: "other"; name: string; avatarUrl?: string };

/**
 * Resolves how a conversation's assignee should render in the list row.
 * `profilesById` is keyed by `user_id` (from `api.members.list` mapped
 * through `toUiMemberProfile`). Falls back to the label "Assigned" when the
 * assignee has no name or is not in the roster.
 */
export function resolveAssignee(
  conversation: Pick<Conversation, "assigned_agent_id">,
  currentUserId: string | null | undefined,
  profilesById: Map<string, { full_name: string | null; avatar_url?: string | null }>,
): AssigneeDisplay {
  const id = conversation.assigned_agent_id;
  if (!id) return { kind: "unassigned" };
  if (currentUserId && id === currentUserId) return { kind: "you" };
  const p = profilesById.get(id);
  return {
    kind: "other",
    name: p?.full_name ?? "Assigned",
    avatarUrl: p?.avatar_url ?? undefined,
  };
}
```

(The existing file already imports `Conversation` from `@/types`; reuse it. If not, add `import type { Conversation } from "@/types";`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project src src/lib/inbox/conversations.test.ts -t "resolveAssignee"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inbox/conversations.ts src/lib/inbox/conversations.test.ts
git commit -m "feat(inbox): add resolveAssignee helper for the list row chip

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Client — tab bar, row chip, empty states, and page wiring

**Files:**
- Modify: `messages/en.json` (`Inbox.conversationList` block, ~lines 148-162)
- Modify: `src/app/(dashboard)/inbox/page.tsx` (tab state + query arg + 2 props)
- Modify: `src/components/inbox/conversation-list.tsx` (props, tab bar, row chip, empty states)

**Interfaces:**
- Consumes: `resolveAssignee` / `AssigneeDisplay` (Task 2); `api.conversations.list` `assignment` arg (Task 1); `useAuth().user`, `api.members.list`, `toUiMemberProfile`.
- Produces: `ConversationList` gains props `assignment: AssignmentTab` and `onAssignmentChange: (t: AssignmentTab) => void`, where `AssignmentTab = "all" | "mine" | "unassigned"`.

- [ ] **Step 1: Add i18n keys**

In `messages/en.json`, extend the `Inbox.conversationList` object (keep existing keys; add these):

```json
      "tabAll": "All",
      "tabMine": "Mine",
      "tabUnassigned": "Unassigned",
      "assignedToYou": "You",
      "emptyMine": "No chats assigned to you yet",
      "emptyUnassigned": "No unassigned chats"
```

- [ ] **Step 2: Wire tab state in the page**

In `src/app/(dashboard)/inbox/page.tsx`:

Add the type + state near the other `useState` calls (after `activeConversationId`):

```ts
  type AssignmentTab = "all" | "mine" | "unassigned";
  const [assignment, setAssignment] = useState<AssignmentTab>("all");
```

Change the paginated query args from `{}` to the assignment arg:

```ts
  const conv = usePaginatedQuery(
    api.conversations.list,
    { assignment: assignment === "all" ? undefined : assignment },
    { initialNumItems: 30 },
  );
```

Pass the two new props into `<ConversationList ...>`:

```tsx
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            conversations={conversations}
            loadMore={conv.loadMore}
            status={conv.status}
            assignment={assignment}
            onAssignmentChange={setAssignment}
          />
```

- [ ] **Step 3: Add props, imports, and derived data to `conversation-list.tsx`**

Add imports at the top:

```ts
import { useAuth } from "@/hooks/use-auth";
import { toUiTag, toUiMemberProfile } from "@/lib/convex/adapters";
import { matchesContactFilters, resolveAssignee } from "@/lib/inbox/conversations";
import type { AssigneeDisplay } from "@/lib/inbox/conversations";
```

(Replace the existing `toUiTag`-only and `matchesContactFilters`-only imports with the merged forms above; keep `Profile` available via `@/types` — add it to the existing `import type { Conversation, ConversationStatus, Tag } from "@/types";` line → `Conversation, ConversationStatus, Tag, Profile`.)

Extend the props type and signature:

```ts
export type AssignmentTab = "all" | "mine" | "unassigned";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  loadMore: (numItems: number) => void;
  status: PaginationStatus;
  assignment: AssignmentTab;
  onAssignmentChange: (tab: AssignmentTab) => void;
}
```

Add `assignment, onAssignmentChange` to the destructured params.

Inside the component, add the current user + roster map (near the `tagDocs` query):

```ts
  const { user } = useAuth();
  const memberDocs = useQuery(api.members.list);
  const profilesById = useMemo(() => {
    const m = new Map<string, Profile>();
    for (const doc of memberDocs ?? []) {
      const p = toUiMemberProfile(doc);
      m.set(p.user_id, p);
    }
    return m;
  }, [memberDocs]);
```

Add the tab definitions (near `FILTER_OPTIONS`):

```ts
  const ASSIGNMENT_TABS: { label: string; value: AssignmentTab }[] = useMemo(() => [
    { label: t("tabAll"), value: "all" },
    { label: t("tabMine"), value: "mine" },
    { label: t("tabUnassigned"), value: "unassigned" },
  ], [t]);
```

- [ ] **Step 4: Render the tab bar**

In the returned JSX, insert the tab bar **immediately after `<OwnSpendLine />` and before the `{/* Search + Filter */}` block**:

```tsx
      {/* Assignment tabs — which bucket of chats to show. A separate axis
          from the status/tags filters below. Server-filtered via the
          page's `assignment` query arg. */}
      <div className="flex items-center gap-1 border-b border-border p-2">
        {ASSIGNMENT_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => onAssignmentChange(tab.value)}
            className={cn(
              "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              assignment === tab.value
                ? "bg-muted text-primary"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
```

- [ ] **Step 5: Make the empty state tab-aware**

Replace the empty-state paragraph inside the `ScrollArea`:

```tsx
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {assignment === "mine"
                ? t("emptyMine")
                : assignment === "unassigned"
                  ? t("emptyUnassigned")
                  : t("noConversations")}
            </p>
          </div>
```

- [ ] **Step 6: Pass the resolved assignee into each row and render the chip**

In the `filtered.map(...)`, compute and pass the assignee:

```tsx
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                assignee={resolveAssignee(conv, user?.id, profilesById)}
                t={t}
              />
            ))}
```

Extend `ConversationItemProps` and the component with the chip. Add `assignee: AssigneeDisplay` to the props, and render the chip in the right-aligned cluster (next to the unread badge / status dot):

```tsx
          <div className="flex shrink-0 items-center gap-1.5">
            {assignee.kind !== "unassigned" && (
              <span
                title={assignee.kind === "you" ? t("assignedToYou") : assignee.name}
                className={cn(
                  "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  assignee.kind === "you"
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {assignee.kind === "you"
                  ? t("assignedToYou")
                  : assignee.name.charAt(0).toUpperCase()}
              </span>
            )}
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn("h-2 w-2 rounded-full", STATUS_COLORS[conversation.status])}
              title={conversation.status}
            />
          </div>
```

- [ ] **Step 7: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (Fix any unused-import / type mismatches surfaced.)

- [ ] **Step 8: Full test suite (no regressions)**

Run: `npm test`
Expected: all pass (baseline 1406 + the 2 new tests from Tasks 1-2).

- [ ] **Step 9: Manual verification in the preview**

Start the dev server and drive the real inbox (see "Verification" below). Confirm: three tabs render; switching to Mine/Unassigned re-queries and shows the correct bucket with working "Load more"; assigning a pool chat from the thread moves it Unassigned → Mine live; the row chip shows "You" for own chats and a teammate initial for others; existing search/status/tags/company still work; `All` looks identical to today.

- [ ] **Step 10: Commit**

```bash
git add messages/en.json "src/app/(dashboard)/inbox/page.tsx" src/components/inbox/conversation-list.tsx
git commit -m "feat(inbox): All/Mine/Unassigned tabs + per-row assignee chip

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Verification (manual, Task 3 Step 9)

- Use the preview tooling to start `next dev` and open `/inbox`.
- Because the seeded/prod data + WhatsApp auth is involved, if the preview can't authenticate, fall back to verifying via the component in isolation and rely on the server unit test (Task 1) for the filtering correctness.
- Capture a screenshot of the three tabs and the row chip for the completion report.

## Self-Review

- **Spec coverage:** tabs (T3), server-side complete-set filtering (T1), row chip (T2+T3), empty states (T3), i18n (T3), reactive move-on-assign (inherent — assignment patch → Convex push → row re-buckets; verified in T3 S9). ✓
- **Placeholder scan:** none — every step has concrete code/commands. ✓
- **Type consistency:** `AssignmentTab` defined in both page (local) and `conversation-list.tsx` (exported) with identical members — page imports are structural (string-literal union), so the duplicate literal is safe; if preferred, the page can `import type { AssignmentTab }` from the list component. `AssigneeDisplay` / `resolveAssignee` signatures match between Task 2 (definition) and Task 3 (consumption). ✓
- **Scope:** single feature, 3 tasks, each independently testable (T1 convex test, T2 src test, T3 typecheck+preview). ✓
