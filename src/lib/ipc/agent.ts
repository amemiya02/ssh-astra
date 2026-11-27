import { invoke } from "@tauri-apps/api/core";

export interface AgentActivity {
  timestamp: number;
  tool: "list_terminals" | "read_terminal" | "list_directory" | "read_file" | "unknown";
  host?: string;
  path?: string;
  outcome: "allowed" | "denied" | "timedOut" | "failed";
}

export const listAgentActivity = () => invoke<AgentActivity[]>("agent_activity_list");
export const clearAgentActivity = () => invoke<void>("agent_activity_clear");
