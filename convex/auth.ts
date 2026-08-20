import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { passwordRejectionReason } from "./lib/password";
import {
  SESSION_INACTIVE_DURATION_MS,
  SESSION_TOTAL_DURATION_MS,
} from "./lib/sessionDuration";

// Password provider ONLY for Phase 0 — no email verification or password
// reset flows, since no transactional-email service is configured yet.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  // Two clocks, deliberately different — see
  // convex/lib/sessionDuration.ts for why they are defined together.
  //
  // `totalDurationMs` is written into the session row at creation and
  // never revisited, so this governs only sessions created AFTER this
  // is deployed. Existing sessions keep their 30-day expiry and roll
  // over on their own — no migration needed.
  //
  // Keep this key. It was dropped once by a rewrite of this object that
  // was only adding `signIn` below, which left the constants as dead
  // code, silently handed session lifetime back to the library default,
  // and put the session out of step with the cookie `src/middleware.ts`
  // sizes from these same values. `auth.test.ts` now asserts the object
  // this call actually receives, because the constants' own test cannot
  // see whether anything reads them.
  session: {
    inactiveDurationMs: SESSION_INACTIVE_DURATION_MS,
    totalDurationMs: SESSION_TOTAL_DURATION_MS,
  },
  // Failed-sign-in budget, per account, refilling continuously and
  // reset on a success. Convex Auth applies this to the password path
  // itself (its `retrieveAccountWithCredentials` mutation), which is
  // the ONLY thing standing between a public sign-in form and offline-
  // speed password guessing: `signIn("password", ...)` goes from the
  // browser STRAIGHT to Convex, so `src/lib/rate-limit.ts` — which only
  // wraps Next.js `/api/*` route handlers — never sees these calls and
  // cannot be the control here.
  //
  // 10/hour is also the library's own default. Pinned explicitly anyway:
  // an undocumented upstream default is not something a security
  // property should rest on silently, and a dependency bump that
  // changed it would otherwise loosen this app with no diff to review.
  //
  // Known residual gap (NOT closed by this setting): the budget is keyed
  // by ACCOUNT, so it stops one account being pounded but does nothing
  // against credential stuffing that spreads one guess each across many
  // accounts. Closing that needs a per-IP control at the edge (the
  // reverse proxy / CDN in front of the Convex deployment), since the
  // sign-in call never transits this app's own server. Sign-UP is not
  // rate-limited by the library at all — see the audit notes.
  signIn: { maxFailedAttempsPerHour: 10 },
  providers: [
    Password({
      // Persist the sign-up form's full name onto the `users` document so
      // `accounts.bootstrapAccount` can snapshot it onto the membership and
      // `accounts.me` can surface it as `profile.full_name`. The default
      // Password `profile` captures only `email`; `name` is sent by the
      // sign-up flow (`flow: "signUp"`) and absent on sign-in, so it's
      // narrowed defensively.
      profile(params) {
        // Spread `name` in only when present — the profile return type is
        // a map of Convex `Value`s, which excludes `undefined`, so a bare
        // `name: undefined` on sign-in would fail to type-check.
        return {
          email: params.email as string,
          ...(typeof params.name === "string" ? { name: params.name } : {}),
        };
      },
      // Length floor PLUS a common/guessable-password screen — see
      // `./lib/password.ts` for why both, and why this deliberately
      // does not impose character-class rules. The screen is what makes
      // the 10-failures-per-hour budget above meaningful: that budget
      // only buys anything if the password survives the first ten
      // guesses, and `password123` does not.
      validatePasswordRequirements: (password: string) => {
        const reason = passwordRejectionReason(password);
        if (reason !== null) {
          // A plain `Error` here gets sanitized to an opaque "Server
          // Error" once it crosses the client boundary — only
          // `ConvexError`'s `.data` survives intact, which is what lets
          // the sign-up form show this exact message (see
          // src/app/convex-demo/page.tsx).
          throw new ConvexError(reason);
        }
      },
    }),
  ],
});
