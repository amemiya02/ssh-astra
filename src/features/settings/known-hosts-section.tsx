import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { showToast } from "@/features/toasts/toastStore";
import { privacyModeSetting } from "@/features/workspace/privacy-mode";
import { listKnownHosts, revealKnownHosts, type KnownHostsSnapshot } from "@/lib/ipc/known-hosts";
import { writeClipboardText } from "@/lib/ipc/system";
import { useSetting } from "@/lib/storage";
import { settingRows } from "./setting-rows";
import { useSettingRowVisible } from "./settings-view";
import { SettingRow } from "./SettingRow";

export function KnownHostsSection() {
  return useSettingRowVisible(settingRows.knownHosts) ? <KnownHostsList /> : null;
}

function KnownHostsList() {
  const { t } = useTranslation();
  const [privacyMode] = useSetting(privacyModeSetting);
  const [snapshot, setSnapshot] = useState<KnownHostsSnapshot | "loading" | "loadFailed">("loading");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    void listKnownHosts().then(
      (result) => { if (current) setSnapshot(result); },
      () => { if (current) setSnapshot("loadFailed"); },
    );
    return () => { current = false; };
  }, [revision]);

  async function reveal() {
    try {
      await revealKnownHosts();
    } catch {
      showToast((translate) => translate("settings.knownHosts.revealFailed"), "error");
    }
  }

  async function copy(command: string) {
    try {
      await writeClipboardText(command);
      showToast((translate) => translate("settings.knownHosts.copied"));
    } catch {
      showToast((translate) => translate("settings.knownHosts.copyFailed"), "error");
    }
  }

  const file = typeof snapshot === "object" ? snapshot : null;
  const status = typeof snapshot === "string" ? snapshot :
    snapshot.entries === null ? "missing" : snapshot.entries.length === 0 ? "empty" : null;

  return (
    <>
      <SettingRow setting={settingRows.knownHosts}>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={snapshot === "loading"} onClick={() => {
            setSnapshot("loading");
            setRevision((value) => value + 1);
          }}>
            {t("settings.knownHosts.refresh")}
          </Button>
          {!privacyMode && file?.entries && (
            <Button variant="outline" size="sm" onClick={() => void reveal()}>
              {t("settings.knownHosts.reveal")}
            </Button>
          )}
        </div>
      </SettingRow>
      <div className="space-y-2 py-3">
        {!privacyMode && file?.path && (
          <p dir="ltr" className="text-muted-foreground font-mono text-xs wrap-anywhere">{file.path}</p>
        )}
        {privacyMode && <p className="text-muted-foreground text-xs">{t("settings.knownHosts.private")}</p>}
        {status && <p role="status" className="text-muted-foreground text-xs">{t(`settings.knownHosts.${status}`)}</p>}
        {file?.entries && file.entries.length > 0 && (
          <>
            {!privacyMode && file.entries.some((entry) => entry.removalCommand !== null) && (
              <p className="text-muted-foreground text-xs">{t(file.windows ? "settings.knownHosts.powershell" : "settings.knownHosts.posix")}</p>
            )}
            <ul className="divide-y">
              {file.entries.map((entry) => {
                const command = privacyMode ? null : entry.removalCommand;
                return (
                  <li key={entry.line} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
                    <div className="min-w-0 flex-1 space-y-0.5 wrap-anywhere">
                      {!privacyMode && <bdi className="block font-mono text-sm">{entry.hosts}</bdi>}
                      <p className="text-muted-foreground text-xs">
                        {t("settings.knownHosts.line", { line: entry.line })}
                        <bdi className="ml-2 font-mono">{entry.marker && `${entry.marker} `}{entry.algorithm}</bdi>
                      </p>
                      {!privacyMode && <bdi className="text-muted-foreground block font-mono text-xs">{entry.fingerprint}</bdi>}
                    </div>
                    {command ? (
                      <Button variant="outline" size="sm" aria-label={t("settings.knownHosts.copyForLine", { line: entry.line })} onClick={() => void copy(command)}>
                        {t("settings.knownHosts.copy")}
                      </Button>
                    ) : !privacyMode && (
                      <span className="text-muted-foreground text-xs">{t("settings.knownHosts.unavailable")}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
