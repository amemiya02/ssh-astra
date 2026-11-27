import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { restoreTabsOptions, workspaceSetting } from "@/features/workspace/workspace-prefs";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";

export function WorkspaceSection() {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useSetting(workspaceSetting);
  const label = t("settings.restoreTabs.label");

  return (
    <SettingRow label={label} description={t("settings.restoreTabs.description")}>
      <SegmentedControl
        label={label}
        value={prefs.restoreTabs}
        options={restoreTabsOptions.map((value) => ({ value, label: t(`settings.restoreTabs.options.${value}`) }))}
        onChange={(restoreTabs) => setPrefs({ ...prefs, restoreTabs })}
      />
    </SettingRow>
  );
}
