import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array } from "./vapid";

describe("urlBase64ToUint8Array", () => {
  it("decodes a url-safe base64 VAPID key to bytes", () => {
    // "hello" in url-safe base64 is "aGVsbG8".
    const bytes = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });
});
