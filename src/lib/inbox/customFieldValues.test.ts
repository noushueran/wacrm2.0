import { describe, it, expect } from "vitest";
import { pruneValueForField } from "./customFieldValues";
import type { CustomField } from "@/types";

const field = (field_type: string, options?: string[]): CustomField => ({
  id: "f1",
  user_id: "",
  account_id: "",
  field_name: "Field",
  field_type,
  field_options: options ? { options } : undefined,
  created_at: new Date().toISOString(),
});

describe("pruneValueForField", () => {
  it("keeps a select value that is still a valid option", () => {
    expect(pruneValueForField(field("select", ["a", "b"]), "a")).toBe("a");
  });

  it("drops a select value that is no longer a valid option", () => {
    expect(pruneValueForField(field("select", ["a", "b"]), "stale")).toBeNull();
  });

  it("keeps only the still-valid items of a multiselect value", () => {
    const result = pruneValueForField(
      field("multiselect", ["a", "b"]),
      JSON.stringify(["a", "stale", "b"]),
    );
    expect(result).toBe(JSON.stringify(["a", "b"]));
  });

  it("drops a multiselect value when every item is stale", () => {
    const result = pruneValueForField(
      field("multiselect", ["a", "b"]),
      JSON.stringify(["stale1", "stale2"]),
    );
    expect(result).toBeNull();
  });

  it("drops a multiselect value that isn't valid JSON", () => {
    expect(pruneValueForField(field("multiselect", ["a", "b"]), "not-json")).toBeNull();
  });

  it("passes text values through unchanged", () => {
    expect(pruneValueForField(field("text"), "hello world")).toBe("hello world");
  });

  it("drops the value when the field is undefined (e.g. deleted field)", () => {
    expect(pruneValueForField(undefined, "anything")).toBeNull();
  });
});
