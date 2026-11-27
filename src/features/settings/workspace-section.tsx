import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { restoreTabsOptions, workspaceSetting } from "@/features/workspace/workspace-prefs";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";

export function WorkspaceSection() {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useSetting(workspaceSetting);
  const restoreLabel = t("settings.restoreTabs.label");
  const confirmCloseLabel = t("settings.confirmClose.label");

  return (
    <>
      <SettingRow label={restoreLabel} description={t("settings.restoreTabs.description")}>
        <SegmentedControl
          label={restoreLabel}
          value={prefs.restoreTabs}
          options={restoreTabsOptions.map((value) => ({ value, label: t(`settings.restoreTabs.options.${value}`) }))}
          onChange={(restoreTabs) => setPrefs({ ...prefs, restoreTabs })}
        />
      </SettingRow>
      <SettingRow label={confirmCloseLabel} description={t("settings.confirmClose.description")}>
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
    </>
  );
}
