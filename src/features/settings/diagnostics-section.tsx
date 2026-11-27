import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePaletteActions } from "@/features/palette/palette-actions";
import { copyDiagnostics, openLogsDirectory } from "@/lib/ipc/diagnostics";
import { SettingRow } from "./SettingRow";

const actions = { open: openLogsDirectory, copy: copyDiagnostics };
type Action = keyof typeof actions;
type Feedback = "copied" | "openFailed" | "copyFailed";

function useDiagnosticsActions() {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: Action) => {
    setFeedback(null);
    setBusy(true);
    try {
      await actions[action]();
      if (action === "copy") setFeedback("copied");
    } catch {
      setFeedback(action === "open" ? "openFailed" : "copyFailed");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!feedback) return;
    const timeout = window.setTimeout(() => setFeedback(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [feedback]);
  return { run, busy, feedback };
}

export function DiagnosticsSection() {
  const { t } = useTranslation();
  const { run, busy, feedback } = useDiagnosticsActions();
  return (
    <>
      <SettingRow label={t("settings.diagnostics.logs")} description={t("settings.diagnostics.logsDescription")}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void run("open")}>
          {t("settings.diagnostics.open")}
        </Button>
      </SettingRow>
      <SettingRow label={t("settings.diagnostics.report")} description={t("settings.diagnostics.reportDescription")}>
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
  const { run, busy, feedback } = useDiagnosticsActions();
  usePaletteActions(useMemo(() => {
    if (!isTauri() || busy) return [];
    return [
      { id: "diagnostics.openLogs", title: t("settings.diagnostics.open"), run: () => void run("open") },
      { id: "diagnostics.copy", title: t("settings.diagnostics.copy"), run: () => void run("copy") },
    ];
  }, [busy, run, t]));
  return feedback && (
    <p role="status" className="bg-popover text-popover-foreground pointer-events-none fixed right-3 bottom-9 z-50 rounded-md border px-3 py-2 text-xs shadow-md">
      {t(`settings.diagnostics.${feedback}`)}
    </p>
  );
}
