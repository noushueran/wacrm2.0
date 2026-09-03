"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Share, X } from "lucide-react";
import { isIOS, isStandalone } from "@/lib/push/platform";
import {
  DISMISSED_AT_KEY,
  LEGACY_DISMISS_KEY,
  VISITS_KEY,
  parseDismissedAt,
  parseVisits,
  shouldOfferInstall,
} from "@/lib/pwa/install-offer";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// A dismissible install card. Chromium fires `beforeinstallprompt` (we
// capture it and show a button); iOS gets manual Add-to-Home-Screen help.
export function InstallPrompt() {
  const t = useTranslations("Pwa");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOS, setShowIOS] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (isStandalone()) return; // already installed

    // Count this visit, then decide. `shouldOfferInstall` holds the rules
    // (and their tests): not before the visitor has used the product a
    // few times, and not while a dismissal is still in date.
    let visits = 0;
    let dismissedAt: number | null = null;
    try {
      visits = parseVisits(localStorage.getItem(VISITS_KEY)) + 1;
      localStorage.setItem(VISITS_KEY, String(visits));
      dismissedAt = parseDismissedAt(
        localStorage.getItem(DISMISSED_AT_KEY),
        localStorage.getItem(LEGACY_DISMISS_KEY),
      );
    } catch {
      // Private mode: no counter, so never nag. Failing closed here is
      // right — an install card is an offer, not a feature.
      return;
    }
    if (
      !shouldOfferInstall({
        installed: false,
        visits,
        dismissedAt,
        now: Date.now(),
      })
    ) {
      return;
    }
    // STAYS AN EFFECT. Every input to this decision is browser-only —
    // `isStandalone()` reads matchMedia, the guard above reads
    // localStorage, and the branch below reads navigator. None exist
    // while the component renders on the server, and reading them during
    // render on the client would make the render impure and produce
    // markup that disagrees with the server's.
    //
    // Hence the state starts at `dismissed: true`: the card renders as
    // nothing until an effect has been able to look at the browser, which
    // is the standard shape for client-only UI and cannot be expressed as
    // a render-time derivation or a lazy `useState` initialiser (that
    // runs during render too).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time mount check of browser-only APIs (matchMedia/localStorage/navigator), which cannot be read during render
    setDismissed(false);

    if (isIOS(navigator.userAgent, navigator.maxTouchPoints)) {
      setShowIOS(true);
      return;
    }
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const close = () => {
    setDismissed(true);
    try {
      // A timestamp, not a boolean: this dismissal expires. The legacy
      // permanent flag is cleared so it cannot outlive the new rule.
      localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
      localStorage.removeItem(LEGACY_DISMISS_KEY);
    } catch {}
  };

  if (dismissed || (!deferred && !showIOS)) return null;

  return (
    <div className="fixed inset-x-3 bottom-20 z-50 mx-auto max-w-sm rounded-xl border border-border bg-card p-4 shadow-lg lg:bottom-6 lg:left-auto lg:right-6">
      <button
        type="button"
        onClick={close}
        aria-label={t("dismiss")}
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
      <p className="text-sm font-semibold text-foreground">
        {showIOS ? t("iosInstallTitle") : t("installTitle")}
      </p>
      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        {showIOS && <Share className="h-3.5 w-3.5 shrink-0" />}
        {showIOS ? t("iosInstallBody") : t("installBody")}
      </p>
      {deferred && (
        <button
          type="button"
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
            close();
          }}
          className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
        >
          {t("installButton")}
        </button>
      )}
    </div>
  );
}
