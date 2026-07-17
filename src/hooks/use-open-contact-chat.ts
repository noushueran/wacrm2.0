'use client';

import { useRouter } from 'next/navigation';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { convexErrorMessage } from '@/lib/convex/adapters';

/**
 * Returns a handler that opens (find-or-creates) the contact's WhatsApp
 * conversation and navigates to it in the inbox via the `?c=` deep-link
 * the inbox page already reads (`src/app/(dashboard)/inbox/page.tsx`).
 */
export function useOpenContactChat(): (contactId: string) => Promise<void> {
  const router = useRouter();
  const findOrCreate = useMutation(api.conversations.findOrCreateForContact);
  return async (contactId: string) => {
    try {
      const conversationId = await findOrCreate({
        contactId: contactId as Id<'contacts'>,
      });
      router.push(`/inbox?c=${conversationId}`);
    } catch (err) {
      toast.error(convexErrorMessage(err));
    }
  };
}
