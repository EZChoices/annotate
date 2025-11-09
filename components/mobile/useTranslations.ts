"use client";

import { useMemo } from "react";
import { useLocale } from "./LocaleProvider";
import {
  mobileMessages,
  type MobileMessageKey,
} from "../../lib/mobile/messages";

export function useTranslations() {
  const { locale } = useLocale();
  return useMemo(() => {
    const dict = mobileMessages[locale] ?? mobileMessages.en;
    return (
      key: MobileMessageKey,
      vars?: Record<string, string | number>
    ) => {
      const template = dict[key] ?? mobileMessages.en[key] ?? key;
      if (!vars) return template;
      return Object.entries(vars).reduce(
        (acc, [placeholder, value]) =>
          acc.replace(new RegExp(`{${placeholder}}`, "g"), String(value)),
        template
      );
    };
  }, [locale]);
}
