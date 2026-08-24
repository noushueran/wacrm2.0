import { describe, expect, test } from "vitest";
import {
  AD_LANDING_PROMPT_CONTENT_MAX,
  extractLandingContent,
  isFetchableLandingUrl,
  isLoginWallLanding,
  isLoginWallUrl,
  landingUrlKey,
  LANDING_CONTENT_MAX,
  LANDING_HTML_MAX,
  LANDING_TITLE_MAX,
  looksLikeLoginWall,
  looksLikeSerializedJunk,
} from "./adContext";
import { buildSystemPrompt } from "./defaults";

// Pure-helper suite for the ad-aware assistant context — no Convex, no
// network; the fetch/cache half lives in `convex/adLanding.test.ts`.

describe("isFetchableLandingUrl", () => {
  test("accepts ordinary http(s) landing URLs", () => {
    expect(isFetchableLandingUrl("https://amaniworld.com/packages/georgia-summer")).toBe(true);
    expect(isFetchableLandingUrl("http://fb.me/2AbCdEfG")).toBe(true);
  });

  test("rejects non-http protocols and unparseable input", () => {
    expect(isFetchableLandingUrl("ftp://amaniworld.com/x")).toBe(false);
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
        "https://amaniworld.com/packages/georgia?fbclid=AbC123&utm_source=fb&utm_campaign=summer&nights=5#gallery",
      ),
    ).toBe("https://amaniworld.com/packages/georgia?nights=5");
  });

  test("every click on one ad maps to one cache key", () => {
    const a = landingUrlKey("https://amaniworld.com/packages/georgia?fbclid=click-1");
    const b = landingUrlKey("https://amaniworld.com/packages/georgia?fbclid=click-2#x");
    expect(a).toBe(b);
    expect(a).toBe("https://amaniworld.com/packages/georgia");
  });

  test("returns null for unparseable input", () => {
    expect(landingUrlKey("not a url")).toBeNull();
  });
});

describe("extractLandingContent", () => {
  const PAGE = `<!doctype html>
<html><head>
  <title>Amani &mdash; fallback title</title>
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

  // Meta's post pages are ~700KB, so the `LANDING_HTML_MAX` slice lands
  // in the middle of an inline `<script>` and leaves an opener with no
  // closer. Before this was handled, the tag-stripper turned the tail of
  // that JSON bundle into the stored "content" — every Instagram and
  // Facebook post row in production held 4000 chars of
  // `{"require":[["ScheduledServerJS"…` under "Linked page content".
  test("an unterminated <script> (a page bigger than the slice) never leaks as content", () => {
    const html =
      '<html><head><meta property="og:title" content="Amani on Instagram"></head><body>' +
      "<p>Visa Change by Bus for Indians for AED 799</p>" +
      "<p>Transportation, accommodation and border fees included in the package.</p>" +
      '<script type="application/json">{"require":[["ScheduledServerJS","handle",null,' +
      '[{"__bbox":{"define":[["cr:4474",["PolarisSearchBoxContainer.react"]'.repeat(200);
    const { title, content } = extractLandingContent(html);
    expect(title).toBe("Amani on Instagram");
    expect(content).toContain("AED 799");
    expect(content).not.toContain("ScheduledServerJS");
    expect(content).not.toContain("__bbox");
  });

  test("the truncation guard survives a real over-cap page", () => {
    // Same page, but bigger than the cap — the slice itself, rather than
    // malformed markup, is what orphans the opener.
    const html =
      "<html><body><p>Real landing copy about a Georgia package: five nights across " +
      "Tbilisi, Gudauri and Batumi, visa assistance included.</p>" +
      `<script>${"x".repeat(LANDING_HTML_MAX)}</script></body></html>`;
    const { content } = extractLandingContent(html);
    expect(content).toContain("Real landing copy about a Georgia package");
    expect(content).not.toContain("x".repeat(20));
  });

  test("caps every field", () => {
    const long = "x".repeat(LANDING_CONTENT_MAX * 2);
    const html = `<html><head><meta property="og:title" content="${"t".repeat(1000)}"></head><body><p>${long}</p></body></html>`;
    const { title, content } = extractLandingContent(html);
    expect(title!.length).toBe(LANDING_TITLE_MAX);
    expect(content!.length).toBe(LANDING_CONTENT_MAX);
  });

  test("empty input yields all nulls", () => {
    expect(extractLandingContent("")).toEqual({
      title: null,
      description: null,
      content: null,
      loginWall: false,
    });
  });
});

// ============================================================
// Login walls — the page Meta serves an unauthenticated fetcher instead
// of the post a Click-to-WhatsApp ad points at. Every fixture below is
// the shape production actually stored (2026-08-25: 230 of 434
// successful extractions were this wall).
// ============================================================

/** The exact body text 230 `adLandingPages` rows held, verbatim. */
const FB_WALL_BODY = `Explore the things you love .

Log into Facebook

Email or mobile number

Password

Log in

Forgot password?

Create new account

English (US)
Español
Sign Up
Log In
Messenger
Privacy Policy
Terms
Help

Meta © 2026`;

const FB_WALL_PAGE =
  '<html><head><title>Facebook</title>' +
  '<meta property="og:title" content="Facebook">' +
  '<meta property="og:description" content="Log into Facebook to start sharing and connecting with your friends, family and people you know.">' +
  "</head><body><form>" +
  `<div>${FB_WALL_BODY.replace(/\n\n/g, "</div><div>")}</div>` +
  '<input type="text" name="email"><input type="password" name="pass">' +
  "</form></body></html>";

/** The Instagram post behind the same class of ad — the case that must
 *  keep working. Its value is entirely in the og: metadata; the body is
 *  a JS shell (see the truncated-`<script>` tests above). */
const IG_POST_PAGE =
  "<html><head>" +
  '<meta property="og:title" content="Amani Travel &amp; Tourism on Instagram: &quot;UAE tourist visa expired?&quot;">' +
  '<meta property="og:description" content="0 likes, 0 comments - amani_tours on July 21, 2026: Visa Change by Bus for Indians for AED 799. Transportation, accommodation and border fees included.">' +
  "</head><body><main><article>" +
  "<p>Amani Travel offers Visa Change by Bus for Indians for AED 799, including transportation, accommodation, border fees and immediate return arrangements.</p>" +
  "</article></main></body></html>";

describe("login-wall detection", () => {
  test("a Facebook login wall is flagged, metadata and all", () => {
    const extract = extractLandingContent(FB_WALL_PAGE);
    expect(extract.loginWall).toBe(true);
    // Flagged on the text alone too — the read-side guard only ever has
    // the stored strings to work with.
    expect(looksLikeLoginWall(FB_WALL_BODY)).toBe(true);
    expect(looksLikeLoginWall("Log into Facebook to start sharing and connecting.")).toBe(true);
  });

  test("a real Instagram post page is accepted, offer copy intact", () => {
    const { loginWall, title, description, content } = extractLandingContent(IG_POST_PAGE);
    expect(loginWall).toBe(false);
    expect(title).toContain("Amani Travel & Tourism on Instagram");
    expect(description).toContain("AED 799");
    expect(content).toContain("AED 799");
  });

  // The 109 production rows that DID reach the post: Facebook prefixes
  // the page with its own "Log In" button. That is not a wall, and
  // treating it as one would throw away the best ad grounding there is.
  test("a post page behind a 'Log In' button is not a wall", () => {
    const html =
      "<html><head>" +
      '<meta property="og:title" content="Amani Travel &amp; Tourism UAE">' +
      '<meta property="og:description" content="Planning your next career move in the UAE? Two visa-assistance options for Indian nationals, from AED 5,980.">' +
      "</head><body><div>Log In</div><div>Amani Travel &amp; Tourism UAE&#39;s Post</div>" +
      "<p>2-Year Freelance Visa Service starts from AED 5,980, and a 120-Day Job Seeker Visa is also available.</p>" +
      "</body></html>";
    const { loginWall, description, content } = extractLandingContent(html);
    expect(loginWall).toBe(false);
    expect(description).toContain("AED 5,980");
    expect(content).toContain("AED 5,980");
  });

  // Meta localizes the wall to the fetcher's region — the same URL that
  // returns "Log into Facebook" from one host returns Arabic from
  // another (observed 2026-08-25). English phrase-matching alone would
  // have let that one straight through.
  test("a localized wall with no English still trips the structural signal", () => {
    const html =
      "<html><head><title>Facebook</title></head><body><form>" +
      "<div>تسجيل الدخول إلى فيسبوك</div><div>البريد الإلكتروني أو رقم الهاتف المحمول</div>" +
      "<div>كلمة السر</div><div>هل نسيت كلمة السر؟</div><div>إنشاء حساب جديد</div>" +
      '<input type="text"><input type="password">' +
      "</form></body></html>";
    expect(extractLandingContent(html).loginWall).toBe(true);
  });

  // Precision guard: one piece of login furniture on a page full of real
  // copy is a members' area, not a wall. A false positive here silently
  // un-grounds a reply that had genuine context.
  test("a real landing page with a login link is not a wall", () => {
    const html =
      "<html><head><title>Georgia Summer Package | Amani</title></head><body>" +
      "<header><a>Agent portal</a><a>Forgot password?</a></header>" +
      `<p>${"5 nights across Tbilisi, Gudauri and Batumi, with visa assistance and daily breakfast. ".repeat(30)}</p>` +
      '<form><input type="password" name="portal"></form>' +
      "</body></html>";
    const { loginWall, content } = extractLandingContent(html);
    expect(loginWall).toBe(false);
    expect(content).toContain("Tbilisi");
  });

  test("isLoginWallUrl reads the URL a redirect actually landed on", () => {
    // What all 339 production `fb.me` rows resolved to, walled or not.
    expect(
      isLoginWallUrl(
        "https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fstory.php%3Fstory_fbid%3D1367639918798838",
      ),
    ).toBe(true);
    expect(isLoginWallUrl("https://www.instagram.com/accounts/login/?next=/p/DbEKZNHsJne/")).toBe(
      true,
    );
    expect(isLoginWallUrl("https://www.facebook.com/100066585289452/posts/pfbid02qJw/")).toBe(
      false,
    );
    expect(isLoginWallUrl("https://www.instagram.com/p/DbEKZNHsJne/")).toBe(false);
    // A path that merely CONTAINS the word is not the wall.
    expect(isLoginWallUrl("https://amaniworld.com/blog/login-to-your-visa-portal")).toBe(false);
    expect(isLoginWallUrl("not a url")).toBe(false);
  });

  test("isLoginWallLanding recognizes rows written before the fetcher rejected walls", () => {
    // Verbatim production row (fb.me → the wall).
    expect(
      isLoginWallLanding({
        title: "Facebook",
        description: undefined,
        content: FB_WALL_BODY,
        finalUrl:
          "https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fstory.php%3Fstory_fbid%3D1367639918798838",
      }),
    ).toBe(true);
    // …and one whose finalUrl alone gives it away, content long since
    // replaced by a later good fetch's leftovers.
    expect(isLoginWallLanding({ finalUrl: "https://www.facebook.com/login/" })).toBe(true);
    // The good rows stay good.
    expect(
      isLoginWallLanding({
        title: 'Amani Travel & Tourism on Instagram: "UAE tourist visa expired?"',
        description: "Visa Change by Bus for Indians for AED 799.",
        content: null,
        finalUrl: "https://www.instagram.com/p/DbEKZNHsJne/",
      }),
    ).toBe(false);
    expect(isLoginWallLanding({})).toBe(false);
  });
});

describe("looksLikeSerializedJunk", () => {
  test("flags the truncated-<script> residue 179 production rows held", () => {
    expect(
      looksLikeSerializedJunk(
        '{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"define":' +
          '[["cr:4474",["PolarisSearchBoxContainer.react"],{"__rc":["Polaris",null]},-1]'.repeat(10),
      ),
    ).toBe(true);
    // An array-rooted bundle is the same defect.
    expect(looksLikeSerializedJunk('[["cr:244",["CometEmoji.react"],{"__rc":[null,null]},-1],'.repeat(5))).toBe(
      true,
    );
    // 78 production rows look like THIS — Facebook prefixes the blob with
    // its own chrome, so the bundle does not start at character zero.
    expect(
      looksLikeSerializedJunk(
        "Log In\n\nAmani Travel & Tourism UAE's Post\n\n" +
          '{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"define":' +
          '[["cr:244",["CometEmoji.react"],{"__rc":[null,null]},-1]'.repeat(10),
      ),
    ).toBe(true);
  });

  test("leaves real landing copy alone, including prose that mentions braces", () => {
    expect(
      looksLikeSerializedJunk(
        "Georgia Summer Package. 5 nights across Tbilisi, Gudauri and Batumi, " +
          "with visa assistance, daily breakfast and airport transfers included.",
      ),
    ).toBe(false);
    // Starts with a brace but is prose — the density test is what saves it.
    expect(
      looksLikeSerializedJunk(
        "{Special offer} Visa Change by Bus for Indians for AED 799, including " +
          "transportation, accommodation and border fees.",
      ),
    ).toBe(false);
    // A login wall is junk of the OTHER kind — this detector must not
    // claim it, or the cleanup would take the wrong branch.
    expect(looksLikeSerializedJunk(FB_WALL_BODY)).toBe(false);
    expect(looksLikeSerializedJunk(null)).toBe(false);
    expect(looksLikeSerializedJunk("")).toBe(false);
  });
});

describe("buildSystemPrompt adContext section", () => {
  const AD = {
    headline: "Georgia Summer Package",
    body: "5 nights from AED 1299 — visa included!",
    sourceUrl: "https://amaniworld.com/packages/georgia-summer",
    landingTitle: "Georgia Summer Package | Amani",
    landingDescription: "Tbilisi, Gudauri and Batumi in one trip.",
    landingContent: "Day 1: arrival in Tbilisi…",
  };

  test("renders the lead-source section with ad + landing facts", () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: "auto_reply", adContext: AD });
    expect(prompt).toContain("Lead source");
    expect(prompt).toContain("Ad headline: Georgia Summer Package");
    expect(prompt).toContain("Ad text: 5 nights from AED 1299 — visa included!");
    expect(prompt).toContain("Ad link: https://amaniworld.com/packages/georgia-summer");
    expect(prompt).toContain("Linked page title: Georgia Summer Package | Amani");
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
