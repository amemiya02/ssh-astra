import type { TFunction } from "i18next";
import type { HostImportSource, ImportReport } from "@/lib/ipc/hosts";

export function importReportSummary(t: TFunction, report: ImportReport, source: HostImportSource["kind"]): string {
  const { imported, skipped, issues } = report;
  if (!imported.length && !skipped.length && !issues.length) return t(`hosts.import.${source}.nothing`);
  return t("hosts.import.summary", {
    imported: imported.length,
    skipped: skipped.length,
    failed: issues.filter((issue) => issue.dropped).length,
  });
}
