"use client";

import { useLocale } from "./LocaleProvider";
import { useTranslations } from "./useTranslations";
import { mobileMessages } from "../../lib/mobile/messages";

export function LocaleToggle() {
  const { locale, setLocale } = useLocale();
  const t = useTranslations();
  return (
    <div className="flex items-center justify-end gap-2 text-xs text-slate-500">
      <label htmlFor="locale-select" className="font-medium">
        {t("language")}
      </label>
      <select
        id="locale-select"
        className="rounded border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
        value={locale}
        onChange={(event) =>
          setLocale(event.target.value === "ar" ? "ar" : "en")
        }
      >
        <option value="en">{mobileMessages.en.english}</option>
        <option value="ar">{mobileMessages.ar.arabic}</option>
      </select>
    </div>
  );
}
