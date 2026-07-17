"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Share, X } from "lucide-react";
import { isIOS, isStandalone } from "@/lib/push/platform";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "wacrm:pwa:install-dismissed";

// A dismissible install card. Chromium fires `beforeinstallprompt` (we
// capture it and show a button); iOS gets manual Add-to-Home-Screen help.
export function InstallPrompt() {
  const t = useTranslations("Pwa");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOS, setShowIOS] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (isStandalone()) return; // already installed
    try {
      if (localStorage.getItem(DISMISS_KEY) === "true") return;
    } catch {}
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time mount check of localStorage/standalone-mode gating whether to show the card, not a render-driven cascade
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
      localStorage.setItem(DISMISS_KEY, "true");
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
