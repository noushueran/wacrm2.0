import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConvexReactClient, ReactMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
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
// via `useConvex()` — just the two methods `uploadAccountMedia`/
// `deleteAccountMedia` call. Cast rather than implementing the real class,
// since the real `ConvexReactClient` carries a lot more (connection
// state, subscriptions, etc.) that these functions never touch.
function fakeConvex(overrides: {
  query?: ReturnType<typeof vi.fn>;
  mutation?: ReturnType<typeof vi.fn>;
}): ConvexReactClient {
  return {
    query: overrides.query ?? vi.fn(),
    mutation: overrides.mutation ?? vi.fn(),
  } as unknown as ConvexReactClient;
}

const STORAGE_ID = "storage-abc123" as Id<"_storage">;

describe("uploadAccountMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads the file and returns the resolved url + storageId", async () => {
    const file = new File(["hello"], "photo.png", { type: "image/png" });
    const generateUploadUrl = vi.fn(async () => "https://upload.example.com/put");

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://upload.example.com/put");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
        "image/png",
      );
      expect(init?.body).toBe(file);
      return {
        ok: true,
        json: async () => ({ storageId: STORAGE_ID }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryMock = vi.fn(async () => "https://cdn.example.com/resolved.png");
    const convex = fakeConvex({ query: queryMock });

    const result = await uploadAccountMedia(
      convex,
      generateUploadUrl as unknown as ReactMutation<typeof api.files.generateUploadUrl>,
      file,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(api.files.getUrl, {
      storageId: STORAGE_ID,
    });
    expect(result).toEqual({
      url: "https://cdn.example.com/resolved.png",
      storageId: STORAGE_ID,
    });
  });

  it("throws when the upload POST fails", async () => {
    const file = new File(["hello"], "photo.png", { type: "image/png" });
    const generateUploadUrl = vi.fn(async () => "https://upload.example.com/put");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }) as Response),
    );
    const convex = fakeConvex({});

    await expect(
      uploadAccountMedia(
        convex,
        generateUploadUrl as unknown as ReactMutation<typeof api.files.generateUploadUrl>,
        file,
      ),
    ).rejects.toThrow();
  });

  it("throws when the resolved url comes back null", async () => {
    const file = new File(["hello"], "photo.png", { type: "image/png" });
    const generateUploadUrl = vi.fn(async () => "https://upload.example.com/put");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: true, json: async () => ({ storageId: STORAGE_ID }) }) as Response,
      ),
    );
    const convex = fakeConvex({ query: vi.fn(async () => null) });

    await expect(
      uploadAccountMedia(
        convex,
        generateUploadUrl as unknown as ReactMutation<typeof api.files.generateUploadUrl>,
        file,
      ),
    ).rejects.toThrow();
  });
});

describe("deleteAccountMedia", () => {
  it("calls files.remove with the given storageId", async () => {
    const mutationMock = vi.fn(async () => undefined);
    const convex = fakeConvex({ mutation: mutationMock });

    await deleteAccountMedia(convex, STORAGE_ID);

    expect(mutationMock).toHaveBeenCalledWith(api.files.remove, {
      storageId: STORAGE_ID,
    });
  });

  it("propagates a rejection from the mutation", async () => {
    const convex = fakeConvex({
      mutation: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(deleteAccountMedia(convex, STORAGE_ID)).rejects.toThrow("boom");
  });
});
