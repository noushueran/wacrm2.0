import { expect, test, vi, afterEach } from "vitest";
import { putObject, deleteObject, presignPut } from "./client";
import type { R2Config } from "./config";

const CFG: R2Config = {
  bucket: "wa-holidayys",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secretexamplekey",
  publicHost: "https://objs.holidayys.co",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test("putObject PUTs to endpoint/bucket/key with a signed Authorization header", async () => {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (req: Request) => {
    calls.push(req);
    return new Response(null, { status: 200 });
  });

  await putObject(CFG, {
    key: "acc1/inbound/abc.ogg",
    body: new Blob(["hello"], { type: "audio/ogg" }),
    contentType: "audio/ogg",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe("PUT");
  expect(calls[0].url).toBe(
    "https://acct.r2.cloudflarestorage.com/wa-holidayys/acc1/inbound/abc.ogg",
  );
  expect(calls[0].headers.get("content-type")).toBe("audio/ogg");
  expect(calls[0].headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
  // Final-review fix: pinned explicitly so the body is never read a
  // second time just to hash it — see `putObject`'s own comment.
  expect(calls[0].headers.get("x-amz-content-sha256")).toBe(
    "UNSIGNED-PAYLOAD",
  );
});

test("putObject throws with the status when R2 rejects the write", async () => {
  vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));

  await expect(
    putObject(CFG, {
      key: "acc1/inbound/abc.ogg",
      body: new Blob(["x"], { type: "audio/ogg" }),
      contentType: "audio/ogg",
    }),
  ).rejects.toThrow(/403/);
});

test("deleteObject issues a signed DELETE and tolerates a 404", async () => {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (req: Request) => {
    calls.push(req);
    return new Response(null, { status: 404 });
  });

  await deleteObject(CFG, "acc1/outbound/gone.png");

  expect(calls[0].method).toBe("DELETE");
  expect(calls[0].url).toBe(
    "https://acct.r2.cloudflarestorage.com/wa-holidayys/acc1/outbound/gone.png",
  );
});

test("presignPut returns a query-signed URL carrying expiry and signature", async () => {
  const url = await presignPut(CFG, {
    key: "acc1/outbound/photo.png",
    contentType: "image/png",
    expiresSeconds: 900,
  });

  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe(
    "https://acct.r2.cloudflarestorage.com/wa-holidayys/acc1/outbound/photo.png",
  );
  expect(parsed.searchParams.get("X-Amz-Expires")).toBe("900");
  expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
  expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  // Content-Type is signed, so the browser must send exactly this value.
  expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toContain(
    "content-type",
  );
});
