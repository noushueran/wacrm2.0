import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

// Password provider ONLY for Phase 0 — no email verification or password
// reset flows, since no transactional-email service is configured yet.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
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
      validatePasswordRequirements: (password: string) => {
        if (password.length < 8) {
          // A plain `Error` here gets sanitized to an opaque "Server
          // Error" once it crosses the client boundary — only
          // `ConvexError`'s `.data` survives intact, which is what lets
          // the sign-up form show this exact message (see
          // src/app/convex-demo/page.tsx).
          throw new ConvexError("Password must be at least 8 characters.");
        }
      },
    }),
  ],
});
