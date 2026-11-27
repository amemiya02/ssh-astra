import { invoke } from "@tauri-apps/api/core";
import type { TerminalId } from "./terminal";

export interface AgentReviewRequest {
  id: number;
  terminalId: TerminalId;
  host: string;
  promptId: number;
  command: string;
}

export type AgentReviewChoice = "copy" | "reject" | "unavailable";
export type AgentReviewOutcome = "copied" | "rejected" | "unavailable" | "timedOut" | "clipboardUnavailable";

export function answerAgentReview(id: number, choice: AgentReviewChoice): Promise<AgentReviewOutcome | null> {
  return invoke("terminal_agent_review_answer", { id, choice });
}
