import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConvexReactClient, ReactMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import {
  MEDIA_MAX_BYTES_BY_KIND,
  uploadAccountMedia,
  deleteAccountMedia,
} from "./upload-media";

describe("MEDIA_MAX_BYTES_BY_KIND", () => {
  it("caps images at Meta's tighter 5 MB limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.image).toBe(5 * 1024 * 1024);
  });

  it("caps video/audio/document at the 16 MB bucket limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.video).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.audio).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.document).toBe(16 * 1024 * 1024);
  });
});

// Minimal fake standing in for the `ConvexReactClient` a caller threads in
// via `useConvex()` — just the one method `deleteAccountMedia` calls.
// Cast rather than implementing the real class, since the real
// `ConvexReactClient` carries a lot more (connection state,
// subscriptions, etc.) that these functions never touch.
function fakeConvex(overrides: {
  mutation?: ReturnType<typeof vi.fn>;
}): ConvexReactClient {
  return {
    mutation: overrides.mutation ?? vi.fn(),
  } as unknown as ConvexReactClient;
}

const KEY = "acc123/outbound/abc123.png";

describe("uploadAccountMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints an upload via startUpload, PUTs the file with a byte-identical Content-Type, and returns the key", async () => {
    const file = new File(["hello"], "photo.png", { type: "image/png" });
    const startUpload = vi.fn(async () => ({
      uploadUrl: "https://r2.example.com/put?X-Amz-Signature=abc",
      key: KEY,
    }));

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://r2.example.com/put?X-Amz-Signature=abc",
      );
      // The upload verb is R2's PUT, not Convex's POST.
      expect(init?.method).toBe("PUT");
      // Byte-identical to what startUpload was asked to sign — this is
      // the one contract that must never drift (see convex/lib/r2/
      // client.ts's presignPut doc comment: a mismatch here is a
      // signature-mismatch rejection from R2, not a friendly error).
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
        "image/png",
      );
      expect(init?.body).toBe(file);
      return { ok: true } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const convex = fakeConvex({});
    const result = await uploadAccountMedia(
      convex,
      startUpload as unknown as ReactMutation<typeof api.files.startUpload>,
      file,
      "outbound",
    );

    expect(startUpload).toHaveBeenCalledWith({
      kind: "outbound",
      contentType: "image/png",
      filename: "photo.png",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ key: KEY });
  });

  it("falls back to application/octet-stream when the File carries no type", async () => {
    const file = new File(["hello"], "blob", { type: "" });
    const startUpload = vi.fn(async () => ({
      uploadUrl: "https://r2.example.com/put",
      key: KEY,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));

    await uploadAccountMedia(
      fakeConvex({}),
      startUpload as unknown as ReactMutation<typeof api.files.startUpload>,
      file,
      "outbound",
    );

    expect(startUpload).toHaveBeenCalledWith({
      kind: "outbound",
      contentType: "application/octet-stream",
      filename: "blob",
    });
  });

  it("throws when the R2 PUT fails", async () => {
    const file = new File(["hello"], "photo.png", { type: "image/png" });
    const startUpload = vi.fn(async () => ({
      uploadUrl: "https://r2.example.com/put",
      key: KEY,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }) as Response),
    );

    await expect(
      uploadAccountMedia(
        fakeConvex({}),
        startUpload as unknown as ReactMutation<typeof api.files.startUpload>,
        file,
        "outbound",
      ),
    ).rejects.toThrow();
  });
});

describe("deleteAccountMedia", () => {
  it("calls files.remove with the given key", async () => {
    const mutationMock = vi.fn(async () => undefined);
    const convex = fakeConvex({ mutation: mutationMock });

    await deleteAccountMedia(convex, KEY);

    expect(mutationMock).toHaveBeenCalledWith(api.files.remove, { key: KEY });
  });

  it("propagates a rejection from the mutation", async () => {
    const convex = fakeConvex({
      mutation: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(deleteAccountMedia(convex, KEY)).rejects.toThrow("boom");
  });
});
