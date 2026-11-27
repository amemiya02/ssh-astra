import type { ProxyConfig } from "@/lib/ipc/hosts";
import { defineSection } from "@/lib/storage";
import { readProxyConfig } from "./proxy-form";

/**
 * The `connection` section of the settings file. The core reads it
 * (`sshastra_core::ssh::ConnectionSettings`) whenever it opens a Connection, so a change
 * applies to Connections opened afterwards; open ones keep their interval.
 */
export interface ConnectionSettings {
  /** Seconds between keepalives on an idle Connection; 0 sends none. Three unanswered ones drop it. */
  keepaliveSeconds: number;
  /** Unix socket or Windows named pipe. A blank path uses the system agent. */
  agentPath: string;
  detectOs: boolean;
  proxy?: ProxyConfig;
}

export const maxKeepaliveSeconds = 3600;

export const defaultConnectionSettings: ConnectionSettings = { keepaliveSeconds: 30, agentPath: "", detectOs: true };

/** The choices on the Settings tab. */
export const keepaliveChoices = [0, 15, 30, 60, 120, 300] as const;

export const connectionSetting = defineSection<ConnectionSettings>("connection", defaultConnectionSettings, (raw) => {
  const record = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const value = record.keepaliveSeconds;
  const keepaliveSeconds =
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.min(maxKeepaliveSeconds, Math.round(value))
      : defaultConnectionSettings.keepaliveSeconds;
  const agentPath = typeof record.agentPath === "string" && record.agentPath.trim() ? record.agentPath : "";
  const detectOs = typeof record.detectOs === "boolean" ? record.detectOs : defaultConnectionSettings.detectOs;
  const proxy = readProxyConfig(record.proxy);
  return proxy ? { keepaliveSeconds, agentPath, detectOs, proxy } : { keepaliveSeconds, agentPath, detectOs };
});
