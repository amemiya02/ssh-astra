import type { ImportIssue } from "@/lib/ipc/hosts";
import { defineSection } from "@/lib/storage";

type ExportReason = "userAlias" | "duplicateAlias" | "invalidField" | "unsupportedProxy" | "jumpUnavailable"
  | "httpForward" | "manualForward" | "invalidForward";

export const openSshProblems = ["configChanged", "missingInclude", "includeConflict", "fragmentExists", "homeUnavailable", "hostsUnavailable", "io"] as const;

export interface OpenSshReadReport {
  available: string[];
  dependencies: string[];
  updated: string[];
  missing: string[];
  imported: string[];
  awaitingJump: string[];
  issues: ImportIssue[];
  proxyCommands: { host: string; command: string }[];
}

export interface OpenSshStatus {
  enabled: boolean;
  includeLine?: string;
  report?: {
    aliases: string[];
    issues: { host: string; alias: string; reason: ExportReason }[];
  };
  problem?: typeof openSshProblems[number];
  read?: OpenSshReadReport;
  readProblem?: boolean;
  readApproval?: number;
  startupOffer?: boolean;
}

export const openSshSyncSetting = defineSection<OpenSshStatus>("openSshSync", { enabled: false }, (raw) => {
  const status = raw as Partial<OpenSshStatus> | null;
  return { ...status, enabled: status?.enabled === true };
});
