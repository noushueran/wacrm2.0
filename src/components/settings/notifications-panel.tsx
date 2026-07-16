"use client";

import { useQuery, useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { Bell, BellOff } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useWebPush } from "@/hooks/use-web-push";
import { useAuth } from "@/hooks/use-auth";

export function NotificationsPanel() {
  const t = useTranslations("PushSettings");
  const { canManageMembers } = useAuth();
  const { supported, permission, isSubscribed, iosNeedsInstall, busy, enable, disable } = useWebPush();

  const prefs = useQuery(api.push.getPreferences);
  const setPrefs = useMutation(api.push.setPreferences);

  // Admin-only workspace policy — the query is skipped for non-admins
  // (mirrors `ai-knowledge.tsx`'s own `canEdit ? {} : "skip"` idiom), so
  // a non-admin never round-trips for a control they won't see anyway.
  const policy = useQuery(api.push.getAccountPushPolicy, canManageMembers ? {} : "skip");
  const setPolicy = useMutation(api.push.setAccountPushPolicy);

  return (
    <div className="max-w-xl">
      <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>

      <div className="mt-5 rounded-xl border border-border bg-card p-4">
        {iosNeedsInstall ? (
          <p className="text-sm text-muted-foreground">{t("iosInstall")}</p>
        ) : !supported ? (
          <p className="text-sm text-muted-foreground">{t("unsupported")}</p>
        ) : permission === "denied" ? (
          <p className="text-sm text-destructive">{t("blocked")}</p>
        ) : isSubscribed ? (
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm text-foreground">
              <Bell className="h-4 w-4 text-primary" /> {t("enabled")}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void disable()}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              <BellOff className="mr-1 inline h-4 w-4" /> {t("disable")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void enable()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Bell className="mr-1 inline h-4 w-4" /> {t("enable")}
          </button>
        )}
      </div>

      <label className="mt-4 flex items-start gap-3 rounded-xl border border-border bg-card p-4">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          // Inverted mapping: this checkbox reads as "pause", but the stored
          // preference is `pushEnabled` (on by default), so checked = !pushEnabled.
          checked={!(prefs?.pushEnabled ?? true)}
          onChange={(e) => void setPrefs({ pushEnabled: !e.target.checked })}
        />
        <span>
          <span className="block text-sm font-medium text-foreground">{t("muteLabel")}</span>
          <span className="block text-xs text-muted-foreground">{t("muteHint")}</span>
        </span>
      </label>

      <label className="mt-4 flex items-start gap-3 rounded-xl border border-border bg-card p-4">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={prefs?.hidePreview ?? false}
          onChange={(e) => void setPrefs({ hidePreview: e.target.checked })}
        />
        <span>
          <span className="block text-sm font-medium text-foreground">{t("hidePreviewLabel")}</span>
          <span className="block text-xs text-muted-foreground">{t("hidePreviewHint")}</span>
        </span>
      </label>

      {canManageMembers ? (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-foreground">{t("workspaceHeading")}</h3>

          <label className="mt-3 flex items-start gap-3 rounded-xl border border-border bg-card p-4">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={policy?.suppressBotHandled ?? false}
              onChange={(e) => void setPolicy({ suppressBotHandled: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium text-foreground">{t("botHandledLabel")}</span>
              <span className="block text-xs text-muted-foreground">{t("botHandledHint")}</span>
            </span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
