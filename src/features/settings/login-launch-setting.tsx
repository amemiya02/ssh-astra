import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { commitSetting, defineSection, useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";
import { SettingsViewContext } from "./settings-view";

const loginLaunch = defineSection<{ enabled: boolean | null }>("loginLaunch", { enabled: false }, (raw) => {
  const enabled = raw && typeof raw === "object" && "enabled" in raw ? raw.enabled : false;
  return { enabled: enabled === null ? null : enabled === true };
});

const loginLaunchPreferences = defineSection("loginLaunchPreferences", { startInTray: false }, (raw) => ({
  startInTray: !!raw && typeof raw === "object" && "startInTray" in raw && raw.startInTray === true,
}));

export function LoginLaunchSetting() {
  const { t } = useTranslation();
  const [{ enabled }] = useSetting(loginLaunch);
  const [{ startInTray }] = useSetting(loginLaunchPreferences);
  const searching = useContext(SettingsViewContext)?.searching ?? false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"registration" | "preference">();
  const options = [
    { value: "on", label: t("settings.on") },
    { value: "off", label: t("settings.off") },
  ] as const;

  async function change(action: () => Promise<void>, failure: typeof error) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingRow
        setting={settingRows.launchAtLogin}
        description={enabled === null ? t("settings.launchAtLogin.unavailable") : undefined}
      >
        {enabled !== null && (
          <fieldset disabled={busy} className="disabled:opacity-50">
            <SegmentedControl
              label={t(settingRows.launchAtLogin.title)}
              value={enabled ? "on" : "off"}
              options={options}
              onChange={(next) => void change(() => commitSetting(loginLaunch, { enabled: next === "on" }), "registration")}
            />
            {error === "registration" && (
              <p role="alert" className="text-destructive mt-1 text-xs">{t("settings.launchAtLogin.error")}</p>
            )}
          </fieldset>
        )}
      </SettingRow>
      {enabled ? (
        <SettingRow setting={settingRows.startInTray}>
          <fieldset disabled={busy} className="disabled:opacity-50">
            <SegmentedControl
              label={t(settingRows.startInTray.title)}
              value={startInTray ? "on" : "off"}
              options={options}
              onChange={(next) => void change(() => commitSetting(loginLaunchPreferences, { startInTray: next === "on" }), "preference")}
            />
            {error === "preference" && (
              <p role="alert" className="text-destructive mt-1 text-xs">{t("settings.startInTray.error")}</p>
            )}
          </fieldset>
        </SettingRow>
      ) : searching && <SettingRow setting={settingRows.startInTray} description={t("settings.startInTray.requiresLoginLaunch")} />}
    </>
  );
}
