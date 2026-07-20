import { describe, it, expect } from "vitest";
import type { Doc } from "../../_generated/dataModel";
import { mapFieldsToContact } from "./contactFields";

type Field = Parameters<typeof mapFieldsToContact>[0][number];

function field(over: Partial<Field> = {}): Field {
  return { key: "destination", value: "Dubai", confidence: "high", ...over };
}

function contact(over: Partial<Doc<"contacts">> = {}): Doc<"contacts"> {
  return {
    _id: "c1" as Doc<"contacts">["_id"],
    _creationTime: 1_700_000_000_000,
    accountId: "a1" as Doc<"contacts">["accountId"],
    phone: "+971500000001",
    phoneNormalized: "971500000001",
    ...over,
  } satisfies Doc<"contacts">;
}

describe("mapFieldsToContact", () => {
  it("maps known keys onto their columns", () => {
    expect(
      mapFieldsToContact(
        [
          field({ key: "destination", value: "Dubai" }),
          field({ key: "travel_dates", value: "mid December" }),
          field({ key: "travelers", value: "2 adults" }),
          field({ key: "budget", value: "AED 3000 pp" }),
          field({ key: "nationality", value: "Indian" }),
          field({ key: "email", value: "a@x.co" }),
        ],
        contact(),
      ),
    ).toEqual({
      preferredDestination: "Dubai",
      travelDates: "mid December",
      travelers: "2 adults",
      budget: "AED 3000 pp",
      nationality: "Indian",
      email: "a@x.co",
    });
  });

  it("normalises punctuation and case in the key", () => {
    expect(mapFieldsToContact([field({ key: "Travel-Dates", value: "June" })], contact()))
      .toEqual({ travelDates: "June" });
  });

  it("falls back to the label when the key is unrecognised", () => {
    expect(
      mapFieldsToContact(
        [field({ key: "q1", label: "Budget per person", value: "AED 2500" })],
        contact(),
      ),
    ).toEqual({ budget: "AED 2500" });
  });

  it("prefers the key over the label when both match different columns", () => {
    expect(
      mapFieldsToContact(
        [field({ key: "budget", label: "Travel dates", value: "AED 2500" })],
        contact(),
      ),
    ).toEqual({ budget: "AED 2500" });
  });

  it("never overwrites a column the contact already has", () => {
    expect(
      mapFieldsToContact(
        [field({ key: "destination", value: "Dubai" })],
        contact({ preferredDestination: "Georgia" }),
      ),
    ).toEqual({});
  });

  it("keeps the FIRST field when two keys map to the same column", () => {
    expect(
      mapFieldsToContact(
        [
          field({ key: "destination", value: "Dubai" }),
          field({ key: "destination_country", value: "UAE" }),
        ],
        contact(),
      ),
    ).toEqual({ preferredDestination: "Dubai" });
  });

  it("skips low confidence, blank values, and unknown keys", () => {
    expect(
      mapFieldsToContact(
        [
          field({ key: "destination", value: "Dubai", confidence: "low" }),
          field({ key: "budget", value: "   " }),
          field({ key: "visa_type", value: "tourist" }),
          field({ key: "looking_for", value: "holiday package" }),
          field({ key: "country", value: "UAE" }),
        ],
        contact(),
      ),
    ).toEqual({});
  });
});
