import { isTauri } from "@tauri-apps/api/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ProxyFields } from "@/features/connect/ProxyFields";
import { parseProxyForm, proxyFormFrom, type ProxyField } from "@/features/connect/proxy-form";
import { clearGlobalProxyPassword } from "@/lib/ipc/credentials";
import type { ProxyConfig } from "@/lib/ipc/hosts";
import { SegmentedControl } from "@/components/SegmentedControl";
import { connectionSetting, keepaliveChoices } from "@/features/connect/connection-settings";
import { useSetting } from "@/lib/storage";
import { CommitField } from "./CommitField";
import { OpenSshSyncSetting } from "./open-ssh-sync-setting";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";

export function ConnectionSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useSetting(connectionSetting);
  const label = t(settingRows.keepalive.title);
  // A hand-edited value outside the choices still shows, as its own option.
  const choices = keepaliveChoices.some((s) => s === settings.keepaliveSeconds)
    ? [...keepaliveChoices]
    : [...keepaliveChoices, settings.keepaliveSeconds].sort((a, b) => a - b);
  return (
    <>
      <SettingRow setting={settingRows.osDetection}>
        <SegmentedControl
          label={t(settingRows.osDetection.title)}
          value={settings.detectOs ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          onChange={(value) => setSettings({ ...settings, detectOs: value === "on" })}
        />
      </SettingRow>
      <SettingRow setting={settingRows.keepalive}>
        <SegmentedControl
          label={label}
          value={String(settings.keepaliveSeconds)}
          options={choices.map((seconds) => ({
            value: String(seconds),
            label:
              seconds === 0
                ? t("settings.connection.keepalive.off")
                : t("settings.connection.keepalive.seconds", { count: seconds }),
          }))}
          onChange={(value) => setSettings({ ...settings, keepaliveSeconds: Number(value) })}
        />
      </SettingRow>
      <SettingRow setting={settingRows.agentPath}>
        <CommitField
          id="settings-connection-agent-path"
          label={t(settingRows.agentPath.title)}
          value={settings.agentPath}
          onCommit={(path) => setSettings(connectionSetting.parse({ ...settings, agentPath: path }))}
          className="h-8 w-64 max-w-full font-mono"
        />
      </SettingRow>
      <SettingRow setting={settingRows.outboundProxy}>
        <GlobalProxyForm
          saved={settings.proxy}
          onSave={(proxy) => setSettings(connectionSetting.parse({ ...settings, proxy }))}
        />
      </SettingRow>
      {isTauri() && <OpenSshSyncSetting />}
    </>
  );
}


function GlobalProxyForm({ saved, onSave }: { saved?: ProxyConfig; onSave(proxy?: ProxyConfig): void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(() => proxyFormFrom(saved ? { mode: "override", config: saved } : { mode: "direct" }));
  const [errors, setErrors] = useState<Partial<Record<ProxyField, string>>>({});
  const [clearing, setClearing] = useState<"idle" | "clearing" | "cleared" | "failed">("idle");

  return (
    <form
      className="grid w-64 gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseProxyForm(form);
        setErrors(parsed.ok ? {} : parsed.errors);
        if (parsed.ok) onSave(parsed.proxy.mode === "override" ? parsed.proxy.config : undefined);
      }}
    >
      <ProxyFields id="settings-outbound-proxy" global values={form} errors={errors} onChange={setForm} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" size="sm">{t("proxy.save")}</Button>
        {saved?.username && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={clearing === "clearing"}
            onClick={() => {
              setClearing("clearing");
              clearGlobalProxyPassword().then(() => setClearing("cleared"), () => setClearing("failed"));
            }}
          >
            {t("proxy.clearPassword")}
          </Button>
        )}
      </div>
      {clearing === "cleared" && <p role="status" className="text-muted-foreground text-xs">{t("proxy.passwordCleared")}</p>}
      {clearing === "failed" && <p role="alert" className="text-destructive text-xs">{t("proxy.clearFailed")}</p>}
    </form>
  );
}
