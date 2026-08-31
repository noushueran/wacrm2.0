import { describe, expect, test } from "vitest";
import { MIN_PASSWORD_LENGTH, passwordRejectionReason } from "./password";

describe("passwordRejectionReason", () => {
  test("accepts a reasonable password", () => {
    expect(passwordRejectionReason("correct-horse-battery")).toBeNull();
  });

  test("accepts at exactly the length floor", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(passwordRejectionReason("g7mQ2xLp")).toBeNull();
  });

  test("rejects below the length floor", () => {
    expect(passwordRejectionReason("g7mQ2xL")).toMatch(/at least 8 characters/);
    expect(passwordRejectionReason("")).toMatch(/at least 8 characters/);
  });

  // The point of the screen: these all clear the length floor, and are
  // exactly what a 10-guesses-per-hour attacker spends its budget on.
  describe("rejects common passwords that clear the length floor", () => {
    for (const p of [
      "password",
      "password123",
      "passw0rd",
      "p@ssw0rd",
      "qwerty123",
      "1q2w3e4r",
      "iloveyou",
      "letmein1",
      "welcome123",
      "admin123",
      "changeme",
      "whatsapp123",
      "amani1234",
    ]) {
      test(p, () => {
        expect(passwordRejectionReason(p)).toMatch(/too common/);
      });
    }
  });

  test("common-password screen is case-insensitive", () => {
    expect(passwordRejectionReason("PASSWORD123")).toMatch(/too common/);
    expect(passwordRejectionReason("PaSsW0Rd")).toMatch(/too common/);
  });

  test("rejects a single repeated character", () => {
    expect(passwordRejectionReason("aaaaaaaa")).toMatch(/repeated character/);
    expect(passwordRejectionReason("11111111111")).toMatch(/repeated character/);
  });

  test("rejects consecutive-character sequences", () => {
    expect(passwordRejectionReason("12345678")).not.toBeNull();
    expect(passwordRejectionReason("abcdefgh")).toMatch(/consecutive/);
    expect(passwordRejectionReason("87654321")).toMatch(/consecutive/);
  });

  test("allows a short sequence inside an otherwise fine password", () => {
    // Only an ENTIRELY sequential password is rejected — "abc" appearing
    // in a longer, non-sequential password is not a reason to refuse.
    expect(passwordRejectionReason("abc-tiger-vault")).toBeNull();
  });

  test("does not impose character-class rules", () => {
    // Deliberate: NIST SP 800-63B advises against forced symbol/digit/
    // case classes. An all-lowercase passphrase is fine.
    expect(passwordRejectionReason("tigervaultmarble")).toBeNull();
  });
});
