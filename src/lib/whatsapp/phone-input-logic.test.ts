import { describe, expect, it } from "vitest";
import {
  DEFAULT_COUNTRY,
  composeE164,
  isValidNationalNumber,
  listCountryOptions,
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

  it("splits an E.164 value back into country + national number", () => {
    expect(splitE164("+971501234567")).toEqual({
      country: "AE",
      national: "501234567",
    });
    expect(splitE164("")).toBeNull();
  });
});
