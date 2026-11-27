import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { agentAccessSetting, setAgentAccess } from "@/features/agent/agent-access";
import { showToast } from "@/features/toasts/toastStore";
import { clearAgentActivity, listAgentActivity, type AgentActivity } from "@/lib/ipc/agent";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";
import { useSettingRowVisible } from "./settings-view";

export function AgentAccessSection() {
  const { t } = useTranslation();
  const [{ enabled }] = useSetting(agentAccessSetting);
  const showActivity = useSettingRowVisible(settingRows.agentActivity);
  return (
    <>
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
      {showActivity && <AgentActivityList />}
    </>
  );
}

function AgentActivityList() {
  const { t, i18n } = useTranslation();
  const [snapshot, setSnapshot] = useState<AgentActivity[] | "loading" | "loadFailed">("loading");
  const [revision, setRevision] = useState(0);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let current = true;
    void listAgentActivity().then(
      (result) => { if (current) setSnapshot(result); },
      () => { if (current) setSnapshot("loadFailed"); },
    );
    return () => { current = false; };
  }, [revision]);

  async function clear() {
    setClearing(true);
    try {
      await clearAgentActivity();
      setSnapshot([]);
    } catch {
      showToast((translate) => translate("agentAccess.activity.clearFailed"), "error");
    } finally {
      setClearing(false);
    }
  }

  const dateFormat = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "medium" });
  const status = typeof snapshot === "string" ? snapshot : snapshot.length === 0 ? "empty" : null;

  return (
    <div>
      <SettingRow setting={settingRows.agentActivity}>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={snapshot === "loading" || clearing} onClick={() => {
            setSnapshot("loading");
            setRevision((value) => value + 1);
          }}>
            {t("agentAccess.activity.refresh")}
          </Button>
          <Button variant="outline" size="sm" disabled={snapshot === "loading" || clearing || status === "empty"} onClick={() => void clear()}>
            {t("agentAccess.activity.clear")}
          </Button>
        </div>
      </SettingRow>
      {status && <p role="status" className="text-muted-foreground pb-3 text-xs">{t(`agentAccess.activity.${status}`)}</p>}
      {Array.isArray(snapshot) && snapshot.length > 0 && (
        <ul aria-label={t("agentAccess.activity.title")} className="divide-y border-t">
          {snapshot.map(({ timestamp, tool, host, path, outcome }, index) => (
            <li key={`${timestamp}-${index}`} className="space-y-1 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-sm">
                  {tool === "unknown" ? t("agentAccess.activity.unknownTool") : <code>{tool}</code>}
                  <span className="text-muted-foreground ml-2 text-xs">{t(`agentAccess.activity.outcome.${outcome}`)}</span>
                </span>
                <time className="text-muted-foreground text-xs tabular-nums" dateTime={new Date(timestamp).toISOString()}>
                  {dateFormat.format(timestamp)}
                </time>
              </div>
              {host !== undefined && <bdi className="block text-xs wrap-anywhere">{host}</bdi>}
              {path !== undefined && <bdi className="text-muted-foreground block font-mono text-xs wrap-anywhere whitespace-pre-wrap">{path}</bdi>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
