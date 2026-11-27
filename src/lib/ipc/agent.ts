import { invoke } from "@tauri-apps/api/core";

export interface AgentActivity {
  timestamp: number;
  tool: "list_terminals" | "read_terminal" | "list_directory" | "read_file" | "unknown";
  host?: string;
  path?: string;
  outcome: "allowed" | "denied" | "timedOut" | "failed";
}

interface ActivityCursor {
  day: number;
  segment: number;
}

export interface AgentActivityPage {
  records: AgentActivity[];
  nextBefore?: ActivityCursor;
}

export const listAgentActivity = (before?: ActivityCursor) =>
  invoke<AgentActivityPage>("agent_activity_list", { before });
export const clearAgentActivity = () => invoke<void>("agent_activity_clear");
