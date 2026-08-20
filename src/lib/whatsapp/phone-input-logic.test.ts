import { describe, expect, it } from "vitest";
import {
  DEFAULT_COUNTRY,
  composeE164,
  formatAsYouType,
  isCompletePhoneNumber,
  isValidNationalNumber,
  listCountryOptions,
  nextPickerState,
  splitE164,
} from "./phone-input-logic";

describe("phone-input-logic", () => {
  it("defaults to the UAE", () => {
    expect(DEFAULT_COUNTRY).toBe("AE");
  });

  it("lists countries with dial codes and a flag, including AE +971", () => {
    const opts = listCountryOptions();
    const ae = opts.find((o) => o.country === "AE");
    expect(ae?.dialCode).toBe("971");
    expect(ae?.flag).toBe("🇦🇪");
    expect(opts.length).toBeGreaterThan(100);
  });

  it("composes a national number into E.164", () => {
    expect(composeE164("AE", "50 123 4567")).toBe("+971501234567");
    expect(composeE164("GB", "7700 900123")).toBe("+447700900123");
  });

  it("validates a national number for its country", () => {
    expect(isValidNationalNumber("AE", "50 123 4567")).toBe(true);
    expect(isValidNationalNumber("AE", "123")).toBe(false);
  });

  it("only treats a complete, valid +E.164 number as complete (gates save on composeE164's incomplete-input fallback)", () => {
    // Confirmed directly against the installed libphonenumber-js@^1.13.8's
    // isValidPhoneNumber before asserting, same as this file's other tests:
    //   isValidPhoneNumber("+971501234567") -> true  (full valid AE number)
    //   isValidPhoneNumber("+971")          -> false (dial code only)
    //   isValidPhoneNumber("")              -> false (empty)
    //   isValidPhoneNumber("+9715")         -> false (too short)
    expect(isCompletePhoneNumber("+971501234567")).toBe(true);
    expect(isCompletePhoneNumber("+971")).toBe(false);
    expect(isCompletePhoneNumber("")).toBe(false);
    expect(isCompletePhoneNumber("+9715")).toBe(false);
  });

  it("splits an E.164 value back into country + national number", () => {
    expect(splitE164("+971501234567")).toEqual({
      country: "AE",
      national: "501234567",
    });
    expect(splitE164("")).toBeNull();
  });

  describe("nextPickerState", () => {
    it("adopts the parsed parts of a complete number", () => {
      expect(nextPickerState("+971501234567")).toEqual({
        country: "AE",
        national: "501234567",
      });
    });

    it("resets to the default country and an empty number when cleared", () => {
      // The form switching from "edit" to "add", or resetting on open.
      expect(nextPickerState("")).toEqual({
        country: DEFAULT_COUNTRY,
        national: "",
      });
    });

    it("leaves the picker alone for a non-empty value it cannot parse", () => {
      // The case that keeps the control usable while typing. PhoneInput
      // round-trips its own edits through the parent, so it is handed
      // these intermediate values constantly; adopting a reset here would
      // clear the country the user just chose, mid-number.
      expect(nextPickerState("+9")).toBeNull();
      expect(nextPickerState("+971")).toBeNull();
      expect(nextPickerState("nonsense")).toBeNull();
    });

    it("distinguishes 'leave alone' from 'reset' — null is not an empty reset", () => {
      // Guards the shape itself: collapsing the two into one return value
      // is exactly the regression this function exists to prevent.
      expect(nextPickerState("+971")).not.toEqual({
        country: DEFAULT_COUNTRY,
        national: "",
      });
    });
  });

  it("live-formats an AE number as the user types it (AsYouType), inserting spaces", () => {
    // libphonenumber-js's AsYouType only recognizes the domestic trunk-0
    // form as it's typed, so "0501234567" (not "501234567") is the input
    // that actually exercises its progressive space-insertion — confirmed
    // against the installed libphonenumber-js@^1.13.8 AsYouType directly.
    expect(formatAsYouType("AE", "0501234567")).toBe("050 123 4567");
  });
});

// ============================================================
// Digits-only stored values (the format 1808 of this account's 1811
// contacts actually hold).
//
// `contacts.phone` is NOT stored as `+E.164`. The storage contract is
// digits-only — `normalizePhone` strips every non-digit, and WhatsApp's
// webhook hands over a bare `wa_id` like "971547800001". Only a handful
// of hand-typed rows ever carried a `+`.
//
// `formatPhoneDisplay` has always coped with that by parsing
// `+${digits}`, which is why a contact's phone renders correctly in
// every read-only view. `splitE164` did not, so seeding the EDIT form
// from a stored value returned null, `nextPickerState` said "leave the
// picker alone", and the number box rendered empty next to a red
// "Enter a valid phone number for the selected country" — on virtually
// every contact in the account.
// ============================================================

describe("digits-only stored values", () => {
  it("splits a stored digits-only number the same as its +E.164 form", () => {
    expect(splitE164("971547800001")).toEqual({
      country: "AE",
      national: "547800001",
    });
    expect(splitE164("971547800001")).toEqual(splitE164("+971547800001"));
  });

  it("seeds the picker from a stored digits-only number", () => {
    // The actual reported bug: the edit form rendered an empty number.
    expect(nextPickerState("971547800001")).toEqual({
      country: "AE",
      national: "547800001",
    });
  });

  it("accepts a stored digits-only number as complete", () => {
    // Without this, the inline error shows and `saveDetails` refuses to
    // save a contact whose phone the user never touched.
    expect(isCompletePhoneNumber("971547800001")).toBe(true);
  });

  it("handles a 00-prefixed international form", () => {
    // `formatPhoneDisplay` already strips a leading "00"; the picker
    // must agree with it rather than treat the value as unparseable.
    expect(splitE164("0044 7400 123456")).toEqual(splitE164("+447400123456"));
  });

  it("still leaves the picker alone for genuinely unparseable input", () => {
    // The mid-typing guarantee must survive the coercion — these must
    // NOT suddenly become parseable just because a "+" gets prepended.
    expect(nextPickerState("+9")).toBeNull();
    expect(nextPickerState("+971")).toBeNull();
    expect(nextPickerState("971")).toBeNull();
    expect(nextPickerState("nonsense")).toBeNull();
    expect(isCompletePhoneNumber("971")).toBe(false);
  });

  it("does not invent a country for a bare national number", () => {
    // "547800001" has no country code. Coercing it to "+547800001"
    // must not resolve to some unrelated country.
    expect(splitE164("547800001")).toBeNull();
  });
});
