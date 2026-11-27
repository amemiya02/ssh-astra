import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { updateSetting } from "@/features/updates/update-settings";
import { updatesStore, useUpdates } from "@/features/updates/updatesStore";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";

/** The running version, once the app has said it. */
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion, () => setVersion(null));
  }, []);
  return version;
}

export function UpdatesSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useSetting(updateSetting);
  const status = useUpdates((s) => s.status);
  const version = useAppVersion();
  const autoLabel = t(settingRows.checkOnStartup.title);
  const busy = status.type === "checking" || status.type === "downloading" || status.type === "restarting";

  return (
    <>
      <SettingRow
        setting={settingRows.version}
        descriptionValues={version ? { version } : undefined}
        description={version ? undefined : null}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void updatesStore.getState().check("manual")}
        >
          {status.type === "checking" ? t("updates.checking") : t("updates.check")}
        </Button>
      </SettingRow>
      <SettingRow setting={settingRows.checkOnStartup}>
        <SegmentedControl
          label={autoLabel}
          value={settings.checkOnStartup ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          onChange={(next) => setSettings({ ...settings, checkOnStartup: next === "on" })}
        />
      </SettingRow>
    </>
  );
}
