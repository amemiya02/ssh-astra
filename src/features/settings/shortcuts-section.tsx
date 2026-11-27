import { useCallback, useContext, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { shortcutSetting, useResolvedShortcuts } from "@/features/workspace/shortcut-settings";
import {
  captureShortcut,
  currentPlatform,
  editShortcut,
  shortcutLabels,
  type CapturedShortcut,
  type ResolvedShortcuts,
  type ShortcutCaptureIssue,
  type ShortcutName,
  type ShortcutOverrides,
} from "@/features/workspace/shortcuts";
import { ShortcutCaptureContext } from "@/features/workspace/use-workspace-shortcuts";
import { getSetting, setSetting, useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows, shortcutRows, type SettingRowDefinition } from "./setting-rows";
import { SettingsViewContext } from "./settings-view";

export function ShortcutsSection() {
  const { t } = useTranslation();
  const platform = useContext(ShortcutCaptureContext)?.platform ?? currentPlatform();
  const view = useContext(SettingsViewContext);
  const shortcuts = useResolvedShortcuts(platform);
  const [overrides, setOverrides] = useSetting(shortcutSetting);

  return (
    <>
      <SettingRow setting={settingRows.resetShortcuts}>
        <Button size="sm" variant="outline" disabled={Object.keys(overrides).length === 0} onClick={() => setOverrides({})}>
          {t("settings.shortcuts.resetAll")}
        </Button>
      </SettingRow>
      {[...shortcutRows].map(([name, setting]) => (!view || view.visibleRows.has(setting)) && (
        <ShortcutRow key={name} name={name} setting={setting} shortcuts={shortcuts} overrides={overrides} />
      ))}
    </>
  );
}

function ShortcutRow({ name, setting, shortcuts, overrides }: {
  name: ShortcutName;
  setting: SettingRowDefinition;
  shortcuts: ResolvedShortcuts;
  overrides: ShortcutOverrides;
}) {
  const { t, i18n } = useTranslation();
  const context = useContext(ShortcutCaptureContext);
  const chordId = useId();
  const recordButton = useRef<HTMLButtonElement>(null);
  const [recording, setRecording] = useState(false);
  const [issue, setIssue] = useState<ShortcutCaptureIssue>();
  const [pending, setPending] = useState<{
    chord: CapturedShortcut | undefined;
    conflicts: ShortcutName[];
    previous: ShortcutOverrides;
  }>();
  const conflict = pending?.previous === overrides ? pending : undefined;
  const { platform } = shortcuts;

  const apply = useCallback((chord: CapturedShortcut | undefined, replace = false) => {
    const previous = getSetting(shortcutSetting);
    const result = editShortcut(platform, previous, name, chord, replace);
    if ("conflicts" in result) {
      setPending({ chord, conflicts: result.conflicts, previous });
    } else {
      setSetting(shortcutSetting, result.overrides);
      setPending(undefined);
    }
  }, [name, platform]);

  useLayoutEffect(() => {
    if (!recording || !context) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        setRecording(false);
        setIssue(undefined);
        return;
      }
      const result = captureShortcut(event, platform);
      if (!result) return;
      if ("issue" in result) {
        setIssue(result.issue);
      } else {
        setIssue(undefined);
        setRecording(false);
        apply(result.chord);
      }
    };
    return context.registerCapture(handler);
  }, [apply, context, platform, recording]);

  const action = t(setting.title);
  const labels = shortcutLabels(name, shortcuts);
  const conflictActions = conflict && new Intl.ListFormat(i18n.resolvedLanguage).format(
    conflict.conflicts.map((other) => t(`settings.shortcuts.actions.${other}`)),
  );

  return (
    <div>
      <SettingRow setting={setting}>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            ref={recordButton}
            variant="outline"
            size="sm"
            disabled={!context}
            aria-label={t("settings.shortcuts.edit", { action })}
            aria-describedby={chordId}
            aria-pressed={recording}
            onClick={(event) => {
              event.currentTarget.focus();
              setPending(undefined);
              setIssue(undefined);
              setRecording(!recording);
            }}
            onBlur={() => {
              setRecording(false);
              setIssue(undefined);
            }}
          >
            <span id={chordId} aria-live="polite">
              {recording ? t("settings.shortcuts.recording") : labels.join(" / ") || t("settings.shortcuts.unassigned")}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("settings.shortcuts.resetAction", { action })}
            disabled={overrides[name] === undefined}
            onClick={() => {
              recordButton.current?.focus();
              apply(undefined);
            }}
          >
            {t("settings.shortcuts.reset")}
          </Button>
        </div>
      </SettingRow>
      {issue && <p role="alert" className="text-destructive pb-3 text-xs">{t(`settings.shortcuts.${issue}`)}</p>}
      {conflict && (
        <div className="bg-popover mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
          <p role="alert" className="text-sm">
            {t(conflict.chord ? "settings.shortcuts.conflict" : "settings.shortcuts.resetConflict", {
              action: conflictActions,
            })}
          </p>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="ghost" onClick={() => {
              recordButton.current?.focus();
              setPending(undefined);
            }}>
              {t("settings.shortcuts.cancel")}
            </Button>
            <Button size="sm" onClick={() => {
              recordButton.current?.focus();
              apply(conflict.chord, true);
            }}>
              {t("settings.shortcuts.replace")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
