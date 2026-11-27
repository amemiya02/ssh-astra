import { invoke } from "@tauri-apps/api/core";
import type { TerminalId } from "./terminal";

interface ReviewTarget {
  id: number;
  terminalId: TerminalId;
  host: string;
}

export type AgentReviewRequest = ReviewTarget & (
  | { kind: "command"; promptId: number; command: string }
  | { kind: "fileWrite"; path: string; byteLength: number }
);

export type AgentReviewChoice = "copy" | "approve" | "reject" | "unavailable";
export type AgentReviewOutcome = "copied" | "written" | "rejected" | "unavailable" | "timedOut" | "clipboardUnavailable" | "writeFailed";

export function answerAgentReview(id: number, choice: AgentReviewChoice): Promise<AgentReviewOutcome> {
  return invoke("terminal_agent_review_answer", { id, choice });
}
