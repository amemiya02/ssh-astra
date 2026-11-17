import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ImportIssue, ImportReport } from "@/lib/ipc/hosts";

/** What an `~/.ssh/config` import did: counts, then the names in each outcome and why. */
export function ImportReportDialogContent({ report, onClose }: { report: ImportReport; onClose(): void }) {
  const { t } = useTranslation();
  const failed = report.issues.filter((i) => i.dropped);
  const partial = report.issues.filter((i) => !i.dropped);
  const empty = report.imported.length + report.skipped.length + report.issues.length === 0;
  return (
    <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] p-5 sm:max-w-120">
      <DialogHeader>
        <DialogTitle>{t("hosts.import.title")}</DialogTitle>
        <DialogDescription>
          {empty
            ? t("hosts.import.nothing")
            : t("hosts.import.summary", {
                imported: report.imported.length,
                skipped: report.skipped.length,
                failed: failed.length,
              })}
        </DialogDescription>
      </DialogHeader>
      <div className="grid max-h-80 gap-3 overflow-y-auto">
        <NameList heading={t("hosts.import.imported")} names={report.imported} />
        <NameList heading={t("hosts.import.skipped")} names={report.skipped} />
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
      <p className="font-mono text-xs break-words">{names.join(", ")}</p>
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
            <span className="font-mono">{issue.entry}</span>
            {": "}
            {t(`hosts.import.problems.${issue.problem.kind}`, { ...issue.problem })}
          </li>
        ))}
      </ul>
    </section>
  );
}
