'use client';

import { useState } from 'react';
import { useAction, useConvex, useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useAuth } from '@/hooks/use-auth';
import { convexErrorData, convexErrorMessage } from '@/lib/convex/adapters';
import { MessageTemplate } from '@/types';

import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact-custom-value keyed by the custom field's id stored in
 * `value`.
 *
 * This shape is passed through verbatim as `broadcasts.templateVariables`
 * (`v.any()`), but `convex/broadcasts.ts`'s `deliverOne` only ever reads
 * it back out when it happens to already be a plain `string[]` —
 * per-contact resolution of `field`/`custom_field` mappings (what this
 * type actually models) has no Convex-side consumer yet. Wiring that up
 * means touching `convex/broadcasts.ts`, which is out of scope for this
 * task (composer-only rewire) — see this task's report.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. The pre-Convex send
   * path forwarded this to every per-recipient API call;
   * `convex/metaSend.ts`'s `sendTemplate` action has no equivalent
   * parameter yet, so this currently has no server-side sink at all
   * (see this task's report). Kept on the payload so Step 3's UI keeps
   * working and the value isn't silently dropped from the type the
   * moment a Convex-side consumer is added.
   */
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Page size used when paginating through `contacts.list`/
 * `contacts.filterByTags` to resolve a full audience. Arbitrary, but
 * comfortably below Convex's per-query document-read ceiling.
 */
const RESOLVE_PAGE_SIZE = 500;

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const convex = useConvex();
  const createContact = useMutation(api.contacts.create);
  const createBroadcast = useMutation(api.broadcasts.create);
  const setBroadcastStatus = useMutation(api.broadcasts.setStatus);
  const sendBroadcast = useAction(api.broadcasts.send);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  /**
   * Every contact carrying any of `tagIds` (OR across tags), paginated
   * to completion via `contacts.filterByTags`'s `limit`/`offset`. Used
   * both for the `tags` audience type and for `excludeTagIds`
   * subtraction below.
   */
  async function resolveContactIdsByTags(
    tagIds: Id<'tags'>[],
  ): Promise<Set<Id<'contacts'>>> {
    const ids = new Set<Id<'contacts'>>();
    if (tagIds.length === 0) return ids;

    let offset = 0;
    for (;;) {
      const result = await convex.query(api.contacts.filterByTags, {
        tagIds,
        limit: RESOLVE_PAGE_SIZE,
        offset,
      });
      for (const item of result.items) ids.add(item._id);
      offset += RESOLVE_PAGE_SIZE;
      if (offset >= result.total) break;
    }
    return ids;
  }

  /** Every contact in the account, paginated to completion via `contacts.list`. */
  async function resolveAllContactIds(): Promise<Id<'contacts'>[]> {
    const ids: Id<'contacts'>[] = [];
    let cursor: string | null = null;
    for (;;) {
      // Explicit type annotation avoids TS7022: without it, `cursor`
      // being fed back from this same call's own `continueCursor` (via
      // the reassignment two lines down) makes `result`'s inferred type
      // self-referential across loop iterations.
      const result: FunctionReturnType<typeof api.contacts.list> =
        await convex.query(api.contacts.list, {
          paginationOpts: { numItems: RESOLVE_PAGE_SIZE, cursor },
        });
      for (const contact of result.page) ids.push(contact._id);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    return ids;
  }

  /**
   * CSV uploads arrive as raw phone/name pairs, not contact ids. Before
   * `broadcasts.create` (whose `contactIds` FK real `contacts` rows) can
   * take them, each phone must resolve to a real `Id<"contacts">`:
   * create one per row, and on a `DUPLICATE_PHONE` hit reuse the id the
   * mutation's own error already carries rather than issuing a second
   * lookup (mirrors `import-modal.tsx`'s `isConvexErrorCode` handling,
   * extended to also read the id out of the error's `.data` — a skip
   * count alone isn't enough here, since the broadcast still needs to
   * reach that existing contact).
   */
  async function upsertCsvContacts(
    csvRows: { phone: string; name?: string }[],
  ): Promise<Id<'contacts'>[]> {
    if (csvRows.length === 0) return [];

    // De-duplicate by phone within the CSV (users can paste duplicates).
    const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
    for (const row of csvRows) {
      if (row.phone) uniqueByPhone.set(row.phone, row);
    }

    const contactIds: Id<'contacts'>[] = [];
    for (const row of uniqueByPhone.values()) {
      try {
        const contactId = await createContact({
          phone: row.phone,
          name: row.name,
        });
        contactIds.push(contactId);
      } catch (err) {
        const data = convexErrorData(err);
        if (
          data?.code === 'DUPLICATE_PHONE' &&
          typeof data.contactId === 'string'
        ) {
          contactIds.push(data.contactId as Id<'contacts'>);
        } else {
          throw new Error(
            `Failed to create CSV contact "${row.phone}": ${convexErrorMessage(err)}`,
          );
        }
      }
    }
    return contactIds;
  }

  async function resolveAudience(
    audience: AudienceConfig,
  ): Promise<Id<'contacts'>[]> {
    let contactIds: Id<'contacts'>[] = [];

    if (audience.type === 'all') {
      contactIds = await resolveAllContactIds();
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      const ids = await resolveContactIdsByTags(
        audience.tagIds.map((id) => id as Id<'tags'>),
      );
      contactIds = [...ids];
    } else if (audience.type === 'custom_field' && audience.customField) {
      const { fieldId, operator, value } = audience.customField;
      const contacts = await convex.query(api.contacts.byCustomFieldValue, {
        customFieldId: fieldId as Id<'customFields'>,
        operator,
        value,
      });
      contactIds = contacts.map((c) => c._id);
    } else if (audience.type === 'csv' && audience.csvContacts) {
      contactIds = await upsertCsvContacts(audience.csvContacts);
    }

    // Apply exclude tags (works across all contact-derived audience
    // types). CSV contacts are synthetic so exclusion doesn't apply,
    // same as the pre-Convex implementation.
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const excluded = await resolveContactIdsByTags(
        audience.excludeTagIds.map((id) => id as Id<'tags'>),
      );
      contactIds = contactIds.filter((id) => !excluded.has(id));
    }

    return contactIds;
  }

  async function createAndSendBroadcast(
    payload: BroadcastPayload,
  ): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    try {
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(10);
      const contactIds = await resolveAudience(payload.audience);

      if (contactIds.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2: Persist the broadcast + its "pending" recipients ──
      // as a draft — `broadcasts.create` only ever writes rows, it
      // never sends anything itself (see that mutation's own header
      // comment).
      setProgress(50);
      const broadcastId = await createBroadcast({
        name: payload.name,
        templateName: payload.template.name,
        templateLanguage: payload.template.language ?? 'en_US',
        contactIds,
        templateVariables: payload.variables,
        audienceFilter: {
          type: payload.audience.type,
          tagIds: payload.audience.tagIds,
          customField: payload.audience.customField,
          excludeTagIds: payload.audience.excludeTagIds,
        },
        status: 'draft',
      });

      // ── Step 3: Fan out ───────────────────────────────────────────
      // `broadcasts.send` schedules one delivery per recipient and
      // returns as soon as scheduling is done — it does NOT wait for
      // every message to actually land, so this resolves well before
      // `sentCount`/`failedCount` reach their final values. The
      // broadcast detail page (already Convex-backed) reflects real
      // delivery progress reactively from there; this hook's own
      // `progress` below is only ever a coarse "submitting…" indicator
      // now, not a per-message delivery tracker like the old fetch loop.
      setProgress(80);
      try {
        await sendBroadcast({ broadcastId });
      } catch (err) {
        // `create` above already persisted the broadcast as "draft". If
        // the fan-out call itself throws before any recipient is even
        // scheduled (e.g. a permission error, or WhatsApp not configured
        // for this account), nothing else will ever move it out of
        // "draft" — best-effort flip it to "failed" so it doesn't linger
        // silently on the list/detail page. A secondary failure here is
        // swallowed; the original send error is what the caller needs
        // to see.
        await setBroadcastStatus({ broadcastId, status: 'failed' }).catch(
          () => {},
        );
        throw err;
      }

      setProgress(100);
      return broadcastId;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
