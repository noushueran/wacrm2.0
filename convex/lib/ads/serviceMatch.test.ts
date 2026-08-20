import { describe, expect, test } from "vitest";
import { matchService, type ServiceCandidate } from "./serviceMatch";

const SERVICES: ServiceCandidate[] = [
  {
    key: "uae-visa",
    name: "UAE Visa",
    aliases: ["uae visit visa", "dubai visa", "tourist visa"],
    status: "active",
  },
  {
    key: "flight-booking",
    name: "Flight Booking",
    aliases: ["air ticket", "flight ticket"],
    status: "active",
  },
  {
    key: "umrah",
    name: "Umrah Package",
    aliases: ["umrah"],
    status: "paused",
  },
];

describe("matchService", () => {
  test("matches the service name in the headline", () => {
    const res = matchService({ headline: "Apply for your UAE Visa today" }, SERVICES);
    expect(res).toEqual({
      status: "matched",
      serviceKey: "uae-visa",
      serviceName: "UAE Visa",
      matchedOn: "headline",
    });
  });

  test("matches an alias", () => {
    const res = matchService({ headline: "Fast Dubai visa processing" }, SERVICES);
    expect(res.status).toBe("matched");
    expect(res).toMatchObject({ serviceKey: "uae-visa" });
  });

  test("ignores case, punctuation and diacritics", () => {
    const res = matchService({ headline: "U.A.E.  VÍSA — apply now!" }, SERVICES);
    expect(res).toMatchObject({ status: "matched", serviceKey: "uae-visa" });
  });

  test("matches a URL slug", () => {
    const res = matchService(
      { sourceUrl: "https://amaniworld.com/uae-visit-visa?utm_source=fb" },
      SERVICES,
    );
    expect(res).toMatchObject({
      status: "matched",
      serviceKey: "uae-visa",
      matchedOn: "sourceUrl",
    });
  });

  test("ad name outranks a conflicting body match", () => {
    const res = matchService(
      { adName: "UAE Visa - Retarget", body: "We also do air ticket bookings" },
      SERVICES,
    );
    expect(res).toMatchObject({
      status: "matched",
      serviceKey: "uae-visa",
      matchedOn: "adName",
    });
  });

  test("two distinct services at the deciding level is ambiguous", () => {
    const res = matchService(
      { headline: "Dubai visa and flight ticket combo" },
      SERVICES,
    );
    expect(res).toEqual({ status: "ambiguous" });
  });

  test("several terms of the same service is a hit, not ambiguity", () => {
    const res = matchService(
      { headline: "UAE Visa — the easiest tourist visa" },
      SERVICES,
    );
    expect(res).toMatchObject({ status: "matched", serviceKey: "uae-visa" });
  });

  test("no service term anywhere returns none", () => {
    const res = matchService({ headline: "Talk to our team" }, SERVICES);
    expect(res).toEqual({ status: "none" });
  });

  test("terms match on word boundaries, not inside longer words", () => {
    const res = matchService({ headline: "Revisage skincare" }, [
      { key: "visa", name: "Visa", aliases: [], status: "active" },
    ]);
    expect(res).toEqual({ status: "none" });
  });

  test("paused services are never candidates", () => {
    const res = matchService({ headline: "Umrah package deals" }, SERVICES);
    expect(res).toEqual({ status: "none" });
  });

  test("blank and whitespace-only aliases are ignored", () => {
    const res = matchService({ headline: "anything at all" }, [
      { key: "x", name: "  ", aliases: ["", "   "], status: "active" },
    ]);
    expect(res).toEqual({ status: "none" });
  });

  test("customerText is only consulted when supplied", () => {
    const without = matchService({ headline: "Talk to us" }, SERVICES);
    expect(without).toEqual({ status: "none" });

    const withText = matchService(
      { headline: "Talk to us", customerText: "I need a dubai visa" },
      SERVICES,
    );
    expect(withText).toMatchObject({
      status: "matched",
      serviceKey: "uae-visa",
      matchedOn: "customerText",
    });
  });

  test("an empty catalogue returns none", () => {
    expect(matchService({ headline: "UAE Visa" }, [])).toEqual({ status: "none" });
  });
});
