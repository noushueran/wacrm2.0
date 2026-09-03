import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const accountId = await ctx.db.insert("accounts", {
      name: "Amani",
      defaultCurrency: "AED",
      ownerUserId: userId,
    });
    return accountId as Id<"accounts">;
  });
}

describe("collectDesired", () => {
  test("marks an ordinary contact wanted", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      });
    });

    const rows = await t.query(internal.metaAudienceSync.collectDesired, {
      accountId,
      limit: 100,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].wanted).toBe(true);
  });

  test("marks a purchased contact not wanted", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      });
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        funnel: { stage: "purchased", stageUpdatedAt: Date.now() },
      });
    });

    const rows = await t.query(internal.metaAudienceSync.collectDesired, {
      accountId,
      limit: 100,
    });
    expect(rows[0].wanted).toBe(false);
  });

  test("marks a lost contact still wanted", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      });
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        funnel: { stage: "lost", stageUpdatedAt: Date.now() },
      });
    });

    const rows = await t.query(internal.metaAudienceSync.collectDesired, {
      accountId,
      limit: 100,
    });
    expect(rows[0].wanted).toBe(true);
  });

  test("excludes a contact when ANY of several conversations is purchased", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      });
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        funnel: { stage: "new_lead", stageUpdatedAt: Date.now() },
      });
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        funnel: { stage: "lost", stageUpdatedAt: Date.now() },
      });
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        funnel: { stage: "purchased", stageUpdatedAt: Date.now() },
      });
    });

    const rows = await t.query(internal.metaAudienceSync.collectDesired, {
      accountId,
      limit: 100,
    });
    expect(rows[0].wanted).toBe(false);
  });
});

import { chunk, hashPhone, GRAPH_BATCH } from "./metaAudienceSync";

describe("chunk", () => {
  test("splits evenly", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
  test("keeps a short tail", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
  test("returns nothing for an empty list", () => {
    expect(chunk([], 300)).toEqual([]);
  });
  test("batch size is 300", () => {
    expect(GRAPH_BATCH).toBe(300);
  });
});

describe("hashPhone", () => {
  test("matches the digest Meta was sent in the manual backfill", async () => {
    expect(await hashPhone("971501234567")).toBe(
      "b7a8f5085aa733eb29857a02945bc84a5227e693708d469ec9fb21d34e9e44f5",
    );
  });
  test("tolerates punctuation and a leading plus", async () => {
    expect(await hashPhone("+971 50 123 4567")).toBe(
      "b7a8f5085aa733eb29857a02945bc84a5227e693708d469ec9fb21d34e9e44f5",
    );
  });
  test("returns null for a number too short to carry a country code", async () => {
    expect(await hashPhone("12345")).toBeNull();
  });
});

describe("mirror", () => {
  test("applyMirror upserts, readMirror reads back", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    const contactId = await t.run(async (ctx) =>
      ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      }),
    );

    await t.mutation(internal.metaAudienceSync.applyMirror, {
      accountId,
      rows: [{ contactId, phoneHash: "a".repeat(64), isMember: true }],
    });

    let rows = await t.query(internal.metaAudienceSync.readMirror, { accountId });
    expect(rows).toEqual([
      { contactId, phoneHash: "a".repeat(64), isMember: true },
    ]);

    // Second write updates in place rather than inserting a duplicate.
    await t.mutation(internal.metaAudienceSync.applyMirror, {
      accountId,
      rows: [{ contactId, phoneHash: "b".repeat(64), isMember: false }],
    });

    rows = await t.query(internal.metaAudienceSync.readMirror, { accountId });
    expect(rows).toHaveLength(1);
    expect(rows[0].isMember).toBe(false);
    expect(rows[0].phoneHash).toBe("b".repeat(64));
  });
});

describe("syncAudience", () => {
  test("no-ops when META_CUSTOM_AUDIENCE_ID is unset", async () => {
    const prevId = process.env.META_CUSTOM_AUDIENCE_ID;
    const prevToken = process.env.META_ADS_ACCESS_TOKEN;
    delete process.env.META_CUSTOM_AUDIENCE_ID;
    delete process.env.META_ADS_ACCESS_TOKEN;
    try {
      const t = convexTest(schema, modules);
      await seedAccount(t);
      const result = await t.action(internal.metaAudienceSync.syncAudience, {});
      expect(result.skipped).toBe(true);
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    } finally {
      if (prevId) process.env.META_CUSTOM_AUDIENCE_ID = prevId;
      if (prevToken) process.env.META_ADS_ACCESS_TOKEN = prevToken;
    }
  });

  test("adds a wanted contact and records it in the mirror", async () => {
    const prevId = process.env.META_CUSTOM_AUDIENCE_ID;
    const prevToken = process.env.META_ADS_ACCESS_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.META_CUSTOM_AUDIENCE_ID = "52503553736038";
    process.env.META_ADS_ACCESS_TOKEN = "test-token";

    const calls: { method: string; count: number }[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ method: String(init.method), count: body.payload.data.length });
      return new Response(
        JSON.stringify({ num_received: body.payload.data.length, num_invalid_entries: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const t = convexTest(schema, modules);
      const accountId = await seedAccount(t);
      await t.run(async (ctx) => {
        await ctx.db.insert("contacts", {
          accountId,
          phone: "+971501234567",
          phoneNormalized: "971501234567",
        });
      });

      const result = await t.action(internal.metaAudienceSync.syncAudience, {});
      expect(result.skipped).toBe(false);
      expect(result.added).toBe(1);
      expect(result.failedBatches).toBe(0);
      expect(calls).toEqual([{ method: "POST", count: 1 }]);

      // A second run is a no-op — the mirror already believes it is a member.
      const again = await t.action(internal.metaAudienceSync.syncAudience, {});
      expect(again.added).toBe(0);
      expect(again.unchanged).toBe(1);
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
      if (prevId) process.env.META_CUSTOM_AUDIENCE_ID = prevId;
      else delete process.env.META_CUSTOM_AUDIENCE_ID;
      if (prevToken) process.env.META_ADS_ACCESS_TOKEN = prevToken;
      else delete process.env.META_ADS_ACCESS_TOKEN;
    }
  });

  test("removes a contact once do-not-contact is set", async () => {
    const prevId = process.env.META_CUSTOM_AUDIENCE_ID;
    const prevToken = process.env.META_ADS_ACCESS_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.META_CUSTOM_AUDIENCE_ID = "52503553736038";
    process.env.META_ADS_ACCESS_TOKEN = "test-token";

    const methods: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      methods.push(String(init.method));
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ num_received: body.payload.data.length, num_invalid_entries: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const t = convexTest(schema, modules);
      const accountId = await seedAccount(t);
      const contactId = await t.run(async (ctx) =>
        ctx.db.insert("contacts", {
          accountId,
          phone: "+971501234567",
          phoneNormalized: "971501234567",
        }),
      );

      await t.action(internal.metaAudienceSync.syncAudience, {});
      expect(methods).toEqual(["POST"]);

      await t.run(async (ctx) => {
        const noteId = await ctx.db.insert("contactNotes", {
          accountId,
          contactId,
          noteText: "asked to stop",
        });
        await ctx.db.patch(contactId, {
          doNotContact: { at: Date.now(), noteId },
        });
      });

      const result = await t.action(internal.metaAudienceSync.syncAudience, {});
      expect(result.removed).toBe(1);
      expect(methods).toEqual(["POST", "DELETE"]);
    } finally {
      globalThis.fetch = realFetch;
      if (prevId) process.env.META_CUSTOM_AUDIENCE_ID = prevId;
      else delete process.env.META_CUSTOM_AUDIENCE_ID;
      if (prevToken) process.env.META_ADS_ACCESS_TOKEN = prevToken;
      else delete process.env.META_ADS_ACCESS_TOKEN;
    }
  });

  test("does not update the mirror when Meta answers 2xx with an unparsable body", async () => {
    // sendAudienceDelta falls back to `received: 0` when the body can't be
    // parsed as JSON, even though `res.ok` is true. That is exactly the
    // false-success case the mirror must never record — Meta's audience API
    // is write-only, so a wrongly-recorded success can never be detected or
    // repaired by a later pass.
    const prevId = process.env.META_CUSTOM_AUDIENCE_ID;
    const prevToken = process.env.META_ADS_ACCESS_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.META_CUSTOM_AUDIENCE_ID = "52503553736038";
    process.env.META_ADS_ACCESS_TOKEN = "test-token";

    globalThis.fetch = (async () => {
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const t = convexTest(schema, modules);
      const accountId = await seedAccount(t);
      await t.run(async (ctx) => {
        await ctx.db.insert("contacts", {
          accountId,
          phone: "+971501234567",
          phoneNormalized: "971501234567",
        });
      });

      const result = await t.action(internal.metaAudienceSync.syncAudience, {});
      expect(result.added).toBe(0);
      expect(result.failedBatches).toBe(1);

      // The mirror must be untouched — a second run should still attempt
      // this same contact, not believe it is already a member.
      const mirror = await t.query(internal.metaAudienceSync.readMirror, {
        accountId,
      });
      expect(mirror).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      if (prevId) process.env.META_CUSTOM_AUDIENCE_ID = prevId;
      else delete process.env.META_CUSTOM_AUDIENCE_ID;
      if (prevToken) process.env.META_ADS_ACCESS_TOKEN = prevToken;
      else delete process.env.META_ADS_ACCESS_TOKEN;
    }
  });

  test("does not advance the mirror when a phone change half-succeeds (ADD ok, REMOVE fails)", async () => {
    // A contact whose phone changed produces BOTH a toAdd (new digest) and
    // a toRemove (old digest) for the same contactId in one pass. If the
    // ADD lands but the REMOVE fails, the mirror must be left exactly as
    // it was — advancing it to the new digest here would lose the only
    // record that the old digest is still a live member in Meta, and
    // Meta's audience API can never be read back to notice. This is the
    // scenario `applyMirror`'s one-row-per-contact upsert cannot handle
    // if the two operations are written independently.
    const prevId = process.env.META_CUSTOM_AUDIENCE_ID;
    const prevToken = process.env.META_ADS_ACCESS_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.META_CUSTOM_AUDIENCE_ID = "52503553736038";
    process.env.META_ADS_ACCESS_TOKEN = "test-token";

    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      if (String(init.method) === "POST") {
        const body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            num_received: body.payload.data.length,
            num_invalid_entries: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: "internal error" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const t = convexTest(schema, modules);
      const accountId = await seedAccount(t);
      const contactId = await t.run(async (ctx) =>
        ctx.db.insert("contacts", {
          accountId,
          phone: "+971501234567",
          phoneNormalized: "971501234567",
        }),
      );

      const oldHash = await hashPhone("971501234567");
      if (!oldHash) throw new Error("expected a hash for the seed phone");
      await t.mutation(internal.metaAudienceSync.applyMirror, {
        accountId,
        rows: [{ contactId, phoneHash: oldHash, isMember: true }],
      });

      // The phone changes — the desired digest no longer matches the
      // mirror's, so diffMembership emits both a toRemove(old) and a
      // toAdd(new) for this same contactId.
      await t.run(async (ctx) => {
        await ctx.db.patch(contactId, { phoneNormalized: "971509999999" });
      });

      const result = await t.action(internal.metaAudienceSync.syncAudience, {});
      expect(result.added).toBe(1);
      expect(result.failedBatches).toBe(1);

      // The mirror must still report the OLD hash — untouched — so the
      // next nightly pass retries the removal (and, since the desired
      // digest still differs, the add too).
      const mirror = await t.query(internal.metaAudienceSync.readMirror, {
        accountId,
      });
      expect(mirror).toEqual([{ contactId, phoneHash: oldHash, isMember: true }]);
    } finally {
      globalThis.fetch = realFetch;
      if (prevId) process.env.META_CUSTOM_AUDIENCE_ID = prevId;
      else delete process.env.META_CUSTOM_AUDIENCE_ID;
      if (prevToken) process.env.META_ADS_ACCESS_TOKEN = prevToken;
      else delete process.env.META_ADS_ACCESS_TOKEN;
    }
  });
});
