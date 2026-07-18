import { describe, expect, test } from "vitest";
import {
  AD_LANDING_PROMPT_CONTENT_MAX,
  extractLandingContent,
  isFetchableLandingUrl,
  landingUrlKey,
  LANDING_CONTENT_MAX,
  LANDING_TITLE_MAX,
} from "./adContext";
import { buildSystemPrompt } from "./defaults";

// Pure-helper suite for the ad-aware assistant context — no Convex, no
// network; the fetch/cache half lives in `convex/adLanding.test.ts`.

describe("isFetchableLandingUrl", () => {
  test("accepts ordinary http(s) landing URLs", () => {
    expect(isFetchableLandingUrl("https://holidayys.co/packages/georgia-summer")).toBe(true);
    expect(isFetchableLandingUrl("http://fb.me/2AbCdEfG")).toBe(true);
  });

  test("rejects non-http protocols and unparseable input", () => {
    expect(isFetchableLandingUrl("ftp://holidayys.co/x")).toBe(false);
    expect(isFetchableLandingUrl("javascript:alert(1)")).toBe(false);
    expect(isFetchableLandingUrl("not a url")).toBe(false);
    expect(isFetchableLandingUrl("")).toBe(false);
  });

  test("rejects loopback / intranet-looking hosts (VPS SSRF guard)", () => {
    expect(isFetchableLandingUrl("http://localhost/admin")).toBe(false);
    expect(isFetchableLandingUrl("http://foo.localhost/x")).toBe(false);
    expect(isFetchableLandingUrl("http://router.local/")).toBe(false);
    expect(isFetchableLandingUrl("http://vault.internal/secrets")).toBe(false);
    expect(isFetchableLandingUrl("http://192.168.1.1/")).toBe(false);
    expect(isFetchableLandingUrl("http://127.0.0.1:8080/")).toBe(false);
    expect(isFetchableLandingUrl("http://[::1]/")).toBe(false);
  });
});

describe("landingUrlKey", () => {
  test("strips fragments and click-tracking params, keeps real ones", () => {
    expect(
      landingUrlKey(
        "https://holidayys.co/packages/georgia?fbclid=AbC123&utm_source=fb&utm_campaign=summer&nights=5#gallery",
      ),
    ).toBe("https://holidayys.co/packages/georgia?nights=5");
  });

  test("every click on one ad maps to one cache key", () => {
    const a = landingUrlKey("https://Holidayys.co/packages/georgia?fbclid=click-1");
    const b = landingUrlKey("https://holidayys.co/packages/georgia?fbclid=click-2#x");
    expect(a).toBe(b);
    expect(a).toBe("https://holidayys.co/packages/georgia");
  });

  test("returns null for unparseable input", () => {
    expect(landingUrlKey("not a url")).toBeNull();
  });
});

describe("extractLandingContent", () => {
  const PAGE = `<!doctype html>
<html><head>
  <title>Holidayys &mdash; fallback title</title>
  <meta name="description" content="Fallback meta description">
  <meta property="og:title" content="Georgia Summer Package &amp; City Tour" />
  <meta content="5 nights Tbilisi &#43; Batumi from AED 1299" property="og:description"/>
  <style>.hero { color: red; }</style>
  <script>window.__NEXT_DATA__ = {"junk": true};</script>
</head>
<body>
  <!-- hero -->
  <h1>Georgia Summer Package</h1>
  <p>5 nights &amp; 6 days covering Tbilisi, Gudauri &nbsp;and Batumi.</p>
  <ul><li>Visa assistance</li><li>Daily breakfast</li></ul>
  <script>trackPageview()</script>
</body></html>`;

  test("prefers og: metadata (either attribute order) and decodes entities", () => {
    const { title, description } = extractLandingContent(PAGE);
    expect(title).toBe("Georgia Summer Package & City Tour");
    expect(description).toBe("5 nights Tbilisi + Batumi from AED 1299");
  });

  test("body text drops scripts/styles/comments/head and keeps line structure", () => {
    const { content } = extractLandingContent(PAGE);
    expect(content).toContain("Georgia Summer Package");
    expect(content).toContain("5 nights & 6 days covering Tbilisi, Gudauri and Batumi.");
    expect(content).toContain("Visa assistance");
    expect(content).not.toContain("NEXT_DATA");
    expect(content).not.toContain("color: red");
    expect(content).not.toContain("fallback title"); // <head> never leaks into content
    expect(content).not.toContain("<");
  });

  test("falls back to <title> and meta description when og: tags are absent", () => {
    const html =
      "<html><head><title>Plain Page</title>" +
      '<meta name="description" content="Plain description"></head>' +
      `<body><p>${"Some readable body copy. ".repeat(10)}</p></body></html>`;
    const { title, description } = extractLandingContent(html);
    expect(title).toBe("Plain Page");
    expect(description).toBe("Plain description");
  });

  test("a near-empty shell yields no content (but keeps its title)", () => {
    const { title, description, content } = extractLandingContent(
      "<html><head><title>Log in</title></head><body><div id=root></div></body></html>",
    );
    expect(title).toBe("Log in");
    expect(description).toBeNull();
    expect(content).toBeNull();
  });

  test("caps every field", () => {
    const long = "x".repeat(LANDING_CONTENT_MAX * 2);
    const html = `<html><head><meta property="og:title" content="${"t".repeat(1000)}"></head><body><p>${long}</p></body></html>`;
    const { title, content } = extractLandingContent(html);
    expect(title!.length).toBe(LANDING_TITLE_MAX);
    expect(content!.length).toBe(LANDING_CONTENT_MAX);
  });

  test("empty input yields all nulls", () => {
    expect(extractLandingContent("")).toEqual({ title: null, description: null, content: null });
  });
});

describe("buildSystemPrompt adContext section", () => {
  const AD = {
    headline: "Georgia Summer Package",
    body: "5 nights from AED 1299 — visa included!",
    sourceUrl: "https://holidayys.co/packages/georgia-summer",
    landingTitle: "Georgia Summer Package | Holidayys",
    landingDescription: "Tbilisi, Gudauri and Batumi in one trip.",
    landingContent: "Day 1: arrival in Tbilisi…",
  };

  test("renders the lead-source section with ad + landing facts", () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: "auto_reply", adContext: AD });
    expect(prompt).toContain("Lead source");
    expect(prompt).toContain("Ad headline: Georgia Summer Package");
    expect(prompt).toContain("Ad text: 5 nights from AED 1299 — visa included!");
    expect(prompt).toContain("Ad link: https://holidayys.co/packages/georgia-summer");
    expect(prompt).toContain("Linked page title: Georgia Summer Package | Holidayys");
    expect(prompt).toContain("Linked page description: Tbilisi, Gudauri and Batumi in one trip.");
    expect(prompt).toContain("Day 1: arrival in Tbilisi…");
    expect(prompt).toContain("acknowledge the specific offer/destination");
  });

  test("injected landing content is capped below the stored cap", () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: "auto_reply",
      adContext: { ...AD, landingContent: "y".repeat(LANDING_CONTENT_MAX) },
    });
    expect(prompt).toContain("y".repeat(AD_LANDING_PROMPT_CONTENT_MAX));
    expect(prompt).not.toContain("y".repeat(AD_LANDING_PROMPT_CONTENT_MAX + 1));
  });

  test("renders in draft mode too, and only the fields that exist", () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: "draft",
      adContext: { headline: "Georgia Summer Package" },
    });
    expect(prompt).toContain("Ad headline: Georgia Summer Package");
    expect(prompt).not.toContain("Ad text:");
    expect(prompt).not.toContain("Linked page");
  });

  test("absent or empty adContext leaves the prompt untouched", () => {
    const base = buildSystemPrompt({ userPrompt: "Be warm.", mode: "auto_reply" });
    expect(buildSystemPrompt({ userPrompt: "Be warm.", mode: "auto_reply", adContext: {} })).toBe(
      base,
    );
    expect(base).not.toContain("Lead source");
  });
});
