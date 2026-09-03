"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search, Share2 } from "lucide-react";
import { usePaginatedQuery } from "@/lib/convex/cached";
import { api } from "../../../../convex/_generated/api";
import { toUiConversation } from "@/lib/convex/adapters";
import { conversationListArgs, inboxUrl } from "@/lib/inbox/view";
import { draftStorageKey } from "@/lib/inbox/outbox";
import { isEmptyShare, shareToDraft } from "@/lib/pwa/share";
import { ContactAvatar } from "@/components/inbox/contact-avatar";

/**
 * Web Share Target landing page: "share into the CRM".
 *
 * An agent who receives a phone number, a link or a note in another app
 * can push it straight into a customer's chat instead of copying it,
 * switching apps, finding the conversation and pasting.
 *
 * The shared content is handed off through the SAME per-conversation
 * draft the composer already restores (`draftStorageKey`, added with the
 * outbox) rather than through a query parameter. That is deliberate:
 * shared text can be a customer's phone number or passport detail, and a
 * URL parameter would put it in browser history and in any referrer.
 * localStorage keeps it on the device and in exactly the place the
 * composer already looks.
 *
 * Auth: listed in `src/middleware.ts`'s protected routes, so a signed-out
 * share is redirected to /login before this renders. KNOWN LIMITATION —
 * the shared content is lost in that redirect, because the login flow has
 * no return-to path; the agent shares again after signing in. Rare in
 * practice (an installed app holds a 30-day sliding session) and not
 * worth widening the auth flow for here.
 */
export default function SharePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations("Share");

  const payload = useMemo(
    () => ({
      title: searchParams.get("title"),
      text: searchParams.get("text"),
      url: searchParams.get("url"),
    }),
    [searchParams],
  );
  const draft = useMemo(() => shareToDraft(payload), [payload]);
  const empty = isEmptyShare(payload);

  const [query, setQuery] = useState("");

  // Reuses the inbox's own list query and arg builder rather than adding
  // a backend function — same rows, same role scoping, same cache key.
  const conv = usePaginatedQuery(
    api.conversations.list,
    conversationListArgs("active", "all"),
    { initialNumItems: 30 },
  );
  const conversations = useMemo(
    () => conv.results.map(toUiConversation),
    [conv.results],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => {
      const name = c.contact?.name?.toLowerCase() ?? "";
      const phone = c.contact?.phone ?? "";
      return name.includes(q) || phone.includes(q);
    });
  }, [conversations, query]);

  const handlePick = (conversationId: string) => {
    try {
      localStorage.setItem(draftStorageKey(conversationId), draft);
    } catch {
      // Private mode / quota: fall through and still open the chat, so
      // the agent can paste manually rather than hitting a dead end.
    }
    router.replace(inboxUrl(conversationId));
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <header className="flex items-start gap-3">
        <Share2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">
            {empty ? t("emptyBody") : t("body")}
          </p>
        </div>
      </header>

      {!empty && (
        <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
          {draft}
        </p>
      )}

      {!empty && (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground outline-none focus:border-primary"
            />
          </div>

          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
            {filtered.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => handlePick(c.id)}
                  className="flex min-h-12 w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
                >
                  <ContactAvatar
                    displayName={c.contact?.name || c.contact?.phone || t("unknown")}
                    seed={c.contact?.phone_normalized || c.contact?.phone || ""}
                    photoUrl={c.contact?.avatar_url}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {c.contact?.name || c.contact?.phone || t("unknown")}
                    </span>
                    {c.contact?.name && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {c.contact.phone}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                {conv.status === "LoadingFirstPage" ? t("loading") : t("noMatches")}
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
