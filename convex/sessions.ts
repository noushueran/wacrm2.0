import {
  getAuthSessionId,
  getAuthUserId,
  invalidateSessions,
} from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { action } from "./_generated/server";

/**
 * Signs the caller out of every device EXCEPT the one making the call.
 *
 * This is the recovery path for a lost or stolen phone: sign in on a
 * laptop, press the button, and the phone's session is dead while the
 * laptop keeps working. It is the only such path — Convex Auth does not
 * invalidate existing sessions on password change, so changing the
 * password does not evict a stolen device.
 *
 * Removing a member (`convex/members.ts`) is NOT this: that deletes the
 * membership and moves the user into their own solo account, ending
 * their access to team data while leaving their session intact.
 *
 * An `action`, not a `mutation`, because `invalidateSessions` dispatches
 * through `ctx.runMutation("auth:store", …)` and requires an action ctx.
 *
 * Deliberately not built on `accountMutation` (convex/lib/auth.ts): this
 * is scoped to the caller's own user, not to an account's data, and
 * `withAccount` needs a `ctx.db` that actions do not have. The
 * `getAuthUserId` check below is the equivalent guard.
 */
export const signOutOtherDevices = action({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const sessionId = await getAuthSessionId(ctx);
    if (userId === null || sessionId === null) {
      throw new ConvexError({ code: "UNAUTHENTICATED" });
    }

    await invalidateSessions(ctx, { userId, except: [sessionId] });
    return null;
  },
});
