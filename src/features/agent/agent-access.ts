import { showToast } from "@/features/toasts/toastStore";
import { commitSetting, defineSection, getSetting } from "@/lib/storage";

interface AgentAccessPrefs {
  enabled: boolean;
}

export const agentAccessSetting = defineSection<AgentAccessPrefs>("agentAccess", { enabled: false }, (raw) => ({
  enabled: typeof raw === "object" && raw !== null && "enabled" in raw && raw.enabled === true,
}));

let changePending = false;

export async function setAgentAccess(enabled: boolean) {
  if (changePending || getSetting(agentAccessSetting).enabled === enabled) return;
  changePending = true;
  try {
    await commitSetting(agentAccessSetting, { enabled }, !enabled);
  } catch {
    showToast((t) => t(enabled ? "agentAccess.startFailed" : "agentAccess.saveFailed"), "error");
  } finally {
    changePending = false;
  }
}
