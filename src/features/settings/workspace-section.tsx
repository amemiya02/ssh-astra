import { isTauri } from "@tauri-apps/api/core";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { restoreTabsOptions, tabOrientations, workspaceSetting } from "@/features/workspace/workspace-prefs";
import { useSetting } from "@/lib/storage";
import { LoginLaunchSetting } from "./login-launch-setting";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";
import { SettingsViewContext } from "./settings-view";

export function WorkspaceSection() {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useSetting(workspaceSetting);
  const searching = useContext(SettingsViewContext)?.searching ?? false;
  const restoreLabel = t(settingRows.restoreTabs.title);
  const orientationLabel = t(settingRows.tabOrientation.title);
  const groupTabsLabel = t(settingRows.groupTabsByHost.title);
  const confirmCloseLabel = t(settingRows.confirmClose.title);
  const confirmQuitLabel = t(settingRows.confirmQuit.title);

  return (
    <>
      <SettingRow setting={settingRows.tabOrientation}>
        <SegmentedControl
          label={orientationLabel}
          value={prefs.tabOrientation}
          options={tabOrientations.map((value) => ({ value, label: t(`settings.tabOrientation.options.${value}`) }))}
          onChange={(tabOrientation) => setPrefs({ ...prefs, tabOrientation })}
        />
      </SettingRow>
      {prefs.tabOrientation === "vertical" && (
        <SettingRow setting={settingRows.groupTabsByHost}>
          <SegmentedControl
            label={groupTabsLabel}
            value={prefs.groupTabsByHost ? "on" : "off"}
            options={[
              { value: "on", label: t("settings.on") },
              { value: "off", label: t("settings.off") },
            ]}
            onChange={(value) => setPrefs({ ...prefs, groupTabsByHost: value === "on" })}
          />
        </SettingRow>
      )}
      {prefs.tabOrientation === "horizontal" && searching && (
        <SettingRow setting={settingRows.groupTabsByHost} description={t("settings.groupTabsRequiresVertical")} />
      )}
      <SettingRow setting={settingRows.restoreTabs}>
        <SegmentedControl
          label={restoreLabel}
          value={prefs.restoreTabs}
          options={restoreTabsOptions.map((value) => ({ value, label: t(`settings.restoreTabs.options.${value}`) }))}
          onChange={(restoreTabs) => setPrefs({ ...prefs, restoreTabs })}
        />
      </SettingRow>
      <SettingRow setting={settingRows.confirmClose}>
        <SegmentedControl
          label={confirmCloseLabel}
          value={prefs.confirmClose ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          onChange={(value) => setPrefs({ ...prefs, confirmClose: value === "on" })}
        />
      </SettingRow>
      <SettingRow setting={settingRows.confirmQuit}>
        <SegmentedControl
          label={confirmQuitLabel}
          value={prefs.confirmQuit ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          onChange={(value) => setPrefs({ ...prefs, confirmQuit: value === "on" })}
        />
      </SettingRow>
      {isTauri() && (
        <SettingRow setting={settingRows.closeToTray}>
          <SegmentedControl
            label={t(settingRows.closeToTray.title)}
            value={prefs.closeToTray ? "on" : "off"}
            options={[
              { value: "on", label: t("settings.on") },
              { value: "off", label: t("settings.off") },
            ]}
            onChange={(value) => setPrefs({ ...prefs, closeToTray: value === "on" })}
          />
        </SettingRow>
      )}
      {isTauri() && <LoginLaunchSetting />}
    </>
  );
}
