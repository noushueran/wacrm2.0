import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

// Password provider ONLY for Phase 0 — no email verification or password
// reset flows, since no transactional-email service is configured yet.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
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
