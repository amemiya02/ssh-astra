import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePaletteActions } from "@/features/palette/palette-actions";
import { showToast } from "@/features/toasts/toastStore";
import { copyDiagnostics, openLogsDirectory } from "@/lib/ipc/diagnostics";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";

const actions = { open: openLogsDirectory, copy: copyDiagnostics };
type Action = keyof typeof actions;
type Feedback = "openFailed" | "copyFailed";

function useDiagnosticsActions(inlineErrors: boolean) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: Action) => {
    setFeedback(null);
    setBusy(true);
    try {
      await actions[action]();
      if (action === "copy") showToast((t) => t("settings.diagnostics.copied"));
    } catch {
      const error = action === "open" ? "openFailed" : "copyFailed";
      if (inlineErrors) setFeedback(error);
      else showToast((t) => t(`settings.diagnostics.${error}`), "error");
    } finally {
      setBusy(false);
    }
  }, [inlineErrors]);
  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(() => setFeedback(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [feedback]);
  return { run, busy, feedback };
}

export function DiagnosticsSection() {
  const { t } = useTranslation();
  const { run, busy, feedback } = useDiagnosticsActions(true);
  return (
    <>
      <SettingRow setting={settingRows.logs}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run("open")}>
          {t("settings.diagnostics.open")}
        </Button>
      </SettingRow>
      <SettingRow setting={settingRows.report}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run("copy")}>
          {t("settings.diagnostics.copy")}
        </Button>
      </SettingRow>
      {feedback && (
        <p role="status" className="text-muted-foreground py-2 text-xs">
          {t(`settings.diagnostics.${feedback}`)}
        </p>
      )}
    </>
  );
}

export function DiagnosticsPaletteActions() {
  const { t } = useTranslation();
  const { run, busy } = useDiagnosticsActions(false);
  usePaletteActions(useMemo(() => {
    if (!isTauri() || busy) return [];
    return [
      { id: "diagnostics.openLogs", title: t("settings.diagnostics.open"), run: () => void run("open") },
      { id: "diagnostics.copy", title: t("settings.diagnostics.copy"), run: () => void run("copy") },
    ];
  }, [busy, run, t]));
  return null;
}
