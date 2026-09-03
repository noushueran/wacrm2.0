import { describe, it, expect } from "vitest";
import { shouldBeMember, EXCLUDED_STAGES, diffMembership, type MemberCandidate } from "./metaAudience";

function candidate(over: Partial<MemberCandidate> = {}): MemberCandidate {
  return {
    contactId: "c1",
    phoneNormalized: "971501234567",
    doNotContact: false,
    stages: [],
    ...over,
  };
}

describe("shouldBeMember", () => {
  it("includes an ordinary contact with a usable phone", () => {
    expect(shouldBeMember(candidate())).toBe(true);
  });

  it("excludes a contact marked do-not-contact", () => {
    expect(shouldBeMember(candidate({ doNotContact: true }))).toBe(false);
  });

  it("excludes a contact with a purchased conversation", () => {
    expect(shouldBeMember(candidate({ stages: ["purchased"] }))).toBe(false);
  });

  it("excludes when ANY conversation is purchased, not just the first", () => {
    expect(shouldBeMember(candidate({ stages: ["new_lead", "purchased"] }))).toBe(false);
  });

  it("KEEPS a lost lead — they did not buy, so they are still worth retargeting", () => {
    expect(shouldBeMember(candidate({ stages: ["lost"] }))).toBe(true);
  });

  it("excludes a phone too short to carry a country code", () => {
    expect(shouldBeMember(candidate({ phoneNormalized: "12345" }))).toBe(false);
  });

  it("excludes an empty phone", () => {
    expect(shouldBeMember(candidate({ phoneNormalized: "" }))).toBe(false);
  });

  it("names purchased as the only excluded stage", () => {
    expect([...EXCLUDED_STAGES]).toEqual(["purchased"]);
  });
});

describe("diffMembership", () => {
  const H1 = "a".repeat(64);
  const H2 = "b".repeat(64);
  const H3 = "c".repeat(64);

  it("adds a wanted contact the mirror has never seen", () => {
    const d = diffMembership([{ contactId: "c1", phoneHash: H1, wanted: true }], []);
    expect(d.toAdd.map((r) => r.contactId)).toEqual(["c1"]);
    expect(d.toRemove).toEqual([]);
  });

  it("does not re-add a contact already recorded as a member", () => {
    const d = diffMembership(
      [{ contactId: "c1", phoneHash: H1, wanted: true }],
      [{ contactId: "c1", phoneHash: H1, isMember: true }],
    );
    expect(d.toAdd).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it("removes a member who is no longer wanted", () => {
    const d = diffMembership(
      [{ contactId: "c1", phoneHash: H1, wanted: false }],
      [{ contactId: "c1", phoneHash: H1, isMember: true }],
    );
    expect(d.toRemove.map((r) => r.contactId)).toEqual(["c1"]);
    expect(d.toAdd).toEqual([]);
  });

  it("does not re-remove a contact already recorded as removed", () => {
    const d = diffMembership(
      [{ contactId: "c1", phoneHash: H1, wanted: false }],
      [{ contactId: "c1", phoneHash: H1, isMember: false }],
    );
    expect(d.toRemove).toEqual([]);
    expect(d.toAdd).toEqual([]);
  });

  it("re-adds a contact whose do-not-contact was cleared", () => {
    const d = diffMembership(
      [{ contactId: "c1", phoneHash: H1, wanted: true }],
      [{ contactId: "c1", phoneHash: H1, isMember: false }],
    );
    expect(d.toAdd.map((r) => r.contactId)).toEqual(["c1"]);
  });

  it("removes the OLD hash and adds the new one when a phone changes", () => {
    const d = diffMembership(
      [{ contactId: "c1", phoneHash: H2, wanted: true }],
      [{ contactId: "c1", phoneHash: H1, isMember: true }],
    );
    expect(d.toRemove.map((r) => r.phoneHash)).toEqual([H1]);
    expect(d.toAdd.map((r) => r.phoneHash)).toEqual([H2]);
  });

  it("removes a mirrored member who vanished from the desired set entirely", () => {
    const d = diffMembership([], [{ contactId: "c9", phoneHash: H3, isMember: true }]);
    expect(d.toRemove.map((r) => r.contactId)).toEqual(["c9"]);
  });

  it("ignores a vanished contact that was already not a member", () => {
    const d = diffMembership([], [{ contactId: "c9", phoneHash: H3, isMember: false }]);
    expect(d.toRemove).toEqual([]);
  });

  it("collapses a duplicated contactId, keeping the last occurrence", () => {
    const d = diffMembership(
      [
        { contactId: "c1", phoneHash: H1, wanted: true },
        { contactId: "c1", phoneHash: H2, wanted: true },
      ],
      [{ contactId: "c1", phoneHash: H1, isMember: true }],
    );
    expect(d.toRemove.map((r) => r.phoneHash)).toEqual([H1]);
    expect(d.toAdd.map((r) => r.phoneHash)).toEqual([H2]);
  });

  it("does not count a duplicated contactId twice", () => {
    const d = diffMembership(
      [
        { contactId: "c1", phoneHash: H1, wanted: true },
        { contactId: "c1", phoneHash: H1, wanted: true },
      ],
      [{ contactId: "c1", phoneHash: H1, isMember: true }],
    );
    const totalOps = d.toAdd.length + d.toRemove.length + d.unchanged;
    expect(totalOps).toBe(1);
  });
});
