import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { agentAccessSetting, setAgentAccess } from "@/features/agent/agent-access";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";

export function AgentAccessSection() {
  const { t } = useTranslation();
  const [{ enabled }] = useSetting(agentAccessSetting);
  return (
    <SettingRow setting={settingRows.agentAccess}>
      <SegmentedControl
        label={t("agentAccess.title")}
        value={enabled ? "on" : "off"}
        options={[
          { value: "on", label: t("settings.on") },
          { value: "off", label: t("settings.off") },
        ]}
        onChange={(value) => void setAgentAccess(value === "on")}
      />
    </SettingRow>
  );
}
