# Tenant Deploy Machinery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it structurally hard to deploy one company's code onto the other company's database.

**Architecture:** Each tenant gets its own gitignored `.env.<tenant>` file that **declares which
tenant it is**. A tested preflight reads it, cross-checks the declaration against the Convex host it
actually contains, refuses to run from a dirty or non-`main` checkout, prints the target in plain
language, and requires the operator to type the tenant name before anything is deployed.

Two questions, answered separately. Tasks 1-4 answer **"where does this deploy?"**. Task 5 answers
**"is the deployment it lands on configured to run the code?"** — a different surface, 41 variables
set by hand on the Convex deployment, whose failures are all silent.

**Tech Stack:** Node ≥20 ESM (`.mjs`), vitest, Convex CLI.

**Parent spec:** `docs/superpowers/specs/2026-08-02-crm-codebase-unification-design.md` §Deploy safety

## Why this exists

Before unification, the folder you stood in *was* the company. Two repos, two databases, and a
wrong command hit the right database by accident. Merging removes that, and replaces it with
nothing — the spec's R4:

> A stale or wrong env file deploys one company's schema onto the other's production data. This
> failure mode does not exist today, and is created by this work.

The rollout plan is executed once, by hand, carefully. Its Task 1 Step 4 — reading the Convex host
out of `.env.local` and checking it by eye — is the *only* thing standing between a tired operator
and that mistake. This plan replaces the eye with a machine, for every deploy after the first.

The threat is not exotic. It is: two checkouts open, two terminals, one `npm run deploy` typed in
the wrong window. Every defence below is aimed at that.

## Design: three independent checks

No single check is trusted, because each has a way to be wrong.

| Check | Catches | Fooled by |
|---|---|---|
| **Declared tenant** — the file says `TENANT=holidayys`, the command says `deploy:holidayys` | Running the wrong npm script; a file that was copied wholesale and never edited | Someone editing `TENANT` to silence it |
| **Host cross-check** — `CONVEX_SELF_HOSTED_URL`'s host must equal the file's own `EXPECTED_CONVEX_HOST` | The realistic error: copying a tenant file and updating some URLs but not all | Copying the whole file including both fields |
| **Typed confirmation** — operator sees the resolved host and brand, types the tenant name | Everything above, because a human reads "Amani" before typing "holidayys" and stops | Habit, at 2am |

Together they mean a wrong deploy needs a file that lies about itself *and* an operator who
confirms a target they can see is wrong.

## Global Constraints

- **Never print a secret.** The preflight displays hosts and the brand name only. Admin keys, the
  encryption key, `META_APP_SECRET` and `OPENAI_API_KEY` are read into the child process's
  environment and never logged. A deploy script that echoes its environment is a credential leak
  into terminal scrollback and CI logs.
- **No new dependencies.** This repo has no `dotenv`, `execa` or `zx`, and does not need them.
  `engines.node` is `>=20.0.0`, which is *below* the 20.6 that added `--env-file`, so the parser is
  hand-rolled — which is better anyway, because a hand-rolled parser is a pure function this repo's
  `scripts` vitest project can test.
- **Follow the `scripts/voice-eval` shape:** pure logic in `lib.mjs`, tests in `lib.test.mjs`
  (`describe`/`it`/`expect`), a thin CLI that does I/O and calls the library. `vitest.config.ts`
  already collects `scripts/**/*.test.mjs` under the `scripts` project.
- **The preflight never deploys on its own.** It validates and asks. The deploy is the last line of
  the script, after the confirmation returns.
- This plan does not deploy anything. It builds and tests the tooling. First real use is the
  *second* deploy — the rollout plan's first one is deliberately manual.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/deploy/lib.mjs` | **Create.** Pure: parse an env file, validate a tenant's declarations against its contents, describe the target for display. No I/O. |
| `scripts/deploy/lib.test.mjs` | **Create.** Tests every rejection path, because each one is a wrong deploy that did not happen. |
| `scripts/deploy/preflight.mjs` | **Create.** The CLI. Reads the file, checks git state, prints the target, prompts, spawns `npx convex deploy`. |
| `scripts/deploy/use-tenant.mjs` | **Create.** Writes `.env.local` from a tenant file so `next dev` and other local tooling work. |
| `scripts/deploy/convex-env.manifest.json` | **Create.** The 41 Convex deployment variables, by name only, split into required / feature-gated / optional. Hand-maintained — two modules read env dynamically and cannot be grepped. |
| `scripts/deploy/convex-env.mjs` | **Create.** Compares a deployment's actual configuration against the manifest. Reads names from `convex env list` and never touches the values. |
| `.env.tenant.example` | **Create.** Documents the format, committed. |
| `.gitignore` | **Modify.** Un-ignore the new example file. |
| `package.json` | **Modify.** Add `deploy:*` and `use:*` scripts. |

Pure library separate from CLI because the interesting logic — *is this file internally consistent?*
— is exactly what must be tested, and it cannot be tested if it is tangled with `readFileSync` and
`process.exit`.

---

### Task 1: The validation library

**Files:**
- Create: `scripts/deploy/lib.mjs`
- Create: `scripts/deploy/lib.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseEnvFile(text) → Record<string, string>`
  - `hostOf(url) → string | null`
  - `validateTenantEnv({ tenant, env }) → string[]` — array of human-readable problems, empty if OK
  - `describeTarget({ tenant, env }) → { tenant, convexHost, convexSiteUrl, brand }` — display only, no secrets

- [ ] **Step 1: Write the failing test**

Create `scripts/deploy/lib.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { parseEnvFile, hostOf, validateTenantEnv, describeTarget } from "./lib.mjs";

/** A well-formed Holidayys file, as the tests' starting point. */
const GOOD = {
  TENANT: "holidayys",
  EXPECTED_CONVEX_HOST: "convex-api.holidayys.co",
  CONVEX_SELF_HOSTED_URL: "https://convex-api.holidayys.co",
  CONVEX_SELF_HOSTED_ADMIN_KEY: "secret",
  NEXT_PUBLIC_CONVEX_URL: "https://convex-api.holidayys.co",
  NEXT_PUBLIC_CONVEX_SITE_URL: "https://convex-site.holidayys.co",
  NEXT_PUBLIC_BRAND_NAME: "Holidayys",
};

describe("parseEnvFile", () => {
  it("reads KEY=value pairs", () => {
    expect(parseEnvFile("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });
  it("ignores comments and blank lines", () => {
    expect(parseEnvFile("# note\n\nA=1\n   # indented\n")).toEqual({ A: "1" });
  });
  it("keeps '=' that appear inside a value", () => {
    expect(parseEnvFile("KEY=a=b=c")).toEqual({ KEY: "a=b=c" });
  });
  it("strips matching surrounding quotes", () => {
    expect(parseEnvFile(`A="one"\nB='two'`)).toEqual({ A: "one", B: "two" });
  });
  it("trims whitespace around key and value", () => {
    expect(parseEnvFile("  A  =  1  ")).toEqual({ A: "1" });
  });
  it("ignores a line with no '='", () => {
    expect(parseEnvFile("JUSTAKEY\nA=1")).toEqual({ A: "1" });
  });
  it("takes the LAST value when a key repeats", () => {
    // Matches what the shell and every dotenv loader do. Worth pinning:
    // a duplicated key is a real thing that happens to hand-edited files.
    expect(parseEnvFile("A=1\nA=2")).toEqual({ A: "2" });
  });
});

describe("hostOf", () => {
  it("extracts the host", () => {
    expect(hostOf("https://convex-api.holidayys.co")).toBe("convex-api.holidayys.co");
  });
  it("ignores path and port-less trailing slash", () => {
    expect(hostOf("https://convex-api.holidayys.co/")).toBe("convex-api.holidayys.co");
  });
  it("returns null for junk", () => {
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf("")).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});

describe("validateTenantEnv", () => {
  it("accepts a consistent file", () => {
    expect(validateTenantEnv({ tenant: "holidayys", env: GOOD })).toEqual([]);
  });

  // THE core check: the command says one tenant, the file says another.
  it("rejects a file whose TENANT disagrees with the command", () => {
    const problems = validateTenantEnv({ tenant: "amani", env: GOOD });
    expect(problems.join(" ")).toMatch(/TENANT/);
    expect(problems.join(" ")).toMatch(/holidayys/);
  });

  // The realistic error: copy a tenant file, update some URLs, miss one.
  it("rejects a Convex URL whose host is not the declared one", () => {
    const env = { ...GOOD, CONVEX_SELF_HOSTED_URL: "https://convex-api.amaniworld.com" };
    expect(validateTenantEnv({ tenant: "holidayys", env }).join(" "))
      .toMatch(/CONVEX_SELF_HOSTED_URL/);
  });
  it("rejects a client Convex URL pointing at a different deployment", () => {
    const env = { ...GOOD, NEXT_PUBLIC_CONVEX_URL: "https://convex-api.amaniworld.com" };
    expect(validateTenantEnv({ tenant: "holidayys", env }).join(" "))
      .toMatch(/NEXT_PUBLIC_CONVEX_URL/);
  });

  it.each([
    "TENANT",
    "EXPECTED_CONVEX_HOST",
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "NEXT_PUBLIC_CONVEX_URL",
    "NEXT_PUBLIC_BRAND_NAME",
  ])("rejects a file missing %s", (key) => {
    const env = { ...GOOD };
    delete env[key];
    expect(validateTenantEnv({ tenant: "holidayys", env }).join(" ")).toMatch(key);
  });

  it("reports every problem at once rather than the first", () => {
    const env = { ...GOOD, TENANT: "amani" };
    delete env.NEXT_PUBLIC_BRAND_NAME;
    expect(validateTenantEnv({ tenant: "holidayys", env }).length).toBeGreaterThan(1);
  });

  it("rejects a malformed URL", () => {
    const env = { ...GOOD, CONVEX_SELF_HOSTED_URL: "convex-api.holidayys.co" };
    expect(validateTenantEnv({ tenant: "holidayys", env }).join(" ")).toMatch(/CONVEX_SELF_HOSTED_URL/);
  });
});

describe("describeTarget", () => {
  it("returns only display-safe fields", () => {
    const d = describeTarget({ tenant: "holidayys", env: GOOD });
    expect(d).toEqual({
      tenant: "holidayys",
      convexHost: "convex-api.holidayys.co",
      convexSiteUrl: "https://convex-site.holidayys.co",
      brand: "Holidayys",
    });
  });
  it("never carries a secret", () => {
    // The confirmation prompt is printed to a terminal and lands in
    // scrollback; a key that reaches it is a leaked key.
    const d = describeTarget({ tenant: "holidayys", env: GOOD });
    expect(JSON.stringify(d)).not.toMatch(/secret/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=scripts scripts/deploy/lib.test.mjs`
Expected: FAIL — cannot resolve `./lib.mjs`.

- [ ] **Step 3: Write the library**

Create `scripts/deploy/lib.mjs`:

```js
/**
 * Pure helpers for the tenant deploy preflight.
 *
 * One codebase serves two companies with two Convex deployments, so the
 * question "which database am I about to write to?" no longer answers
 * itself from the directory name. Everything here exists to answer it
 * from the environment file, and to refuse when the file contradicts
 * itself.
 *
 * No I/O and no `process` access: the interesting logic is the
 * consistency checking, and it is only testable if it is separable from
 * reading files and exiting.
 */

/**
 * Minimal `.env` parser — enough for the files this repo actually keeps,
 * and no more. Hand-rolled deliberately: `engines.node` is `>=20.0.0`,
 * below the 20.6 that added `--env-file`, and adding a dependency to
 * parse `KEY=value` would not be testable as a pure function.
 *
 * Deliberately NOT supported, because nothing here uses them and
 * pretending otherwise would be a silent misread: multi-line values,
 * `export ` prefixes, and `${VAR}` interpolation.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    // Only the FIRST `=` splits — a value may legitimately contain more
    // (base64 padding, query strings, admin keys).
    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value[value.length - 1] === value[0];
    if (quoted) value = value.slice(1, -1);
    // Last wins, matching the shell and every dotenv loader.
    out[key] = value;
  }
  return out;
}

/** The host of `url`, or null if it is not a parseable absolute URL. */
export function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return null;
  }
}

const REQUIRED = [
  "TENANT",
  "EXPECTED_CONVEX_HOST",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_BRAND_NAME",
];

/**
 * Every reason this file must not be deployed as `tenant`, or `[]`.
 *
 * Returns ALL problems rather than the first: an operator fixing a
 * mis-copied tenant file should see the whole list once, not rediscover
 * it one failed run at a time.
 */
export function validateTenantEnv({ tenant, env }) {
  const problems = [];

  for (const key of REQUIRED) {
    if (!env?.[key]) problems.push(`${key} is missing or empty`);
  }
  // Everything below reads fields that may be absent; bail rather than
  // reporting cascading nonsense on top of the list above.
  if (problems.length) return problems;

  if (env.TENANT !== tenant) {
    problems.push(
      `TENANT in the file is "${env.TENANT}" but this command deploys "${tenant}" — ` +
        `refusing. Either the wrong file was picked up or it was copied and not edited.`,
    );
  }

  const expected = env.EXPECTED_CONVEX_HOST;
  for (const key of ["CONVEX_SELF_HOSTED_URL", "NEXT_PUBLIC_CONVEX_URL"]) {
    const host = hostOf(env[key]);
    if (host === null) {
      problems.push(`${key} is not a valid absolute URL: "${env[key]}"`);
    } else if (host !== expected) {
      problems.push(
        `${key} points at "${host}" but this file declares EXPECTED_CONVEX_HOST ` +
          `"${expected}". One of the two is wrong, and deploying would write to ` +
          `whichever database "${host}" is.`,
      );
    }
  }

  return problems;
}

/** Display-safe summary for the confirmation prompt. Never include a
 *  key, token or secret here: this is printed to a terminal and lives on
 *  in scrollback and CI logs.
 *
 *  `convexSiteUrl` is Convex's HTTP-actions origin, NOT the brand's
 *  marketing site — the two are one character apart in the environment
 *  (`NEXT_PUBLIC_CONVEX_SITE_URL` vs `NEXT_PUBLIC_SITE_URL`), so the
 *  field is named for the one it actually holds. */
export function describeTarget({ tenant, env }) {
  return {
    tenant,
    convexHost: hostOf(env.CONVEX_SELF_HOSTED_URL),
    convexSiteUrl: env.NEXT_PUBLIC_CONVEX_SITE_URL ?? null,
    brand: env.NEXT_PUBLIC_BRAND_NAME ?? null,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project=scripts scripts/deploy/lib.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/lib.mjs scripts/deploy/lib.test.mjs
git commit -m "feat(deploy): pure validation for tenant environment files

Merging the two CRMs into one codebase removed the accident-protection
that the folder you stood in WAS the company. This is the first half of
what replaces it.

A tenant file declares which tenant it is and which Convex host it
expects, and this library refuses any file that contradicts itself —
catching the realistic error, which is copying a tenant file and
updating some URLs but not all of them.

Pure and I/O-free so every rejection path is tested, since each one is a
wrong deploy that did not happen. Hand-rolled env parsing rather than a
dependency: engines.node allows 20.0, below the 20.6 that added
--env-file, and a parser is exactly the kind of thing this repo's
scripts vitest project exists to pin."
```

---

### Task 2: The tenant environment files

**Files:**
- Create: `.env.tenant.example` (committed)
- Modify: `.gitignore`
- Create, in each checkout, **uncommitted**: `.env.holidayys` and `.env.amani`

**Interfaces:**
- Consumes: the key names Task 1 requires.
- Produces: the files Task 3's CLI reads.

- [ ] **Step 1: Un-ignore the example file**

`.gitignore:34` is `.env*`, with existing negations for `.env.local.example` and `.env.example`. Add
a third, immediately after them:

```
!.env.tenant.example
```

Without this the example is ignored and the format goes undocumented — the negations are opt-in per
filename, not a pattern.

- [ ] **Step 2: Write the example**

Create `.env.tenant.example`:

```
# ============================================================
# Per-tenant environment. Copy to `.env.<tenant>` — e.g.
# `.env.holidayys` — and fill in. Never committed (.gitignore's
# `.env*`); this example is the only file here git tracks.
# ============================================================
#
# One codebase serves two companies with two Convex deployments and two
# WhatsApp numbers. The folder you are standing in no longer tells you
# which is which, so this file says so out loud and
# `scripts/deploy/preflight.mjs` refuses to deploy when it contradicts
# itself.

# Which tenant this file is. MUST match the npm script used to deploy it
# (`npm run deploy:holidayys` requires TENANT=holidayys). This is the
# check that catches running the right command in the wrong window.
TENANT=holidayys

# The Convex host every URL below must resolve to. Declared separately
# from the URLs on purpose: it is the cross-check that catches a file
# copied from the other tenant and only partly updated.
EXPECTED_CONVEX_HOST=convex-api.holidayys.co

# ---- Convex deployment ----
CONVEX_SELF_HOSTED_URL=https://convex-api.holidayys.co
CONVEX_SELF_HOSTED_ADMIN_KEY=<admin key from the Convex dashboard>
NEXT_PUBLIC_CONVEX_URL=https://convex-api.holidayys.co
NEXT_PUBLIC_CONVEX_SITE_URL=https://convex-site.holidayys.co

# ---- Brand (see src/lib/brand.ts — no defaults, a missing one throws) ----
NEXT_PUBLIC_BRAND_NAME=Holidayys
NEXT_PUBLIC_BRAND_LEGAL_NAME=Holidays Tours LLC
NEXT_PUBLIC_SITE_URL=https://wa.holidayys.co
NEXT_PUBLIC_BRAND_WEBSITE=https://holidayys.co
NEXT_PUBLIC_BRAND_EMAIL=hello@holidayys.co

# ---- Everything else that was in .env.local ----
ENCRYPTION_KEY=<64 hex chars>
META_APP_SECRET=<meta app secret>
OPENAI_API_KEY=<openai key>
WEBHOOK_PROXY_SECRET=<webhook proxy secret>
NEXT_PUBLIC_APP_LOCALE=en
```

- [ ] **Step 3: Create the real tenant files from the existing `.env.local`**

In each checkout, build `.env.<tenant>` from that checkout's current `.env.local`, adding the two
new declarations at the top and the five brand values.

**Watch for duplicated keys while copying.** The Amani checkout's `.env.local` currently lists
`OPENAI_API_KEY` twice; last-wins means the file has been working off whichever was second. Keep one.

Do not delete `.env.local` yet — Task 4 regenerates it, and `next dev` needs it until then.

- [ ] **Step 4: Verify neither tenant file is tracked**

```bash
git status --porcelain --ignored | grep -E '\.env\.(holidayys|amani)' | head
git check-ignore -v .env.holidayys .env.amani
```

Expected: both shown as ignored, matched by `.gitignore:34`. **If `git status` lists either as
untracked-but-not-ignored, stop** — one commit away from publishing admin keys and an OpenAI key.

- [ ] **Step 5: Commit only the example and the gitignore change**

```bash
git add .gitignore .env.tenant.example
git status --short   # confirm NO .env.holidayys / .env.amani staged
git commit -m "docs(deploy): document the per-tenant environment format

Adds .env.tenant.example and un-ignores it. The real .env.<tenant> files
stay untracked, as .gitignore's .env* already ensures.

The two declarations at the top — TENANT and EXPECTED_CONVEX_HOST — are
not configuration the app reads. They exist so the preflight can tell
whether the file is internally consistent, and refuse when it is not."
```

---

### Task 3: The deploy preflight

**Files:**
- Create: `scripts/deploy/preflight.mjs`
- Modify: `package.json` (scripts block)

**Interfaces:**
- Consumes: `parseEnvFile`, `validateTenantEnv`, `describeTarget` from Task 1; `.env.<tenant>` from
  Task 2.
- Produces: `npm run deploy:holidayys` / `npm run deploy:amani`.

- [ ] **Step 1: Write the CLI**

Create `scripts/deploy/preflight.mjs`:

```js
#!/usr/bin/env node
/**
 * Guarded Convex deploy for one tenant.
 *
 *   node scripts/deploy/preflight.mjs holidayys [--dry-run]
 *
 * Reads `.env.<tenant>`, refuses if it contradicts itself or the
 * checkout is not a clean `main`, shows the operator exactly which
 * deployment is about to be written to, and requires them to type the
 * tenant name. Only then does it run `npx convex deploy`.
 *
 * The environment is passed to the child explicitly rather than through
 * `.env.local`, so a stale `.env.local` cannot influence where this
 * deploys.
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { parseEnvFile, validateTenantEnv, describeTarget } from "./lib.mjs";

function die(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const [, , tenant, ...flags] = process.argv;
const dryRun = flags.includes("--dry-run");

if (!tenant) die("Usage: node scripts/deploy/preflight.mjs <tenant> [--dry-run]");

// ---- 1. The file ----
const file = `.env.${tenant}`;
if (!existsSync(file)) {
  die(`${file} not found. Copy .env.tenant.example to ${file} and fill it in.`);
}
const env = parseEnvFile(readFileSync(file, "utf8"));

const problems = validateTenantEnv({ tenant, env });
if (problems.length) {
  console.error(`\n  ✗ ${file} cannot be deployed as "${tenant}":\n`);
  for (const p of problems) console.error(`    - ${p}`);
  console.error("");
  process.exit(1);
}

// ---- 2. The checkout ----
// A deploy ships whatever is on disk. Deploying a feature branch, or a
// tree with uncommitted edits, ships something no review ever saw.
const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") die(`On branch "${branch}". Deploy from main.`);

if (git(["status", "--porcelain"])) {
  die("Working tree is not clean. Commit or stash before deploying.");
}

// A network blip must not crash this with a raw stack trace seconds
// before a production deploy — say what happened and stop cleanly.
try {
  execFileSync("git", ["fetch", "origin", "main"], { stdio: "ignore" });
} catch {
  die("Could not fetch origin/main. Check the network, then retry.");
}
if (git(["rev-parse", "HEAD"]) !== git(["rev-parse", "origin/main"])) {
  die("HEAD differs from origin/main. Pull (or push) before deploying.");
}

// ---- 3. The human ----
const target = describeTarget({ tenant, env });
const commit = git(["log", "-1", "--format=%h %s"]);

console.log("");
console.log("  ┌─ Convex deploy ────────────────────────────────");
console.log(`  │  tenant       ${target.tenant}`);
console.log(`  │  brand        ${target.brand}`);
console.log(`  │  convex host  ${target.convexHost}`);
console.log(`  │  convex site  ${target.convexSiteUrl ?? "(unset)"}`);
console.log(`  │  commit       ${commit}`);
console.log("  └────────────────────────────────────────────────");
console.log("");

if (dryRun) {
  console.log("  --dry-run: everything checks out, nothing deployed.\n");
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });
const typed = await rl.question(`  Type "${tenant}" to deploy: `);
rl.close();

if (typed.trim() !== tenant) {
  die("Confirmation did not match. Nothing was deployed.");
}

// ---- 4. Deploy ----
// `env` carries the tenant's CONVEX_SELF_HOSTED_URL and admin key, which
// is how the CLI knows where to go. Merged OVER process.env so a shell
// variable cannot redirect it.
console.log("");
const result = spawnSync("npx", ["convex", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, ...env },
});
process.exit(result.status ?? 1);
```

- [ ] **Step 2: Add the npm scripts**

In `package.json`, after `"start"`:

```json
    "deploy:holidayys": "node scripts/deploy/preflight.mjs holidayys",
    "deploy:amani": "node scripts/deploy/preflight.mjs amani",
```

There is deliberately **no bare `deploy` script**. A tenant-less deploy command is the exact
ambiguity this plan exists to remove.

- [ ] **Step 3: Verify it refuses a mismatched tenant**

The most important behaviour, so test it by hand before trusting it:

```bash
cp .env.holidayys /tmp/keep-holidayys
sed -i '' 's/^TENANT=.*/TENANT=amani/' .env.holidayys
npm run deploy:holidayys
```

Expected: refusal naming `TENANT`, exit non-zero, **no deploy attempted**. Then restore:

```bash
cp /tmp/keep-holidayys .env.holidayys && rm /tmp/keep-holidayys
```

- [ ] **Step 4: Verify it refuses a host mismatch**

```bash
cp .env.holidayys /tmp/keep-holidayys
sed -i '' 's|^CONVEX_SELF_HOSTED_URL=.*|CONVEX_SELF_HOSTED_URL=https://convex-api.amaniworld.com|' .env.holidayys
npm run deploy:holidayys
```

Expected: refusal naming `CONVEX_SELF_HOSTED_URL` and both hosts. Restore as above.

This is the check that would have caught the failure this whole plan exists for.

- [ ] **Step 5: Verify the happy path stops before deploying**

```bash
npm run deploy:holidayys -- --dry-run
```

Expected: the summary box with Holidayys' host and brand, then
`everything checks out, nothing deployed.` **Confirm no secret appears anywhere in the output.**

- [ ] **Step 6: Verify the git guards**

```bash
git checkout -b throwaway/deploy-guard-test
npm run deploy:holidayys -- --dry-run
git checkout main && git branch -D throwaway/deploy-guard-test
```

Expected: refusal — `On branch "throwaway/deploy-guard-test". Deploy from main.`

- [ ] **Step 7: Commit**

```bash
git add scripts/deploy/preflight.mjs package.json
git commit -m "feat(deploy): guarded per-tenant Convex deploy

npm run deploy:holidayys / deploy:amani. Refuses a tenant file that
contradicts itself, a non-main or dirty checkout, or a HEAD that differs
from origin/main — then shows the resolved Convex host and brand and
requires the operator to type the tenant name.

Passes the tenant environment to the Convex CLI explicitly rather than
through .env.local, so a stale .env.local cannot redirect a deploy. The
displayed summary carries hosts and the brand only: it is printed to a
terminal and lives on in scrollback.

There is deliberately no bare 'deploy' script. A tenant-less deploy
command is the ambiguity this exists to remove."
```

---

### Task 4: The local-development switcher

**Files:**
- Create: `scripts/deploy/use-tenant.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `.env.<tenant>` from Task 2.
- Produces: `npm run use:holidayys` / `use:amani`, which write `.env.local`.

`next dev`, `next build` and the Convex CLI's non-deploy commands all read `.env.local`. Rather than
maintaining it by hand — the stale file the spec warns about — it is generated from the tenant file
and stamped with where it came from.

- [ ] **Step 1: Write the switcher**

Create `scripts/deploy/use-tenant.mjs`:

```js
#!/usr/bin/env node
/**
 * Point local development at one tenant.
 *
 *   node scripts/deploy/use-tenant.mjs holidayys
 *
 * Writes `.env.local` from `.env.<tenant>`, stamped with its source so
 * that "which tenant is my dev server talking to?" is answerable by
 * reading the first line rather than comparing URLs.
 *
 * Deploys do NOT read this file — `preflight.mjs` passes the tenant
 * environment to the Convex CLI directly, so a stale `.env.local` can
 * mislead a dev server but never a deploy.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [, , tenant] = process.argv;
if (!tenant) {
  console.error("Usage: node scripts/deploy/use-tenant.mjs <tenant>");
  process.exit(1);
}

const source = `.env.${tenant}`;
if (!existsSync(source)) {
  console.error(`\n  ✗ ${source} not found.\n`);
  process.exit(1);
}

const banner =
  `# GENERATED FROM ${source} — do not edit.\n` +
  `# Edit ${source} and re-run \`npm run use:${tenant}\`.\n` +
  `# Local development only; deploys read the tenant file directly.\n\n`;

writeFileSync(".env.local", banner + readFileSync(source, "utf8"));
console.log(`\n  ✓ .env.local now points at "${tenant}".`);
console.log(`    Restart \`next dev\` for it to take effect.\n`);
```

- [ ] **Step 2: Add the npm scripts**

```json
    "use:holidayys": "node scripts/deploy/use-tenant.mjs holidayys",
    "use:amani": "node scripts/deploy/use-tenant.mjs amani",
```

- [ ] **Step 3: Verify it works and stamps its source**

```bash
npm run use:holidayys
head -3 .env.local
```

Expected: the banner naming `.env.holidayys`.

- [ ] **Step 4: Confirm `.env.local` is still ignored**

```bash
git check-ignore -v .env.local
```

Expected: matched by `.gitignore:34`. The generated file must never become committable.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy/use-tenant.mjs package.json
git commit -m "feat(deploy): switch local development between tenants

npm run use:holidayys / use:amani writes .env.local from the tenant file
and stamps it with its source, so which tenant a dev server is talking to
is answerable by reading the first line rather than comparing URLs.

Deploys deliberately do not read this file — preflight.mjs passes the
tenant environment to the Convex CLI directly — so a stale .env.local can
mislead a dev server but never a deploy."
```

---

### Task 5: Convex environment parity

**Files:**
- Create: `scripts/deploy/convex-env.manifest.json`
- Create: `scripts/deploy/convex-env.mjs`
- Modify: `scripts/deploy/lib.mjs` — add `checkConvexEnv`
- Modify: `scripts/deploy/lib.test.mjs` — cover it
- Modify: `scripts/deploy/preflight.mjs` — call it before the confirmation
- Modify: `package.json`

**Interfaces:**
- Consumes: `parseEnvFile` from Task 1.
- Produces: `checkConvexEnv({ manifest, present }) → { missingRequired: string[], dormantFeatures: Array<{name, vars, whenUnset}>, unknown: string[] }`, and
  `npm run env:check:<tenant>`.

Everything before this task validates the **deploy target**. This one validates the **deployment's
own configuration**, which is a separate surface with its own failure mode: 41 variables set by hand
with `npx convex env set`, living only on the deployment, invisible to the repo, the tests and CI.
`npx convex deploy` does not sync them. Nothing else in these five plans would notice a missing one.

The failures are quiet, which is why this is worth automating:

| Missing | What happens |
|---|---|
| `ENCRYPTION_KEY` | Throws. Every stored WhatsApp token is undecryptable — the company is disconnected |
| `R2_*` | `r2ConfigFromEnv()` throws, caught by best-effort wrappers. Media silently stops working |
| `META_CAPI_*` | Conversion events are **retired dormant** with a reason, not lost. They re-deliver once set — but Meta rejects events older than its freshness window, so the recovery has a deadline |
| `VAPID_*` | Push is dormant. `pushSend.ts:25` says so explicitly: *"Expected configuration state… stay silent"* |

None of those raise an alert. The Meta one is the expensive kind: ad optimisation degrades while
everything looks healthy.

**The manifest cannot be generated by grepping.** Two modules read env through a *dynamic* key —
`convex/lib/r2/config.ts:22` (`process.env[name]`) and `convex/lib/ai/pacing.ts:62` — so nine
variables, including all five R2 ones, are invisible to a literal-pattern search. The manifest is
hand-maintained; Step 2 pins the ones that would otherwise be missed.

- [ ] **Step 1: Write the manifest**

Create `scripts/deploy/convex-env.manifest.json`:

```json
{
  "$comment": "Convex DEPLOYMENT environment, set with `npx convex env set` and never stored in this repo. Names only — no values, ever. Hand-maintained: convex/lib/r2/config.ts and convex/lib/ai/pacing.ts read env through a dynamic key, so grepping for `process.env.NAME` will not find every entry here.",
  "required": [
    "ENCRYPTION_KEY",
    "WEBHOOK_PROXY_SECRET",
    "R2_BUCKET",
    "R2_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_PUBLIC_HOST",
    "BRAND_NAME",
    "BRAND_SITE_URL"
  ],
  "features": [
    {
      "name": "Meta CAPI conversions",
      "vars": ["META_CAPI_DATASET_ID", "META_CAPI_ACCESS_TOKEN"],
      "whenUnset": "conversion events are retired dormant and re-deliver once these are set — but Meta rejects events older than its freshness window, so the recovery has a deadline. Verify the current limit in Meta's Conversions API docs."
    },
    {
      "name": "Website conversion lane (platformA)",
      "vars": ["LANDING_CONVERSION_URL", "WA_CONVERSION_SHARED_SECRET"],
      "whenUnset": "the website web-Pixel lane is dormant. Expected on a tenant with no marketing-site receiver — Amani has none today, so this is informational there and a real gap on Holidayys."
    },
    {
      "name": "Web push notifications",
      "vars": ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"],
      "whenUnset": "push is silently dormant (convex/pushSend.ts:25). Must match NEXT_PUBLIC_VAPID_PUBLIC_KEY on the Netlify site, or existing subscriptions break."
    },
    {
      "name": "Meta Ads data",
      "vars": ["META_ADS_ACCESS_TOKEN"],
      "whenUnset": "campaign and ad metadata is not fetched."
    }
  ],
  "optional": [
    "CONVEX_SITE_URL",
    "META_GRAPH_VERSION",
    "META_CAPI_PARTNER_AGENT",
    "CONVEX_AI_DRY_RUN",
    "CONVEX_META_DRY_RUN",
    "AGENT_REPLY_SLA_MS",
    "AGENT_REPLY_SLA_REPEAT_MS",
    "AI_CONTEXT_MESSAGE_LIMIT",
    "AI_DESCRIBE_MODEL",
    "AI_JUDGE_MODEL",
    "AI_JUDGE_REASONING_EFFORT",
    "AI_KNOWLEDGE_TOP_K",
    "AI_MAX_OUTPUT_TOKENS",
    "AI_PDF_MAX_BYTES",
    "AI_REPLY_DEBOUNCE_MS",
    "AI_REPLY_DEBOUNCE_FAST_MS",
    "AI_REPLY_DEBOUNCE_SLOW_MS",
    "AI_REPLY_LANGUAGES",
    "AI_REPLY_REASONING_EFFORT",
    "AI_REQUEST_TIMEOUT_MS",
    "AI_TRANSCRIBE_ALLOWED_SCRIPTS",
    "AI_TRANSCRIBE_LANGUAGES",
    "AI_TRANSCRIBE_MIN_AVG_LOGPROB",
    "AI_TRANSCRIBE_MODEL",
    "AI_TRANSCRIBE_RESCUE_MARGIN",
    "AI_TYPING_CHARS_PER_SEC",
    "AI_TYPING_JITTER",
    "AI_TYPING_MAX_MS",
    "AI_TYPING_MIN_MS"
  ]
}
```

`optional` exists so an unrecognised variable can be reported as drift. Every entry there has a code
default — `AI_JUDGE_MODEL` resolves to `DEFAULT_JUDGE_MODEL` when unset (`convex/lib/ai/defaults.ts:128`),
and the rest follow the same shape.

- [ ] **Step 2: Confirm the manifest against the code**

The dynamic readers are the reason this is a manual step. Verify the nine invisible entries exist:

```bash
grep -n 'required("' convex/lib/r2/config.ts        # expect the 5 R2 names
grep -rn 'AI_TYPING' convex/lib/ai/pacing.ts        # expect the 4 typing names
```

Then check nothing literal is missing from the manifest:

```bash
grep -rlE 'process\.env\.' convex --include='*.ts' | grep -v '\.test\.' | \
  xargs grep -hoE 'process\.env\.[A-Z0-9_]+' | sed 's/process\.env\.//' | sort -u
```

Every name printed must appear somewhere in the manifest. **Note the `grep -v '\.test\.'` sits before
`xargs`, filtering paths.** Putting it after a `grep -h` filters the matched text instead, which
silently includes test files — a mistake worth not repeating.

- [ ] **Step 3: Write the failing test**

Append to `scripts/deploy/lib.test.mjs`:

```js
describe("checkConvexEnv", () => {
  const manifest = {
    required: ["ENCRYPTION_KEY", "R2_BUCKET"],
    features: [
      { name: "Meta CAPI conversions", vars: ["META_CAPI_DATASET_ID", "META_CAPI_ACCESS_TOKEN"], whenUnset: "dormant" },
    ],
    optional: ["AI_JUDGE_MODEL"],
  };

  it("passes when everything required and every feature var is present", () => {
    const r = checkConvexEnv({
      manifest,
      present: ["ENCRYPTION_KEY", "R2_BUCKET", "META_CAPI_DATASET_ID", "META_CAPI_ACCESS_TOKEN"],
    });
    expect(r).toEqual({ missingRequired: [], dormantFeatures: [], unknown: [] });
  });

  it("reports a missing required variable", () => {
    const r = checkConvexEnv({ manifest, present: ["R2_BUCKET"] });
    expect(r.missingRequired).toEqual(["ENCRYPTION_KEY"]);
  });

  it("reports a feature as dormant when ANY of its vars is missing", () => {
    // Half-configured is the dangerous state: it reads as "we set that up"
    // while behaving exactly like unconfigured.
    const r = checkConvexEnv({
      manifest,
      present: ["ENCRYPTION_KEY", "R2_BUCKET", "META_CAPI_DATASET_ID"],
    });
    expect(r.dormantFeatures).toHaveLength(1);
    expect(r.dormantFeatures[0].name).toBe("Meta CAPI conversions");
    expect(r.dormantFeatures[0].missing).toEqual(["META_CAPI_ACCESS_TOKEN"]);
  });

  it("does not report a fully-unset feature as required", () => {
    const r = checkConvexEnv({ manifest, present: ["ENCRYPTION_KEY", "R2_BUCKET"] });
    expect(r.missingRequired).toEqual([]);
    expect(r.dormantFeatures).toHaveLength(1);
  });

  it("reports a variable the manifest does not know about", () => {
    const r = checkConvexEnv({
      manifest,
      present: ["ENCRYPTION_KEY", "R2_BUCKET", "META_CAPI_DATASET_ID", "META_CAPI_ACCESS_TOKEN", "LEFTOVER_KEY"],
    });
    expect(r.unknown).toEqual(["LEFTOVER_KEY"]);
  });

  it("does not report optional vars as unknown", () => {
    const r = checkConvexEnv({
      manifest,
      present: ["ENCRYPTION_KEY", "R2_BUCKET", "META_CAPI_DATASET_ID", "META_CAPI_ACCESS_TOKEN", "AI_JUDGE_MODEL"],
    });
    expect(r.unknown).toEqual([]);
  });
});
```

Add `checkConvexEnv` to the import at the top of the file.

- [ ] **Step 4: Run it and confirm it fails**

Run: `npx vitest run --project=scripts scripts/deploy/lib.test.mjs`
Expected: FAIL — `checkConvexEnv is not a function`.

- [ ] **Step 5: Implement it**

Append to `scripts/deploy/lib.mjs`:

```js
/**
 * Compare a deployment's configured variable NAMES against the manifest.
 *
 * Takes names, never values: the caller reads them from
 * `npx convex env list`, whose output includes secrets, and must discard
 * the values before they reach anything that could log them.
 *
 * A feature is dormant when ANY of its variables is missing, not all of
 * them. Half-configured is the dangerous state — it reads as "we set that
 * up" while behaving exactly like unconfigured.
 */
export function checkConvexEnv({ manifest, present }) {
  const have = new Set(present);

  const missingRequired = manifest.required.filter((name) => !have.has(name));

  const dormantFeatures = [];
  for (const feature of manifest.features ?? []) {
    const missing = feature.vars.filter((name) => !have.has(name));
    if (missing.length) {
      dormantFeatures.push({ ...feature, missing });
    }
  }

  const known = new Set([
    ...manifest.required,
    ...(manifest.optional ?? []),
    ...(manifest.features ?? []).flatMap((f) => f.vars),
  ]);
  const unknown = present.filter((name) => !known.has(name));

  return { missingRequired, dormantFeatures, unknown };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project=scripts scripts/deploy/lib.test.mjs`
Expected: PASS.

- [ ] **Step 7: Write the CLI**

Create `scripts/deploy/convex-env.mjs`:

```js
#!/usr/bin/env node
/**
 * Check one tenant's Convex deployment configuration against the manifest.
 *
 *   node scripts/deploy/convex-env.mjs holidayys
 *
 * `npx convex env list` prints NAME=VALUE, so its output carries every
 * secret on the deployment. Names are extracted immediately and the raw
 * output is never printed, never stored and never included in an error.
 *
 * Exit 1 on a missing REQUIRED variable. Dormant features and unknown
 * variables are reported but do not fail: a tenant legitimately runs with
 * a feature switched off, and failing on that would train people to
 * ignore this.
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { parseEnvFile, checkConvexEnv } from "./lib.mjs";

const [, , tenant] = process.argv;
if (!tenant) {
  console.error("Usage: node scripts/deploy/convex-env.mjs <tenant>");
  process.exit(1);
}

const file = `.env.${tenant}`;
if (!existsSync(file)) {
  console.error(`\n  ✗ ${file} not found.\n`);
  process.exit(1);
}
const env = parseEnvFile(readFileSync(file, "utf8"));

const manifestPath = new URL("./convex-env.manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

let present;
try {
  const raw = execFileSync("npx", ["convex", "env", "list"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  // Names only. `raw` goes out of scope here and is never logged.
  present = raw
    .split("\n")
    .map((line) => line.split("=")[0].trim())
    .filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
} catch {
  console.error(
    `\n  ✗ Could not read the Convex environment for "${tenant}". ` +
      `Check CONVEX_SELF_HOSTED_URL and the admin key in ${file}.\n`,
  );
  process.exit(1);
}

const { missingRequired, dormantFeatures, unknown } = checkConvexEnv({ manifest, present });

console.log(`\n  Convex environment — ${tenant} (${present.length} variables set)\n`);

if (missingRequired.length) {
  console.error("  ✗ MISSING, and the deployment is broken without them:");
  for (const name of missingRequired) console.error(`      ${name}`);
  console.error("");
}

for (const feature of dormantFeatures) {
  console.warn(`  ⚠ ${feature.name} is DORMANT — missing ${feature.missing.join(", ")}`);
  console.warn(`      ${feature.whenUnset}\n`);
}

if (unknown.length) {
  console.warn(`  ⚠ Set on the deployment but not in the manifest: ${unknown.join(", ")}`);
  console.warn("      Either drift to clean up, or the manifest needs updating.\n");
}

if (!missingRequired.length && !dormantFeatures.length && !unknown.length) {
  console.log("  ✓ Matches the manifest exactly.\n");
}

process.exit(missingRequired.length ? 1 : 0);
```

- [ ] **Step 8: Call it from the preflight**

In `scripts/deploy/preflight.mjs`, between the checkout checks and the summary box (`// ---- 3. The
human ----`), insert:

```js
// ---- 2b. The deployment's own configuration ----
// Distinct from everything above, which checks WHERE this deploys. This
// checks whether the deployment it lands on is configured to run the
// code. Non-fatal beyond missing-required: the child exits 1 only then,
// and its warnings are the operator's to weigh.
const envCheck = spawnSync("node", ["scripts/deploy/convex-env.mjs", tenant], {
  stdio: "inherit",
});
if (envCheck.status !== 0) {
  die("The Convex deployment is missing required configuration (above).");
}
```

- [ ] **Step 9: Add the npm scripts**

```json
    "env:check:holidayys": "node scripts/deploy/convex-env.mjs holidayys",
    "env:check:amani": "node scripts/deploy/convex-env.mjs amani",
```

- [ ] **Step 10: Run it against a real deployment**

```bash
npm run env:check:amani
```

Expected: a report. Whatever it says is the first honest inventory of that deployment's
configuration — read it rather than skimming for the exit code. **Confirm no secret value appears
anywhere in the output.**

Treat a surprise here as information, not failure: a dormant feature you did not know was dormant is
exactly what this was built to surface.

- [ ] **Step 11: Commit**

```bash
git add scripts/deploy/convex-env.manifest.json scripts/deploy/convex-env.mjs \
  scripts/deploy/lib.mjs scripts/deploy/lib.test.mjs scripts/deploy/preflight.mjs package.json
git commit -m "feat(deploy): check the Convex deployment's configuration against a manifest

Everything else here validates WHERE a deploy lands. This validates
whether the deployment it lands on is configured to run the code — 41
variables set by hand with \`npx convex env set\`, living only on the
deployment, invisible to the repo, the tests and CI. \`convex deploy\`
does not sync them, and nothing else would notice a missing one.

The failures are all quiet, which is why this is worth automating. A
missing ENCRYPTION_KEY makes every stored WhatsApp token undecryptable.
Missing META_CAPI_* retires conversion events as dormant — recoverable,
since they re-deliver once configured, but Meta rejects events past its
freshness window, so the recovery has a deadline and nothing raises an
alert while it runs out.

A feature counts as dormant when ANY of its variables is missing rather
than all: half-configured reads as 'we set that up' while behaving
exactly like unconfigured.

The manifest is hand-maintained on purpose. convex/lib/r2/config.ts and
convex/lib/ai/pacing.ts read env through a dynamic key, so nine
variables — including all five R2 ones — cannot be found by grepping for
process.env.NAME.

\`convex env list\` prints NAME=VALUE, so the CLI extracts names
immediately and never logs, stores or reports the raw output."
```

---

### Task 6: Prove it in both checkouts

**Files:** none. Verification only.

**Interfaces:**
- Consumes: everything above.
- Produces: evidence that the guards fire in the situation they were built for.

The scenario this plan exists to prevent is two checkouts open and the wrong command typed in the
wrong window. Test exactly that.

- [ ] **Step 1: Dry-run each tenant from its own checkout**

```bash
cd /Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0 && npm run deploy:holidayys -- --dry-run
cd /Volumes/CurserDisk/Dev/wa-amani        && npm run deploy:amani      -- --dry-run
```

Expected: each prints its own host and brand. Read them — this is also a check that the tenant files
themselves are right, which nothing else verifies.

- [ ] **Step 2: Run the WRONG command in each checkout**

```bash
cd /Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0 && npm run deploy:amani      -- --dry-run
cd /Volumes/CurserDisk/Dev/wa-amani          && npm run deploy:holidayys  -- --dry-run
```

Expected: both fail with `.env.amani not found` / `.env.holidayys not found`, because each checkout
carries only its own tenant file.

That absence is itself a layer of defence — but a thin one, since a developer who wants both
tenants locally will create both files. The `TENANT` and host checks are what hold in that case,
which is why Task 3 Steps 3-4 tested them directly rather than relying on this.

- [ ] **Step 3: Run the full suite**

```bash
npx vitest run
```

Expected: PASS, now including the `scripts` project's new deploy tests.

- [ ] **Step 4: Check both deployments' configuration**

```bash
cd /Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0 && npm run env:check:holidayys
cd /Volumes/CurserDisk/Dev/wa-amani        && npm run env:check:amani
```

Read both reports properly. Expect them to differ, and expect at least one surprise — the website
conversion lane is Holidayys-only today, so `LANDING_CONVERSION_URL` should be dormant on Amani and
set on Holidayys. Anything else asymmetric is worth understanding before it is explained away.

**This is also the first check of whether Holidayys' deployment is ready for the merged code**, which
matters more than it looks: the merge brings Amani's features across, and a feature whose variables
were never set on Holidayys will run dormant there without saying so.

- [ ] **Step 5: Wire both checks into the rollout plan**

`2026-08-02-holidayys-rollout.md` predates this machinery and checks the deployment host by eye
(Task 1 Step 4). Make two edits to that file:

1. In Task 1 Step 4, note that from the second deploy onward
   `npm run deploy:<tenant> -- --dry-run` performs the same check mechanically and is preferred.
2. Add a new step to Task 1: run `npm run env:check:holidayys` **before** Task 2's Convex deploy, and
   treat a missing *required* variable as a stop. This is the gate that catches the Meta pixel,
   VAPID and R2 configuration before a deploy rather than after, and it is the cheapest moment to
   catch it.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-08-02-holidayys-rollout.md
git commit -m "docs(deploy): gate the rollout on the deploy preflight and env check

The rollout plan predates this machinery: it checks the target
deployment by eye, and has no check at all on whether the deployment is
configured to run the code it is about to receive.

Both are now mechanical. The env check becomes a stop-gate before the
Convex deploy, which is the cheapest moment to discover that the Meta
pixel, VAPID keys or R2 credentials were never set on this deployment —
all of which fail silently afterwards."
```

---

## What this plan does NOT do

- **Deploy the frontend.** Netlify builds each site from `main` with its own environment variables,
  set in the Netlify UI. Nothing here touches that, and the two Netlify sites remain the place where
  the five `NEXT_PUBLIC_BRAND_*` values live for production builds.
- **Set Convex environment variables.** Task 5 *checks* them and names what is missing; setting them
  stays a deliberate owner action (`npx convex env set`). A script that wrote deployment secrets
  would need to hold them, which is the thing this repo has carefully never done.
- **Remove the need for two checkouts.** Folder-per-tenant remains the first line of defence; this
  is the second. Both are cheap, and the failure they prevent is expensive.
- **Guard `npx convex run` or `npx convex env`.** Only `deploy` is wrapped. A destructive `convex
  run` against the wrong deployment is still possible and still relies on the operator — worth
  revisiting if it ever bites.
