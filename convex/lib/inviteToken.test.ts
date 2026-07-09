import { expect, test } from "vitest";
import { generateInviteToken, hashInviteToken } from "./inviteToken";

test("generateInviteToken returns a 43-character base64url token (32 raw bytes)", async () => {
  const { token } = await generateInviteToken();
  expect(token).toHaveLength(43);
  // base64url alphabet: A-Z a-z 0-9 - _ (no +, /, or =)
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("generateInviteToken returns a 64-char hex hash matching SHA-256 of the token", async () => {
  const { token, tokenHash } = await generateInviteToken();
  expect(tokenHash).toHaveLength(64);
  expect(tokenHash).toMatch(/^[0-9a-f]+$/);
  expect(tokenHash).toBe(await hashInviteToken(token));
});

test("generateInviteToken produces different tokens (and hashes) each call", async () => {
  const first = await generateInviteToken();
  const second = await generateInviteToken();
  expect(first.token).not.toBe(second.token);
  expect(first.tokenHash).not.toBe(second.tokenHash);
});

test("hashInviteToken is deterministic for the same input", async () => {
  expect(await hashInviteToken("hello")).toBe(await hashInviteToken("hello"));
});

test("hashInviteToken differs for different inputs", async () => {
  expect(await hashInviteToken("a")).not.toBe(await hashInviteToken("b"));
});

test("hashInviteToken matches Node's SHA-256 implementation on a known fixture", async () => {
  // Known fixture — `sha256("invite-token-abc")` hex digest, copied
  // verbatim from `src/lib/auth/invitations.test.ts`'s own fixture test
  // for the Node-side (`node:crypto`) implementation. Both sides must
  // produce byte-identical digests for the same input — a route
  // handler on either side of the Next.js/Convex boundary hashes the
  // same plaintext token and has to land on the same `tokenHash` to
  // find the same `accountInvitations` row. If this assertion ever
  // flips, one of the two implementations changed and every stored
  // `tokenHash` is suddenly orphaned.
  expect(await hashInviteToken("invite-token-abc")).toBe(
    "51481b404112f61a4e1171ff116d52068c429737863181bef089df7cb607352f",
  );
});
