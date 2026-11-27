import { useState } from "react";
import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Host } from "@/lib/ipc/hosts";
import { importOpenSshAliases, refreshOpenSshSync } from "@/lib/ipc/ssh-config-export";
import { useSetting } from "@/lib/storage";
import { openSshSyncSetting, type OpenSshReadReport, type OpenSshStatus } from "./openSshSyncSetting";

const copy = "settings.connection.openSshSync" as const;

export function OpenSshMissing({ host }: { host: Host }) {
  const { t } = useTranslation();
  if (!host.openSshSource?.missing) return null;
  const text = t("hosts.openSshMissing");
  return (
    <span className="text-muted-foreground inline-flex shrink-0" title={text}>
      <CircleAlert aria-hidden className="size-3.5" />
      <span className="sr-only">{text}</span>
    </span>
  );
}

function Aliases({ names }: { names: string[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {names.map((name) => <li key={name} className="wrap-anywhere"><code dir="ltr">{name}</code></li>)}
    </ul>
  );
}

function OpenSshImportButton({ status }: { status: OpenSshStatus }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ approval: number; report: OpenSshReadReport }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"changed" | "failed">();
  if (!status.enabled || !status.read || status.readApproval == null) return null;
  const review = { approval: status.readApproval, report: status.read };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => { setError(undefined); setPreview(review); }}>
        {t(`${copy}.read.review`)}
      </Button>
      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open && !busy) setPreview(undefined); }}>
        {preview && (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{t(`${copy}.read.title`)}</DialogTitle>
              <DialogDescription>{t(`${copy}.read.description`)}</DialogDescription>
            </DialogHeader>
            <div className="max-h-72 space-y-2 overflow-auto text-sm">
              {preview.report.available.length > 0 && <Aliases names={preview.report.available} />}
              {preview.report.dependencies.length > 0 && (
                <>
                  <p>{t(`${copy}.read.dependencies`)}</p>
                  <Aliases names={preview.report.dependencies} />
                </>
              )}
              {preview.report.proxyCommands.length > 0 && (
                <>
                  <p>{t(`${copy}.read.proxyCommands`)}</p>
                  <ul className="space-y-1">
                    {preview.report.proxyCommands.map(({ host, command }) => (
                      <li key={host} className="wrap-anywhere">
                        {host} <code dir="ltr">{command}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            {error && <p role="alert" className="text-destructive text-sm">{t(`${copy}.read.${error}`)}</p>}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setPreview(undefined)}>
                {t(`${copy}.cancel`)}
              </Button>
              {error === "changed" ? (
                <Button disabled={busy} onClick={async () => {
                  setPreview(undefined);
                  try { await refreshOpenSshSync(); } catch { setError("failed"); }
                }}>
                  {t(`${copy}.refresh`)}
                </Button>
              ) : (
                <Button disabled={busy} onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    await importOpenSshAliases(preview.approval);
                    setPreview(undefined);
                  } catch (failure) {
                    setError(typeof failure === "object" && failure !== null && "kind" in failure
                      && failure.kind === "readReviewChanged" ? "changed" : "failed");
                  } finally {
                    setBusy(false);
                  }
                }}>
                  {t(`${copy}.read.import`)}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

export function OpenSshReadSettings({ status }: { status: OpenSshStatus }) {
  const { t } = useTranslation();
  if (!status.enabled) return null;
  const report = status.read;
  if (!report && !status.readProblem) return null;
  const invalid = [...new Set(report?.issues.filter((issue) => issue.dropped).map((issue) => issue.entry) ?? [])];
  return (
    <div className="text-muted-foreground max-h-64 space-y-2 overflow-auto py-2 text-xs">
      {status.readProblem && <p role="alert" className="text-destructive">{t(`${copy}.read.readFailed`)}</p>}
      {report && (
        <>
          <div role="status" className="space-y-2">
            {([
              ["updated", report.updated],
              ["missing", report.missing],
              ["imported", report.imported],
              ["awaitingJump", report.awaitingJump],
              ["invalid", invalid],
            ] as const).map(([label, names]) => names.length > 0 && (
              <div key={label}><p>{t(`${copy}.read.${label}`)}</p><Aliases names={names} /></div>
            ))}
            {report.issues.some((issue) => issue.problem.kind === "includeFailed") && (
              <p>{t(`${copy}.read.includeIncomplete`)}</p>
            )}
          </div>
          <OpenSshImportButton status={status} />
        </>
      )}
    </div>
  );
}

export function OpenSshStartupOffer() {
  const { t } = useTranslation();
  const [status] = useSetting(openSshSyncSetting);
  const [dismissed, setDismissed] = useState(false);
  if (!status.startupOffer || dismissed) return null;
  return (
    <div className="bg-popover fixed bottom-8 left-4 z-10 flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-md border p-2 text-sm shadow-md">
      <p role="status" className="px-1">{t(`${copy}.read.startupOffer`)}</p>
      <OpenSshImportButton status={status} />
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>{t(`${copy}.read.dismiss`)}</Button>
    </div>
  );
}
