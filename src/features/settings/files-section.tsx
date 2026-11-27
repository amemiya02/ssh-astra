import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { filesSetting } from "@/features/files/file-prefs";
import { useTerminalPrefs } from "@/features/terminal/terminal-prefs-context";
import { showToast } from "@/features/toasts/toastStore";
import { operatingSystem } from "@/features/workspace/shortcuts";
import { pickOpenPath } from "@/lib/ipc/system";
import { commitSetting, getSetting, useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";

const toggles = ["showModified", "showPermissions", "terminalFollowsFilePanel"] as const;

export function FilesSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useSetting(filesSetting);
  const { prefs } = useTerminalPrefs();
  const [changingEditor, setChangingEditor] = useState(false);

  async function changeEditor(choose: boolean) {
    setChangingEditor(true);
    try {
      let application = null;
      if (choose) {
        const platform = operatingSystem();
        const mac = platform === "mac";
        const windows = platform === "windows";
        application = await pickOpenPath({
          title: t("settings.files.remoteEditApplication.pickTitle"),
          defaultPath: mac ? "/Applications" : windows ? undefined : "/usr/share/applications",
          filters: mac || windows
            ? [{ name: t("settings.files.remoteEditApplication.filter"), extensions: [mac ? "app" : "exe"] }]
            : undefined,
        });
        if (application === null) return;
      }
      await commitSetting(filesSetting, { ...getSetting(filesSetting), remoteEditApplication: application }, true);
    } catch {
      showToast((translate) => translate("settings.files.remoteEditApplication.changeFailed"), "error");
    } finally {
      setChangingEditor(false);
    }
  }

  const rows = toggles.map((key) => {
    const setting = settingRows[key];
    const label = t(setting.title);
    return (
      <SettingRow key={key} setting={setting}
        description={key === "terminalFollowsFilePanel" && !prefs.shellIntegration
          ? t("settings.files.terminalFollowsFilePanel.shellIntegrationOff")
          : undefined}
      >
        <SegmentedControl
          label={label}
          value={settings[key] ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          onChange={(value) => setSettings({ ...getSetting(filesSetting), [key]: value === "on" })}
        />
      </SettingRow>
    );
  });
  return (
    <>
      {rows}
      <SettingRow setting={settingRows.remoteEditApplication}>
        <div className="space-y-1.5">
          <p dir="auto" className="text-muted-foreground max-w-72 text-xs wrap-anywhere">
            {settings.remoteEditApplication ?? t("settings.files.remoteEditApplication.systemDefault")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={changingEditor} onClick={() => void changeEditor(true)}>
              {t("settings.files.remoteEditApplication.choose")}
            </Button>
            {settings.remoteEditApplication && (
              <Button size="sm" variant="outline" disabled={changingEditor} onClick={() => void changeEditor(false)}>
                {t("settings.files.remoteEditApplication.reset")}
              </Button>
            )}
          </div>
        </div>
      </SettingRow>
    </>
  );
}
