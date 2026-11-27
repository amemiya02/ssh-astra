import { useTranslation } from "react-i18next";
import type { InterruptionCounts } from "./interruption-counts";

export function InterruptionList({ connections, transfers, forwards }: InterruptionCounts) {
  const { t } = useTranslation();
  return (
    <ul className="mt-1 list-disc pl-4 tabular-nums">
      <li>{t("interruptions.connections", { count: connections })}</li>
      <li>{t("interruptions.transfers", { count: transfers })}</li>
      <li>{t("status.forwardsCount", { count: forwards })}</li>
    </ul>
  );
}
