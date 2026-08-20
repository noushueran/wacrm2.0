import { describe, it, expect } from "vitest";
import { avatarClasses, avatarSeed, contactInitials } from "./avatar";

describe("avatarClasses", () => {
  it("is stable for the same seed", () => {
    expect(avatarClasses("971501234567")).toBe(avatarClasses("971501234567"));
  });

  it("always returns a class pair from the palette", () => {
    for (let i = 0; i < 200; i++) {
      const cls = avatarClasses(`97150${i}`);
      expect(cls).toMatch(/^bg-[a-z]+-500\/15 text-[a-z]+-700 dark:text-[a-z]+-300$/);
    }
  });

  it("never assigns red — reserved for expiry and destructive actions", () => {
    for (let i = 0; i < 500; i++) {
      expect(avatarClasses(`9715${i}`)).not.toContain("bg-red-");
    }
  });

  it("spreads numbers that share a country and carrier prefix", () => {
    // The real input shape: an account's contacts differ only in the last
    // digits. A weak hash buckets these onto one colour and the list looks
    // monochrome, which is the whole reason FNV-1a is used over h*31+c.
    const seen = new Set(
      Array.from({ length: 40 }, (_, i) =>
        avatarClasses(`9715012345${String(i).padStart(2, "0")}`),
      ),
    );
    expect(seen.size).toBeGreaterThan(4);
  });

  it("does not depend on signed 32-bit coercion", () => {
    // A seed whose running hash crosses the sign bit. Guards the `>>> 0`
    // in the mixing step: without it this throws off the modulo.
    expect(() => avatarClasses("\u{10FFFF}".repeat(64))).not.toThrow();
    expect(avatarClasses("zzzzzzzzzzzzzzzz")).toMatch(/^bg-/);
  });
});

describe("avatarSeed", () => {
  it("collapses every phone format onto one seed", () => {
    // The real bug this prevents: the conversation list seeds from
    // `phone_normalized` and the chat header from the display `phone`, so
    // without this a contact changes colour when you open their thread.
    const forms = [
      "+971 50 123 4567",
      "+971501234567",
      "971501234567",
      "971-50-123-4567",
      "(971) 50 123 4567",
    ];
    const colors = new Set(forms.map(avatarClasses));
    expect(colors.size).toBe(1);
  });

  it("keeps a digitless seed rather than collapsing to empty", () => {
    expect(avatarSeed("ada")).toBe("ada");
    expect(avatarClasses("ada")).not.toBe(avatarClasses("bob"));
  });
});

describe("contactInitials", () => {
  it("takes one letter from a single-word name", () => {
    expect(contactInitials("Priya")).toBe("P");
  });

  it("takes first and last initials from a multi-word name", () => {
    expect(contactInitials("Noushad Eranniyan")).toBe("NE");
  });

  it("skips the middle name rather than returning three letters", () => {
    expect(contactInitials("Ada Byron Lovelace")).toBe("AL");
  });

  it("returns empty for a bare phone number", () => {
    // The common case, not an edge case: `displayName` falls back to the
    // phone for every contact WhatsApp gave no profile name for. "+" and
    // "9" are not initials — callers draw a person glyph instead.
    expect(contactInitials("+971 50 123 4567")).toBe("");
    expect(contactInitials("971501234567")).toBe("");
  });

  it("ignores leading non-letter words but keeps the letters after them", () => {
    expect(contactInitials("+971 Ahmed")).toBe("A");
  });

  it("handles Arabic and Malayalam names", () => {
    // uppercasing is a no-op in both scripts — the point is that a letter
    // is found at all, which `[A-Za-z]` would miss.
    expect(contactInitials("أحمد")).toBe("أ");
    expect(contactInitials("നൗഷാദ് ഇറനിയൻ")).toBe("നഇ");
  });

  it("splits on punctuation as well as spaces", () => {
    expect(contactInitials("Ada.Lovelace")).toBe("AL");
    expect(contactInitials("ada_lovelace")).toBe("AL");
  });

  it("returns empty for an empty or whitespace name", () => {
    expect(contactInitials("")).toBe("");
    expect(contactInitials("   ")).toBe("");
  });

  it("takes whole code points, not UTF-16 halves", () => {
    // A name starting outside the BMP: `[0]` on the raw string would slice
    // a lone surrogate and render as a replacement character.
    expect(contactInitials("𝐀da")).toBe("𝐀");
  });
});
