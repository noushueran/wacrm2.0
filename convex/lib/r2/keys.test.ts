import { expect, test } from "vitest";
import { buildMediaKey, parseMediaKey } from "./keys";

const FIXED = () => "0123456789abcdef0123456789abcdef";

test("buildMediaKey lays out accountId/kind/uuid.ext", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "inbound",
    filename: "voice-note.ogg",
    randomHex: FIXED,
  });
  expect(key).toBe(
    "acc123/inbound/0123456789abcdef0123456789abcdef.ogg",
  );
});

test("buildMediaKey falls back to the content type when there is no filename", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "ad",
    contentType: "image/jpeg",
    randomHex: FIXED,
  });
  expect(key).toBe("acc123/ad/0123456789abcdef0123456789abcdef.jpg");
});

test("buildMediaKey omits the extension when neither is known", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "outbound",
    randomHex: FIXED,
  });
  expect(key).toBe("acc123/outbound/0123456789abcdef0123456789abcdef");
});

test("buildMediaKey never lets a hostile filename escape its prefix", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "outbound",
    filename: "../../other-account/evil.png",
    randomHex: FIXED,
  });
  expect(key).toBe("acc123/outbound/0123456789abcdef0123456789abcdef.png");
  expect(key).not.toContain("..");
});

test("buildMediaKey generates a distinct key per call", () => {
  const a = buildMediaKey({ accountId: "acc123", kind: "inbound" });
  const b = buildMediaKey({ accountId: "acc123", kind: "inbound" });
  expect(a).not.toBe(b);
});

test("parseMediaKey round-trips a built key", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "template",
    filename: "header.png",
    randomHex: FIXED,
  });
  expect(parseMediaKey(key)).toEqual({ accountId: "acc123", kind: "template" });
});

test("parseMediaKey rejects malformed and unknown-kind keys", () => {
  expect(parseMediaKey("nope")).toBeNull();
  expect(parseMediaKey("acc123/bogus/file.png")).toBeNull();
  expect(parseMediaKey("")).toBeNull();
});
