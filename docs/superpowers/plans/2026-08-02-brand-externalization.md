# Brand Externalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every hardcoded company identity string out of the source and into environment
variables, so one codebase can serve both Amani and Holidayys.

**Architecture:** Two small modules — `src/lib/brand.ts` for the Next.js runtime and
`convex/lib/brand.ts` for the Convex runtime — each reading its own environment and **throwing on
a missing value rather than falling back**. Thirteen files stop naming a company and read from
these instead. Nothing else changes: no behaviour, no data, no schema.

**Tech Stack:** TypeScript, Next.js (App Router), Convex, vitest 4.

**Parent spec:** `docs/superpowers/specs/2026-08-02-crm-codebase-unification-design.md`

## Global Constraints

- **No default values, ever.** A missing variable throws. Quoting the spec: *"With one shared repo
  that fallback is how Holidayys ships wearing Amani's name."* This is the one behavioural change
  the work introduces and it is deliberate.
- **Reference every `NEXT_PUBLIC_*` variable by its literal name.** Next.js inlines these into the
  client bundle by *static text substitution*. `readEnv("NEXT_PUBLIC_BRAND_NAME")` with a variable
  key is `undefined` in the browser even when the value is set at build time. Always
  `process.env.NEXT_PUBLIC_BRAND_NAME` written out in full.
- **No test may hardcode either company name.** Tests assert against values they set themselves.
- **This repo has no jsdom.** Component tests are static renders; any logic worth testing lives in
  a pure module. (`vitest.config.ts` — `src` and `convex` projects, `node` and `edge-runtime`.)
- **`NEXT_PUBLIC_R2_PUBLIC_HOST` is already externalized** (`src/lib/storage/media-url.ts`). Do not
  duplicate it into the brand module; it is media infrastructure, not identity.
- Run tests with `npx vitest run --project=src` / `--project=convex`.
- Commit after every task. Stage paths explicitly — never `git add -A`; this tree has unrelated
  work in progress.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/brand.ts` | **Create.** Next.js-side identity. Reads 5 `NEXT_PUBLIC_*` vars, throws on any missing, derives `PRODUCT_NAME`. |
| `src/lib/brand.test.ts` | **Create.** Pins the throw-on-missing contract and the derivation. |
| `convex/lib/brand.ts` | **Create.** Convex-side identity. Reads 2 Convex env vars (no `NEXT_PUBLIC_` prefix — Convex has its own environment). |
| `convex/lib/brand.test.ts` | **Create.** Same contract, Convex runtime. |
| `vitest.config.ts` | **Modify.** Add brand vars to `test.env` so suites run without a real deployment, alongside the existing `ENCRYPTION_KEY` precedent. |
| `.env.local.example` | **Modify.** Document the 5 new variables. |
| 7 files under `src/` | **Modify.** Next.js consumers (Task 2). |
| 7 files under `convex/` | **Modify.** Convex consumers (Task 4) — five carrying live strings, two comment-only for conflict removal. One (`password.ts`) is conditional; see the task's precondition. |
| `convex/lib/qualification/defaults.ts` + `convex/qualification.ts` | **Modify.** Rename the seed function off the company name (Task 5). |

Two modules rather than one because the runtimes have genuinely different environments: Next.js
reads build-time `NEXT_PUBLIC_*`, Convex reads deployment env set on the Convex instance. A shared
module would have to satisfy both and would leak the wrong variable names into each.

---

### Task 1: The Next.js brand module

**Files:**
- Create: `src/lib/brand.ts`
- Create: `src/lib/brand.test.ts`
- Modify: `vitest.config.ts:14-19` (the `test.env` block)
- Modify: `.env.local.example` (append a new section)

**Interfaces:**
- Consumes: nothing.
- Produces: `BRAND` — a frozen object with `name: string`, `legalName: string`, `siteUrl: string`,
  `website: string`, `email: string`. And `PRODUCT_NAME: string`, equal to `` `${BRAND.name} WA CRM` ``.
  Tasks 2 imports both from `@/lib/brand`.

- [ ] **Step 1: Add brand vars to the vitest environment**

Without this every suite that transitively imports `brand.ts` throws at module load. This mirrors
how `ENCRYPTION_KEY` is already handled in the same block.

In `vitest.config.ts`, inside `test.env`, after the `META_APP_SECRET` line:

```ts
      // Brand identity — `src/lib/brand.ts` and `convex/lib/brand.ts`
      // throw on a missing value BY DESIGN (a fallback is how one
      // company's CRM ships wearing another's name), so the suites must
      // supply their own. Deliberately a nonsense company: a test that
      // passes only because the value happens to be the real brand is a
      // test that will pass in the wrong repo too.
      NEXT_PUBLIC_BRAND_NAME: "Testco",
      NEXT_PUBLIC_BRAND_LEGAL_NAME: "Testco Holdings LLC",
      NEXT_PUBLIC_SITE_URL: "https://wa.testco.example",
      NEXT_PUBLIC_BRAND_WEBSITE: "https://testco.example",
      NEXT_PUBLIC_BRAND_EMAIL: "hello@testco.example",
      BRAND_NAME: "Testco",
      BRAND_SITE_URL: "https://wa.testco.example",
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/brand.test.ts`. The `vi.resetModules()` + dynamic `await import()` shape is the
established convention for env-dependent module-load behaviour in this repo — see
`src/lib/storage/media-url.test.ts`.

```ts
import { expect, test, vi, beforeEach, afterEach } from "vitest";

const KEYS = [
  "NEXT_PUBLIC_BRAND_NAME",
  "NEXT_PUBLIC_BRAND_LEGAL_NAME",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_BRAND_WEBSITE",
  "NEXT_PUBLIC_BRAND_EMAIL",
] as const;

const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  process.env.NEXT_PUBLIC_BRAND_NAME = "Testco";
  process.env.NEXT_PUBLIC_BRAND_LEGAL_NAME = "Testco Holdings LLC";
  process.env.NEXT_PUBLIC_SITE_URL = "https://wa.testco.example";
  process.env.NEXT_PUBLIC_BRAND_WEBSITE = "https://testco.example";
  process.env.NEXT_PUBLIC_BRAND_EMAIL = "hello@testco.example";
  vi.resetModules();
});

afterEach(() => {
  for (const key of KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

test("BRAND reads every value from the environment", async () => {
  const { BRAND } = await import("./brand");
  expect(BRAND).toEqual({
    name: "Testco",
    legalName: "Testco Holdings LLC",
    siteUrl: "https://wa.testco.example",
    website: "https://testco.example",
    email: "hello@testco.example",
  });
});

test("PRODUCT_NAME is derived from the brand name", async () => {
  const { PRODUCT_NAME } = await import("./brand");
  expect(PRODUCT_NAME).toBe("Testco WA CRM");
});

// The whole point of the module. A default here is how one company's CRM
// ships wearing another company's name.
test.each(KEYS)("a missing %s throws rather than defaulting", async (key) => {
  delete process.env[key];
  vi.resetModules();
  await expect(import("./brand")).rejects.toThrow(key);
});

test("a whitespace-only value is treated as missing", async () => {
  process.env.NEXT_PUBLIC_BRAND_NAME = "   ";
  vi.resetModules();
  await expect(import("./brand")).rejects.toThrow("NEXT_PUBLIC_BRAND_NAME");
});

test("surrounding whitespace is trimmed off a good value", async () => {
  process.env.NEXT_PUBLIC_BRAND_NAME = "  Testco  ";
  vi.resetModules();
  const { BRAND, PRODUCT_NAME } = await import("./brand");
  expect(BRAND.name).toBe("Testco");
  expect(PRODUCT_NAME).toBe("Testco WA CRM");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --project=src src/lib/brand.test.ts`
Expected: FAIL — every test errors resolving `./brand` (the module does not exist yet).

- [ ] **Step 4: Write the module**

Create `src/lib/brand.ts`:

```ts
/**
 * Company identity for this deployment.
 *
 * One codebase serves two companies (Amani and Holidayys), which differ
 * only in identity — see
 * `docs/superpowers/specs/2026-08-02-crm-codebase-unification-design.md`.
 * Everything a customer or agent sees the company's name in reads it from
 * here; nothing in `src/` should ever spell a company out.
 *
 * NOTHING HERE HAS A DEFAULT, deliberately. A fallback would mean a
 * deployment with a missing variable renders as the *other* company
 * rather than failing — silently, in production, on the invite page a
 * customer is looking at. Failing the build is the cheaper outcome.
 *
 * Company DATA (knowledge base, WhatsApp config, pipelines, services) is
 * not here and never will be: it lives in each deployment's Convex
 * database, per account.
 */

/** Throws unless `value` carries something. `name` is passed separately so
 *  the error can say which variable is missing — the caller cannot derive
 *  it, because `process.env.X` is a static substitution, not a lookup. */
function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `${name} is not set. Every deployment declares its own company identity — ` +
        `see .env.local.example. There is deliberately no default: a fallback here ` +
        `is how one company's CRM ships wearing another company's name.`,
    );
  }
  return trimmed;
}

/**
 * Each variable is written out in full below, never read through a
 * variable key. Next.js inlines `process.env.NEXT_PUBLIC_*` into the
 * client bundle by STATIC TEXT SUBSTITUTION at build time, so a dynamic
 * lookup (`process.env[key]`) compiles to `undefined` in the browser even
 * when the value is set. The repetition is load-bearing.
 */
export const BRAND = Object.freeze({
  /** Short name: "Amani". Used in titles, the PWA name, the OG card. */
  name: required(process.env.NEXT_PUBLIC_BRAND_NAME, "NEXT_PUBLIC_BRAND_NAME"),
  /** Registered entity: "Amani Tourism & Travel LLC". Used where the legal
   *  entity is named rather than the brand — descriptions, the OG footer. */
  legalName: required(
    process.env.NEXT_PUBLIC_BRAND_LEGAL_NAME,
    "NEXT_PUBLIC_BRAND_LEGAL_NAME",
  ),
  /** This CRM's own origin: "https://wa.amaniworld.com". Already consumed by
   *  `src/app/layout.tsx`'s `metadataBase`, which is why it keeps its
   *  existing name rather than gaining a `BRAND_` prefix. */
  siteUrl: required(process.env.NEXT_PUBLIC_SITE_URL, "NEXT_PUBLIC_SITE_URL"),
  /** The company's public marketing site — NOT this CRM. Used in settings
   *  placeholders so an owner sees a plausible example. */
  website: required(
    process.env.NEXT_PUBLIC_BRAND_WEBSITE,
    "NEXT_PUBLIC_BRAND_WEBSITE",
  ),
  /** Public contact address, same purpose as `website`. */
  email: required(
    process.env.NEXT_PUBLIC_BRAND_EMAIL,
    "NEXT_PUBLIC_BRAND_EMAIL",
  ),
});

/**
 * "<Brand> WA CRM" — the product name in browser titles, the web app
 * manifest and push notifications.
 *
 * Derived rather than its own variable: the suffix is the product, not the
 * company, and is identical for every tenant. A sixth variable would only
 * add a way for the two deployments to disagree about what the software is
 * called.
 */
export const PRODUCT_NAME = `${BRAND.name} WA CRM`;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project=src src/lib/brand.test.ts`
Expected: PASS — 9 tests (3 named + 5 from `test.each` + 1 whitespace-trim).

- [ ] **Step 6: Document the variables**

Append to `.env.local.example`:

```
# ============================================================
# BRAND — this deployment's company identity.
# ============================================================
# One codebase serves two companies; these are the only things that
# differ. Read by `src/lib/brand.ts`, which THROWS if any is missing —
# there are deliberately no defaults, because a fallback is how one
# company's CRM would ship wearing the other's name.
#
# Company DATA (knowledge base, WhatsApp config, pipelines) is not here:
# it lives in this deployment's Convex database, per account.

# Short brand name. Appears in the browser title, the installed PWA name
# and the invite card. Titles are built as "<name> WA CRM".
NEXT_PUBLIC_BRAND_NAME=Amani

# Registered legal entity, used where the company is named formally.
NEXT_PUBLIC_BRAND_LEGAL_NAME=Amani Tourism & Travel LLC

# The company's public marketing site — NOT this CRM. Shown as an example
# in Settings → Lead qualification.
NEXT_PUBLIC_BRAND_WEBSITE=https://amaniworld.com

# Public contact address, same purpose as the website above.
NEXT_PUBLIC_BRAND_EMAIL=hello@amaniworld.com

# NOTE: NEXT_PUBLIC_SITE_URL (this CRM's own origin) is the fifth brand
# value and is already documented above — `brand.ts` reads it too.
```

- [ ] **Step 7: Run the full src suite**

Run: `npx vitest run --project=src`
Expected: PASS. No existing test should break — nothing imports `brand.ts` yet.

- [ ] **Step 8: Commit**

```bash
git add src/lib/brand.ts src/lib/brand.test.ts vitest.config.ts .env.local.example
git commit -m "feat(brand): read the Next.js company identity from the environment

One codebase will serve both Amani and Holidayys, which differ only in
identity. This is the module every user-visible mention of the company
will read from; the consumers move over next.

Nothing here has a default, deliberately. A fallback would mean a
deployment with a missing variable renders as the OTHER company rather
than failing — silently, in production, on a page a customer is looking
at. Failing the build is the cheaper outcome, so a missing value throws
and the suite pins that for all five.

Each variable is written out in full rather than read through a key:
Next.js inlines NEXT_PUBLIC_* into the client bundle by static text
substitution, so a dynamic lookup is undefined in the browser even when
the value is set at build time."
```

---

### Task 2: Wire the Next.js consumers

**Files:**
- Modify: `src/app/layout.tsx:32-52`
- Modify: `src/app/manifest.ts:7-8`
- Modify: `src/app/join/layout.tsx:33-59`
- Modify: `src/app/(auth)/signup/page.tsx:127`
- Modify: `src/components/settings/invite-member-dialog.tsx:139,171`
- Modify: `src/components/og/invite-card.tsx:29,75,111`
- Modify: `src/components/settings/qualification-settings.tsx:345,353,362`

**Interfaces:**
- Consumes: `BRAND`, `PRODUCT_NAME` from `@/lib/brand` (Task 1).
- Produces: nothing new. After this task, `grep -riE 'amani' src --include='*.tsx' --include='*.ts'`
  returns only comments and test fixtures.

- [ ] **Step 1: Root layout**

In `src/app/layout.tsx`, add to the imports (after the `@/lib/themes` block, line 18):

```ts
import { BRAND, PRODUCT_NAME } from "@/lib/brand";
```

Replace lines 32-39 (`metadataBase` through `description`) with:

```ts
  metadataBase: new URL(BRAND.siteUrl),
  title: {
    default: PRODUCT_NAME,
    template: `%s — ${PRODUCT_NAME}`,
  },
  description: `Internal WhatsApp CRM for ${BRAND.legalName} — shared inbox, contacts, pipelines, broadcasts, and automations.`,
```

Note the `??` fallback on `metadataBase` is gone: `BRAND.siteUrl` already threw if unset, so the
fallback had nothing left to do.

Then replace line 50:

```ts
    title: BRAND.name,
```

- [ ] **Step 2: Web app manifest**

In `src/app/manifest.ts`, add after the `next` import:

```ts
import { BRAND, PRODUCT_NAME } from "@/lib/brand";
```

Replace lines 7-8:

```ts
    name: PRODUCT_NAME,
    short_name: BRAND.name,
```

- [ ] **Step 3: Join page metadata**

In `src/app/join/layout.tsx`, add after the `ReactNode` import:

```ts
import { BRAND, PRODUCT_NAME } from '@/lib/brand';
```

Replace line 36 (`description`):

```ts
    `Accept your invitation to join your team on ${PRODUCT_NAME} — the shared WhatsApp inbox, contacts, and pipelines for ${BRAND.legalName}.`,
```

Replace lines 50-51:

```ts
    siteName: PRODUCT_NAME,
    title: `You're invited to ${PRODUCT_NAME}`,
```

Replace line 59:

```ts
    title: `You're invited to ${PRODUCT_NAME}`,
```

- [ ] **Step 4: Signup page**

In `src/app/(auth)/signup/page.tsx`, add `import { PRODUCT_NAME } from "@/lib/brand";` to the
imports, then replace line 127:

```tsx
              : `Get started with ${PRODUCT_NAME}`}
```

- [ ] **Step 5: Invite dialog**

In `src/components/settings/invite-member-dialog.tsx`, add
`import { BRAND } from '@/lib/brand';` to the imports, then replace both line 139 and line 171's
fallback string:

```ts
        accountName: account?.name ?? `our ${BRAND.name} account`,
```

```ts
    const accountName = result?.accountName ?? `our ${BRAND.name} account`;
```

- [ ] **Step 6: Invite OG card**

In `src/components/og/invite-card.tsx`, add `import { BRAND, PRODUCT_NAME } from '@/lib/brand';`
to the imports.

Replace line 29:

```ts
  `You are invited to join a team on ${PRODUCT_NAME}`;
```

Replace line 75 — the wordmark is rendered uppercase, so uppercase the brand rather than storing a
second cased copy of it:

```tsx
            {BRAND.name.toUpperCase()}
```

Replace line 111:

```tsx
          {BRAND.legalName} · Internal team access
```

- [ ] **Step 7: Settings placeholders**

In `src/components/settings/qualification-settings.tsx`, add
`import { BRAND } from '@/lib/brand';` to the imports, then replace lines 345, 353 and 362:

```tsx
                      placeholder={BRAND.legalName}
```

```tsx
                      placeholder={BRAND.website}
```

```tsx
                      placeholder={BRAND.email}
```

- [ ] **Step 8: Verify no company name survives in `src/`**

Run:

```bash
grep -rniE 'amani' src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
```

Expected: only comment lines. Any JSX or string literal still naming the company is a miss — fix it
before continuing.

- [ ] **Step 9: Run the full src suite and the typechecker**

Run: `npx vitest run --project=src`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors. This is the step that catches a mistyped import path in a file with no test.

- [ ] **Step 10: Commit**

```bash
git add src/app/layout.tsx src/app/manifest.ts src/app/join/layout.tsx \
  "src/app/(auth)/signup/page.tsx" src/components/settings/invite-member-dialog.tsx \
  src/components/og/invite-card.tsx src/components/settings/qualification-settings.tsx
git commit -m "refactor(brand): read the company name from brand.ts across the UI

Seven files spelled the company out — the root layout and its title
template, the PWA manifest, the invite page's Open Graph tags, the OG
invite card, the signup heading, the invite dialog's fallback account
name, and three settings placeholders.

metadataBase loses its ?? fallback in the move: brand.ts has already
thrown if the site URL is unset, so the fallback had nothing left to do.

The OG wordmark uppercases the brand at the call site rather than
storing a second cased copy of the same value."
```

---

### Task 3: The Convex brand module

**Files:**
- Create: `convex/lib/brand.ts`
- Create: `convex/lib/brand.test.ts`

**Interfaces:**
- Consumes: nothing. Deliberately independent of `src/lib/brand.ts` — see below.
- Produces: `BRAND_NAME: string`, `BRAND_SITE_URL: string`, `PRODUCT_NAME: string`
  (`` `${BRAND_NAME} WA CRM` ``). Task 4 imports these from `./lib/brand` or `../lib/brand`.

Convex functions run on the Convex deployment, which has its own environment set on the instance —
not Next.js's build-time environment. The variables therefore carry no `NEXT_PUBLIC_` prefix, and
this module cannot import the Next.js one.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/brand.test.ts`:

```ts
import { expect, test, vi, beforeEach, afterEach } from "vitest";

const KEYS = ["BRAND_NAME", "BRAND_SITE_URL"] as const;
const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  process.env.BRAND_NAME = "Testco";
  process.env.BRAND_SITE_URL = "https://wa.testco.example";
  vi.resetModules();
});

afterEach(() => {
  for (const key of KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

test("brand values come from the Convex environment", async () => {
  const { BRAND_NAME, BRAND_SITE_URL, PRODUCT_NAME } = await import("./brand");
  expect(BRAND_NAME).toBe("Testco");
  expect(BRAND_SITE_URL).toBe("https://wa.testco.example");
  expect(PRODUCT_NAME).toBe("Testco WA CRM");
});

test.each(KEYS)("a missing %s throws rather than defaulting", async (key) => {
  delete process.env[key];
  vi.resetModules();
  await expect(import("./brand")).rejects.toThrow(key);
});

test("a whitespace-only value is treated as missing", async () => {
  process.env.BRAND_NAME = "  ";
  vi.resetModules();
  await expect(import("./brand")).rejects.toThrow("BRAND_NAME");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=convex convex/lib/brand.test.ts`
Expected: FAIL — cannot resolve `./brand`.

- [ ] **Step 3: Write the module**

Create `convex/lib/brand.ts`:

```ts
/**
 * Company identity, Convex side.
 *
 * The mirror of `src/lib/brand.ts` and deliberately NOT an import of it:
 * Convex functions run on the Convex deployment with its own environment,
 * set on the instance rather than baked in at Next.js build time. The
 * variables therefore carry no `NEXT_PUBLIC_` prefix, and the two runtimes
 * are configured independently — which also means they can disagree, so
 * both throw loudly rather than either one guessing.
 *
 * Only the two values Convex actually needs live here. Everything else the
 * company is called is rendered by the frontend and belongs in
 * `src/lib/brand.ts`; duplicating it would create a second place to update
 * and a second way for the two to drift.
 */

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `${name} is not set on this Convex deployment. Set it with ` +
        `\`npx convex env set ${name} <value>\`. There is deliberately no ` +
        `default: a fallback here is how one company's CRM sends push ` +
        `notifications titled with another company's name.`,
    );
  }
  return trimmed;
}

/** Short brand name: "Amani". */
export const BRAND_NAME = required(process.env.BRAND_NAME, "BRAND_NAME");

/** This CRM's own origin, used as the contact URL in the ad-context
 *  fetcher's User-Agent so a site owner seeing the hit can identify us. */
export const BRAND_SITE_URL = required(
  process.env.BRAND_SITE_URL,
  "BRAND_SITE_URL",
);

/** "<Brand> WA CRM" — matches `src/lib/brand.ts`'s derivation exactly, so
 *  a push notification and a browser tab agree on what this is called. */
export const PRODUCT_NAME = `${BRAND_NAME} WA CRM`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project=convex convex/lib/brand.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/brand.ts convex/lib/brand.test.ts
git commit -m "feat(brand): read the Convex company identity from the environment

The mirror of src/lib/brand.ts, and deliberately not an import of it:
Convex functions run on the Convex deployment with its own environment,
set on the instance rather than baked in at Next.js build time, so the
variables carry no NEXT_PUBLIC_ prefix.

Only the two values Convex actually needs — the brand name for push
notification titles, and the site URL for the ad-context fetcher's
User-Agent. Everything else the company is called is rendered by the
frontend; duplicating it here would create a second place to update."
```

---

### Task 4: Wire the Convex consumers

**Files:**
- Modify: `convex/lib/pushPayload.ts:34,60`
- Modify: `convex/adLanding.ts:46-47`
- Modify: `convex/lib/salesChecklist.ts:27`
- Modify: `convex/lib/kb/lint.ts:66`
- Modify: `convex/lib/r2/url.ts:5` (comment only — conflict removal, Step 7)
- Modify: `convex/files.ts:37` (comment only — conflict removal, Step 7)
- Modify: `convex/lib/password.ts:108-109` — **see the precondition below**

**Interfaces:**
- Consumes: `BRAND_NAME`, `BRAND_SITE_URL`, `PRODUCT_NAME` from Task 3.
- Produces: nothing new.

**Precondition — `convex/lib/password.ts` is currently UNTRACKED.** As of 2026-08-02 it and its
test are uncommitted work in progress in the Amani tree (`git status` shows them as `??`). Check
before starting:

```bash
git ls-files convex/lib/password.ts | grep . || echo "still untracked"
```

If it is still untracked, **skip Steps 5-6 and do the rest of the task**, then come back once that
work has landed. Editing an uncommitted file underneath someone means their next commit silently
carries this change. Skipping it does not block anything else here — and note it does not exist in
the Holidayys repo at all, so Task 6 will not expect it.

- [ ] **Step 1: Push notification titles**

In `convex/lib/pushPayload.ts`, add at the top of the imports:

```ts
import { PRODUCT_NAME } from "./brand";
```

Replace line 34 and line 60 — the two hidden-preview branches:

```ts
    return { title: PRODUCT_NAME, body: "New WhatsApp message", url, tag };
```

```ts
    return { title: PRODUCT_NAME, body: "New qualified lead", url, tag };
```

- [ ] **Step 2: Ad-context User-Agent**

In `convex/adLanding.ts`, add `import { BRAND_NAME, BRAND_SITE_URL } from "./lib/brand";` to the
imports, then replace lines 46-47:

```ts
const FETCH_USER_AGENT = `Mozilla/5.0 (compatible; ${BRAND_NAME.replace(/\s+/g, "")}CRM-AdContext/1.0; +${BRAND_SITE_URL})`;
```

Whitespace is stripped from the brand because a User-Agent product token cannot contain spaces —
a two-word brand would otherwise emit a malformed header.

- [ ] **Step 3: Sales checklist copy**

In `convex/lib/salesChecklist.ts`, add `import { BRAND_NAME } from "./brand";` to the imports, then
replace line 27:

```ts
      `Present the right package for their needs: what's included and why ${BRAND_NAME}.`,
```

- [ ] **Step 4: Knowledge-base lint message**

In `convex/lib/kb/lint.ts`, add `import { BRAND_NAME } from "../brand";` to the imports (note the
extra `../` — this file is one level deeper), then replace line 66:

```ts
      `Customer-safe text mentions prices/fees — ${BRAND_NAME} policy routes cost talk to a human.`));
```

- [ ] **Step 5: Password blocklist**

`convex/lib/password.ts:108-109` blocks `"amani123"` and `"amani1234"`. These are brand-derived
guesses, so derive them rather than listing one company's.

Add `import { BRAND_NAME } from "./brand";` to the imports. Replace lines 108-109 with:

```ts
  // Brand-derived guesses. Generated rather than listed: the blocklist has
  // to protect whichever company this deployment is, and a hardcoded
  // "amani123" protects exactly one of them. Lowercased because the
  // comparison this list feeds is case-insensitive.
  `${BRAND_NAME.toLowerCase().replace(/\s+/g, "")}123`,
  `${BRAND_NAME.toLowerCase().replace(/\s+/g, "")}1234`,
```

- [ ] **Step 6: Confirm the derived entries can still match**

The lowercasing in Step 5 is only correct because the candidate is normalized before lookup —
verified at `convex/lib/password.ts:144-146`:

```ts
  const normalized = password.toLowerCase();

  if (COMMON_PASSWORDS.has(normalized)) {
```

`COMMON_PASSWORDS` is a `Set`, so an entry only ever matches by exact string equality against that
lowercased candidate. A brand containing capitals or a space — "Holidayys", or any two-word brand —
would produce an entry that can never match unless it is lowercased and stripped, which is what
Step 5 does. Re-read the two lines above and confirm they are unchanged before moving on; if the
normalization has since been removed, this derivation is silently dead and the entries must be
built to match whatever the new comparison does.

- [ ] **Step 7: De-brand two comments that would otherwise conflict**

`convex/lib/r2/url.ts:5` and `convex/files.ts:37` name the media host in prose. Comments have no
behaviour, so this is not identity externalization — it is conflict removal. Each is two lines that
differ between the repos and would produce a pointless merge conflict; naming the variable instead
of the host makes them identical and, incidentally, keeps them true when the host changes.

In `convex/lib/r2/url.ts`, replace line 5:

```ts
// (the `NEXT_PUBLIC_R2_PUBLIC_HOST` custom domain), NOT the S3 API
// endpoint and NOT `r2.dev`
```

In `convex/files.ts`, replace the fragment on line 37:

```ts
// there is no `getUrl` here anymore: the R2 custom domain
// (`NEXT_PUBLIC_R2_PUBLIC_HOST`) is PUBLIC,
```

Re-flow the surrounding comment lines so the paragraphs still read correctly — these sit mid-
sentence in longer blocks.

- [ ] **Step 8: Verify no company name survives in `convex/`**

Run:

```bash
grep -rniE 'amani' convex --include='*.ts' | grep -v '\.test\.'
```

Expected: only comments, plus `amaniDefaultConfig` (which Task 5 renames) and — if Steps 5-6 were
skipped per the precondition — the two `password.ts` blocklist entries.

- [ ] **Step 9: Run the full convex suite**

Run: `npx vitest run --project=convex`
Expected: PASS. `convex/lib/password.test.ts` is the one most likely to fail: if it asserts
`"amani123"` is blocked, update it to build the expected value from the test environment's
`BRAND_NAME` ("Testco") rather than naming a company.

- [ ] **Step 10: Commit**

**Stage `password.ts` only if Steps 5-6 actually ran.** It is untracked, so a blanket `git add`
would commit someone else's work in progress along with this change:

```bash
git add convex/lib/pushPayload.ts convex/adLanding.ts convex/lib/salesChecklist.ts \
  convex/lib/kb/lint.ts convex/lib/r2/url.ts convex/files.ts
# Only if Steps 5-6 ran AND the file was already tracked beforehand:
#   git add convex/lib/password.ts
git commit -m "refactor(brand): read the company name from brand.ts across Convex

Push notification titles, the ad-context fetcher's User-Agent, one line
of sales-checklist copy and one knowledge-base lint message.

The password blocklist now DERIVES its brand guesses rather than listing
them: a hardcoded 'amani123' protects exactly one of the two companies
this codebase will serve, which is the wrong one half the time.

The User-Agent strips whitespace out of the brand name — a product token
cannot contain spaces, so a two-word brand would emit a malformed
header."
```

If Steps 5-6 were skipped, delete the password-blocklist paragraph from the message above. A commit
message describing a change the commit does not contain is worse than a shorter one.

---

### Task 5: Rename the qualification seed off the company name

**Files:**
- Modify: `convex/lib/qualification/defaults.ts:19` (and its header comment, lines 4-12)
- Modify: `convex/qualification.ts:5,53,85,135`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `defaultQualificationConfig(): QualificationConfigSeed`, replacing
  `amaniDefaultConfig()`. Same signature, same return value.

This is the last identifier in the codebase named after a company. It is a pure rename — the seed's
*contents* (hours, phrasings) stay exactly as they are, because they are this deployment's approved
configuration and are superseded by the database row once an owner saves settings.

- [ ] **Step 1: Rename the function**

In `convex/lib/qualification/defaults.ts`, replace line 19:

```ts
export function defaultQualificationConfig(): QualificationConfigSeed {
```

Then update the header comment at lines 4-12 — it currently reads "(Amani preset)". Replace that
parenthetical with "(the seeded preset)" and add, after the existing text:

```ts
// The VALUES below stay as they are: they are this deployment's approved
// starting configuration, and an owner's saved settings supersede them on
// first write. Only the function's NAME was company-specific.
```

- [ ] **Step 2: Update the call sites**

In `convex/qualification.ts`, replace line 5:

```ts
import { defaultQualificationConfig } from "./lib/qualification/defaults";
```

Replace lines 53 and 85:

```ts
      ...defaultQualificationConfig(),
```

Replace line 135:

```ts
      const basicFields = config?.basicFields ?? defaultQualificationConfig().basicFields;
```

- [ ] **Step 3: Catch any call site the four above missed**

Run:

```bash
grep -rn 'amaniDefaultConfig' convex src
```

Expected: no output. If a test file appears, update it too — the rename is mechanical.

- [ ] **Step 4: Run both suites and the typechecker**

Run: `npx vitest run`
Expected: PASS — the full 3,124.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/qualification/defaults.ts convex/qualification.ts
git commit -m "refactor(brand): rename amaniDefaultConfig to defaultQualificationConfig

The last identifier in the codebase named after a company. A pure
rename: the seed's values stay exactly as they are, because they are
this deployment's approved starting configuration and an owner's saved
settings supersede them on first write. Only the name was specific."
```

---

### Task 6: Mirror into the Holidayys repo

**Files:** the same 21 files, in `/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0`. (Everything Tasks 1-5
touch except `convex/lib/password.ts`, which does not exist in that repo.)

**Interfaces:**
- Consumes: the finished Tasks 1-5 in this repo, as the source to copy from.
- Produces: two repos whose brand-touching files are **byte-identical**, which is the point.

The spec's merge plan expects the ~13 brand files to conflict. If both repos carry the *same*
brand-neutral code first, they do not conflict at all — they are identical, and git merges them
silently. That is what this task buys, and it is why it belongs here rather than after the graft.

Doing the same work twice is exactly the duplication this project exists to end. It is the last
time.

- [ ] **Step 1: Copy the two modules across verbatim**

```bash
SRC=/Volumes/CurserDisk/Dev/wa-amani
DST=/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0
cp "$SRC/src/lib/brand.ts" "$DST/src/lib/brand.ts"
cp "$SRC/src/lib/brand.test.ts" "$DST/src/lib/brand.test.ts"
cp "$SRC/convex/lib/brand.ts" "$DST/convex/lib/brand.ts"
cp "$SRC/convex/lib/brand.test.ts" "$DST/convex/lib/brand.test.ts"
```

These are tenant-neutral by construction, so they copy without edits.

- [ ] **Step 2: Apply Tasks 2, 4 and 5 to the Holidayys tree**

Work through Task 2 Steps 1-7, Task 4 Steps 1-5 and Task 5 Steps 1-2 again, in `$DST`. The edits are
identical — the files were byte-identical at the fork except for the company strings being removed,
so the *result* is byte-identical even though the starting text differed.

Line numbers will differ slightly; locate by content, not by number.

- [ ] **Step 3: Mirror the vitest and env-example changes**

Apply Task 1 Step 1 (the `test.env` block) and Step 6 (`.env.local.example`) to `$DST`, changing
only the example values in the env file to Holidayys': `Holidayys`, `Holidays Tours LLC`,
`https://holidayys.co`, `hello@holidayys.co`. The `vitest.config.ts` block is identical — the test
brand is "Testco" in both.

- [ ] **Step 4: Prove the files are byte-identical**

This is the task's actual deliverable. Run:

```bash
SRC=/Volumes/CurserDisk/Dev/wa-amani
DST=/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0
for f in src/lib/brand.ts src/lib/brand.test.ts convex/lib/brand.ts convex/lib/brand.test.ts \
         src/app/layout.tsx src/app/manifest.ts src/app/join/layout.tsx \
         "src/app/(auth)/signup/page.tsx" src/components/settings/invite-member-dialog.tsx \
         src/components/og/invite-card.tsx src/components/settings/qualification-settings.tsx \
         convex/lib/pushPayload.ts convex/adLanding.ts convex/lib/salesChecklist.ts \
         convex/lib/kb/lint.ts convex/lib/r2/url.ts convex/files.ts \
         convex/lib/qualification/defaults.ts convex/qualification.ts; do
  if cmp -s "$SRC/$f" "$DST/$f"; then echo "OK   $f"; else echo "DIFF $f"; fi
done
```

Expected: `OK` on every line **except `convex/lib/qualification/defaults.ts`**, which legitimately
differs — it carries each company's own approved opening hours and question phrasings, which are
configuration values, not identity. It diverged by 11 lines before this work and should still
diverge by 11 after.

Every other file in that list differed by exactly 2 lines beforehand (4 for `pushPayload.ts`), all
of them the company strings this plan removes, so all of them should now read `OK`. Any other
`DIFF` is an inconsistency between the two ports — reconcile it now; each one left here becomes a
merge conflict later, which is precisely what this task exists to prevent.

- [ ] **Step 5: Run the Holidayys suite**

Run: `cd "$DST" && npx vitest run`
Expected: PASS — 2,332 tests.

- [ ] **Step 6: Commit in the Holidayys repo**

```bash
cd /Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0
git add src/lib/brand.ts src/lib/brand.test.ts convex/lib/brand.ts convex/lib/brand.test.ts \
  vitest.config.ts .env.local.example src/app/layout.tsx src/app/manifest.ts \
  src/app/join/layout.tsx "src/app/(auth)/signup/page.tsx" \
  src/components/settings/invite-member-dialog.tsx src/components/og/invite-card.tsx \
  src/components/settings/qualification-settings.tsx convex/lib/pushPayload.ts \
  convex/adLanding.ts convex/lib/salesChecklist.ts convex/lib/kb/lint.ts \
  convex/lib/r2/url.ts convex/files.ts \
  convex/lib/qualification/defaults.ts convex/qualification.ts
git commit -m "refactor(brand): read the company identity from the environment

The mirror of the same change in the Amani repo, applied here so the two
codebases carry identical brand-neutral files before they are merged.

The spec's merge plan expected these ~13 files to conflict on the company
strings. Having made both sides identical first, they do not conflict at
all — git merges them silently. That is the whole point of doing this
before the graft rather than during it."
```

---

## Deployment note (not a code task)

Both deployments need their variables set before the next release, or the app will fail to build —
which is the designed behaviour, but only helpful if it is expected.

- **Netlify** (per site): the five `NEXT_PUBLIC_*` values.
- **Convex** (per deployment): `BRAND_NAME` and `BRAND_SITE_URL`, via
  `npx convex env set BRAND_NAME <value>`.

Per the standing rule in this project, Convex deploys are owner-initiated: do not run them as part
of executing this plan.

## What this plan does NOT do

Deliberately out of scope, each with its own plan to follow:

- The graft, the `.claude/worktrees` purge, and the merge itself
- The media-viewer reconciliation (§Decision in the spec)
- Deploy scripts, `.env.<tenant>` files and the deploy preflight
- The production rollout — disabling `autoAssignEnabled`, the `awaitingReply` backfill

None of those are blocked by this plan, and this plan is not blocked by them. It is the piece that
can be done first, safely, in both repos, today.
