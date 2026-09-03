/**
 * Pure membership + diff logic for the Meta customer-list audience sync.
 *
 * Nothing here touches `ctx`, the database, the clock or the network, so
 * the whole decision table is unit-testable with object literals — same
 * split as `lib/leadQuality.ts` beside `leadQuality.ts`.
 */

import type { FunnelStageKey } from "./funnel";

/**
 * Stages that take a contact OUT of the retargeting pool.
 *
 * `purchased` only. `lost` is deliberately absent: a lost lead did not
 * buy, which is exactly who retargeting is for. `lost` is a terminal exit
 * in FUNNEL_STAGES, not a signal to stop advertising to someone.
 */
export const EXCLUDED_STAGES: readonly FunnelStageKey[] = ["purchased"] as const;

/** Minimum digits for a number that could carry a country code. Mirrors
 *  `normalizePhoneForMeta` in `convex/lib/metaHash.ts` — a shorter
 *  string hashes to a digest that matches nobody. */
export const MIN_PHONE_DIGITS = 7;

export type MemberCandidate<TId extends string = string> = {
  contactId: TId;
  /** Digits-only phone as stored on `contacts.phoneNormalized`. */
  phoneNormalized: string;
  doNotContact: boolean;
  /** Funnel stage of every conversation belonging to this contact. */
  stages: FunnelStageKey[];
};

/** Whether this contact belongs in the audience right now. */
export function shouldBeMember<TId extends string = string>(c: MemberCandidate<TId>): boolean {
  const digits = (c.phoneNormalized ?? "").replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS) return false;
  if (c.doNotContact) return false;
  if (c.stages.some((s) => EXCLUDED_STAGES.includes(s))) return false;
  return true;
}

/** One row of the local mirror — what we believe Meta currently holds. */
export type MirrorRow<TId extends string = string> = {
  contactId: TId;
  phoneHash: string;
  isMember: boolean;
};

/** One row of the desired state, computed fresh from the CRM. */
export type Desired<TId extends string = string> = {
  contactId: TId;
  phoneHash: string;
  wanted: boolean;
};

export type AudienceDiff<TId extends string = string> = {
  toAdd: Desired<TId>[];
  toRemove: MirrorRow<TId>[];
  /** Rows where belief already matched intent — no Graph call needed. */
  unchanged: number;
};

/**
 * The deltas needed to bring Meta from `mirror` to `desired`.
 *
 * A phone change is expressed as a REMOVE of the old digest plus an ADD of
 * the new one, because Meta indexes membership BY DIGEST — leaving the old
 * hash in place would strand an untargetable ghost in the audience that no
 * later pass could ever find again.
 *
 * A contact present in the mirror but absent from `desired` (deleted from
 * the CRM, or beyond the scan cap) is removed if we believe it is a member.
 *
 * Duplicate contactIds in `desired` are collapsed to the last occurrence
 * (last-write-wins), preventing the caller (which may fan out per conversation)
 * from silently stranding stale digests.
 */
export function diffMembership<TId extends string = string>(
  desired: Desired<TId>[],
  mirror: MirrorRow<TId>[],
): AudienceDiff<TId> {
  // Deduplicate desired by contactId, keeping the last occurrence.
  const deduped = new Map(desired.map((d) => [d.contactId, d]));

  const byId = new Map(mirror.map((m) => [m.contactId, m]));
  const toAdd: Desired<TId>[] = [];
  const toRemove: MirrorRow<TId>[] = [];
  let unchanged = 0;

  for (const d of deduped.values()) {
    const known = byId.get(d.contactId);
    byId.delete(d.contactId);

    if (known && known.phoneHash !== d.phoneHash) {
      // Phone changed. Retire the old digest first, then add the new one.
      if (known.isMember) toRemove.push(known);
      if (d.wanted) toAdd.push(d);
      continue;
    }

    const believedMember = known?.isMember ?? false;
    if (d.wanted && !believedMember) toAdd.push(d);
    else if (!d.wanted && believedMember) toRemove.push(known!);
    else unchanged++;
  }

  // Anything left in the mirror was not in the desired set at all.
  for (const orphan of byId.values()) {
    if (orphan.isMember) toRemove.push(orphan);
  }

  return { toAdd, toRemove, unchanged };
}
