import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { HostImportSource, ImportIssue, ImportReport } from "@/lib/ipc/hosts";
import { importReportSummary } from "./importReportSummary";

/** What an import did: counts, then the names in each outcome and why. */
export function ImportReportDialogContent({ report, source, onClose }: {
  report: ImportReport;
  source: HostImportSource["kind"];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const failed = report.issues.filter((i) => i.dropped);
  const partial = report.issues.filter((i) => !i.dropped);
  return (
    <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] p-5 sm:max-w-120">
      <DialogHeader>
        <DialogTitle>{t(`hosts.import.${source}.title`)}</DialogTitle>
        <DialogDescription>{importReportSummary(t, report, source)}</DialogDescription>
      </DialogHeader>
      <div className="grid max-h-80 gap-3 overflow-y-auto">
        <NameList heading={t("hosts.import.imported")} names={report.imported} />
        <NameList heading={t("hosts.import.skipped")} names={report.skipped} />
        {report.proxyCommands.length > 0 && (
          <section className="grid gap-1">
            <h3 className="text-muted-foreground text-xs font-medium">{t("hosts.import.proxyCommands")}</h3>
            <p className="text-xs">{t("hosts.import.proxyCommandHint")}</p>
            <ul className="grid gap-1 text-xs">
              {report.proxyCommands.map(({ host, command }) => (
                <li key={host} className="grid gap-0.5">
                  <span className="font-medium break-all">{host}</span>
                  <code className="font-mono break-all whitespace-pre-wrap">{command}</code>
                </li>
              ))}
            </ul>
          </section>
        )}
        <IssueList heading={t("hosts.import.failed")} issues={failed} />
        <IssueList heading={t("hosts.import.partial")} issues={partial} />
      </div>
      <DialogFooter>
        <Button type="button" size="sm" autoFocus onClick={onClose}>
          {t("hosts.import.close")}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function NameList({ heading, names }: { heading: string; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <section className="grid gap-1">
      <h3 className="text-muted-foreground text-xs font-medium">{heading}</h3>
      <p className="text-xs break-words">{names.join(", ")}</p>
    </section>
  );
}

function IssueList({ heading, issues }: { heading: string; issues: ImportIssue[] }) {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  return (
    <section className="grid gap-1">
      <h3 className="text-muted-foreground text-xs font-medium">{heading}</h3>
      <ul className="grid gap-1 text-xs">
        {issues.map((issue, i) => (
          <li key={i}>
            <span className="font-mono">{issue.line === undefined ? issue.entry : t("hosts.import.line", { line: issue.line })}</span>
            {": "}
            {t(`hosts.import.problems.${issue.problem.kind}`, { ...issue.problem })}
          </li>
        ))}
      </ul>
    </section>
  );
}
