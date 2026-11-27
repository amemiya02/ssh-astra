import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  cancelOpenSshPreview,
  disableOpenSshSync,
  enableOpenSshSync,
  previewOpenSshSync,
  refreshOpenSshSync,
  type OpenSshPreview,
} from "@/lib/ipc/ssh-config-export";
import { defineSection, useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";
import { useSettingRowVisible } from "./settings-view";

const problems = ["configChanged", "missingInclude", "includeConflict", "fragmentExists", "homeUnavailable", "hostsUnavailable", "io"] as const;
type Problem = typeof problems[number];

type Reason = "userAlias" | "duplicateAlias" | "invalidField" | "unsupportedProxy" | "jumpUnavailable"
  | "httpForward" | "manualForward" | "invalidForward";

interface OpenSshStatus {
  enabled: boolean;
  includeLine?: string;
  report?: {
    aliases: string[];
    issues: { host: string; alias: string; reason: Reason }[];
  };
  problem?: Problem;
}

const openSshSyncSetting = defineSection<OpenSshStatus>("openSshSync", { enabled: false }, (raw) => {
  const status = raw as Partial<OpenSshStatus> | null;
  return { ...status, enabled: status?.enabled === true };
});

function problemFrom(error: unknown): Problem {
  const kind = typeof error === "object" && error !== null && "kind" in error ? error.kind : undefined;
  return problems.find((problem) => problem === kind) ?? "io";
}

export function OpenSshSyncSetting() {
  return useSettingRowVisible(settingRows.openSshSync) ? <VisibleOpenSshSyncSetting /> : null;
}

function VisibleOpenSshSyncSetting() {
  const { t } = useTranslation();
  const [status] = useSetting(openSshSyncSetting);
  const [preview, setPreview] = useState<OpenSshPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem>();

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(problemFrom(failure));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    if (busy) return;
    setPreview(undefined);
    void cancelOpenSshPreview().catch(() => {});
  }

  const problem = error ?? status.problem;
  const report = status.enabled && !status.problem ? status.report : undefined;
  return (
    <>
      <SettingRow setting={settingRows.openSshSync}>
        <div className="flex flex-wrap items-center gap-2" aria-busy={busy}>
          <SegmentedControl
            label={t(settingRows.openSshSync.title)}
            value={status.enabled ? "on" : "off"}
            options={[
              { value: "on", label: t("settings.on") },
              { value: "off", label: t("settings.off") },
            ]}
            onChange={(value) => {
              if (busy || (value === "on") === status.enabled) return;
              void run(value === "on"
                ? async () => setPreview(await previewOpenSshSync())
                : disableOpenSshSync);
            }}
          />
          {status.enabled && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(refreshOpenSshSync)}>
              {t("settings.connection.openSshSync.refresh")}
            </Button>
          )}
        </div>
      </SettingRow>
      {problem && <p role="alert" className="text-destructive py-2 text-xs">{t(`settings.connection.openSshSync.problems.${problem}`)}</p>}
      {!status.enabled && status.includeLine && (
        <div role="status" className="text-muted-foreground space-y-1 py-2 text-xs">
          <p>{t("settings.connection.openSshSync.removeInclude")}</p>
          <code dir="ltr">{status.includeLine}</code>
        </div>
      )}
      {report && (
        <div role="status" className="text-muted-foreground max-h-64 space-y-2 overflow-auto py-2 text-xs">
          <p>{t("settings.connection.openSshSync.written", { count: report.aliases.length })}</p>
          {report.aliases.length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {report.aliases.map((alias) => <li key={alias} className="wrap-anywhere"><code dir="ltr">{alias}</code></li>)}
            </ul>
          )}
          {report.issues.length > 0 && (
            <ul className="space-y-1">
              {report.issues.map(({ host, alias, reason }) => (
                <li key={JSON.stringify([host, alias, reason])} className="wrap-anywhere">
                  <code dir="ltr" title={host}>{alias}</code>{" "}
                  {t(`settings.connection.openSshSync.issues.${reason}`)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Dialog open={Boolean(preview) && !status.enabled} onOpenChange={(open) => { if (!open) cancel(); }}>
        {preview && (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{t("settings.connection.openSshSync.confirmTitle")}</DialogTitle>
              <DialogDescription>
                {t(preview.addsInclude
                  ? "settings.connection.openSshSync.confirmAdd"
                  : "settings.connection.openSshSync.confirmExisting")}
              </DialogDescription>
            </DialogHeader>
            {preview.addsInclude && (
              <pre className="bg-muted overflow-x-auto rounded-md p-3 text-sm" dir="ltr"><code>{preview.line}</code></pre>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {t("settings.connection.openSshSync.cancel")}
              </Button>
              <Button disabled={busy} onClick={() => {
                setPreview(undefined);
                void run(() => enableOpenSshSync(preview.approval));
              }}>
                {t("settings.connection.openSshSync.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
