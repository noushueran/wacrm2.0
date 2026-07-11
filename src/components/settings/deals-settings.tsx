"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Coins, Loader2, Wallet } from "lucide-react";

import { api } from "../../../convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { CURRENCIES } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Deals settings — account-wide default currency + flat lead value.
 *
 * One currency per account (issue #218): the chosen code seeds new
 * deals and formats every aggregated total. Existing deals keep their
 * own saved currency. Writes go straight through
 * `api.accounts.setDefaultCurrency` — that mutation re-derives the
 * caller's own membership role server-side and throws `FORBIDDEN` below
 * admin+ (the Convex counterpart to the old `accounts_update` RLS
 * policy), so non-admins seeing a disabled, read-only control here is a
 * UX nicety, not the only enforcement.
 *
 * Lead value (Phase 2 of the lead-value-spend feature) is a second,
 * independent account-wide setting on the same panel: a flat charge
 * (in the currency above) applied to an agent each time a lead is
 * assigned to them. Writes go through `api.accounts.setLeadValue`,
 * which is admin+ only — stricter than `setDefaultCurrency`'s
 * supervisor+ — per the Phase 2 decision that only admins configure
 * money charged to agents. `canEditSettings` from `useAuth()` is
 * already aliased to admin+, so it's the correct client-side gate for
 * both controls despite the different server-side floors.
 */
export function DealsSettings() {
  const setDefaultCurrency = useMutation(api.accounts.setDefaultCurrency);
  const setLeadValue = useMutation(api.accounts.setLeadValue);
  const {
    accountId,
    defaultCurrency,
    leadValue,
    canEditSettings,
    profileLoading,
    refreshProfile,
  } = useAuth();

  const [selected, setSelected] = useState(defaultCurrency);
  const [saving, setSaving] = useState(false);
  const t = useTranslations("Settings.deals");

  // Keep the select in sync once the profile (and its account default)
  // resolves, and after a save round-trips through refreshProfile.
  useEffect(() => {
    setSelected(defaultCurrency);
  }, [defaultCurrency]);

  const dirty = selected !== defaultCurrency;

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    try {
      await setDefaultCurrency({ currency: selected });
      // `refreshProfile` is a documented no-op under Convex Auth —
      // `useAuth()`'s `defaultCurrency` is sourced from the reactive
      // `api.accounts.me` query, so the mutation's write already
      // propagates to the deal form and every total on its own. Kept so
      // this call site's "pull the new value back" intent stays
      // unchanged regardless.
      await refreshProfile();
      toast.success(t("saveSuccess"));
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  // Lead value is edited as free-form text (not a controlled number
  // state) so the field can be cleared or mid-edit (e.g. a trailing
  // decimal point) without fighting the input. It's parsed and
  // validated below; `setLeadValue` is only ever called with a
  // finite, non-negative number.
  const [leadValueInput, setLeadValueInput] = useState(String(leadValue));
  const [savingLeadValue, setSavingLeadValue] = useState(false);

  useEffect(() => {
    setLeadValueInput(String(leadValue));
  }, [leadValue]);

  const parsedLeadValue = Number(leadValueInput);
  const leadValueIsValid =
    leadValueInput.trim() !== "" &&
    Number.isFinite(parsedLeadValue) &&
    parsedLeadValue >= 0;
  const leadValueDirty = leadValueIsValid && parsedLeadValue !== leadValue;

  async function handleSaveLeadValue() {
    if (!accountId || !leadValueDirty) return;
    setSavingLeadValue(true);
    try {
      await setLeadValue({ value: parsedLeadValue });
      // Same documented no-op as `refreshProfile()` in `handleSave`
      // above — `leadValue` is sourced from the reactive
      // `api.accounts.me` query, so the mutation's write already
      // propagates on its own.
      await refreshProfile();
      toast.success(t("leadValueSaveSuccess"));
    } catch {
      toast.error(t("leadValueSaveFailed"));
    } finally {
      setSavingLeadValue(false);
    }
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Coins className="size-4 text-primary" />
            {t("defaultCurrency")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("defaultCurrencyDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">{t("currencyLabel")}</Label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={!canEditSettings || profileLoading}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.label}
                </option>
              ))}
            </select>
            {!canEditSettings && (
              <p className="text-xs text-muted-foreground">
                {t("adminOnlyHint")}
              </p>
            )}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Wallet className="size-4 text-primary" />
            {t("leadValueTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("leadValueDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">
              {t("leadValueLabel")}
            </Label>
            <input
              type="number"
              min={0}
              value={leadValueInput}
              onChange={(e) => setLeadValueInput(e.target.value)}
              disabled={!canEditSettings || profileLoading}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            />
            <p className="text-xs text-muted-foreground">
              {t("leadValueHint")}
            </p>
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSaveLeadValue}
              disabled={savingLeadValue || !leadValueDirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {savingLeadValue ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
