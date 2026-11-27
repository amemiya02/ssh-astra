import { invoke } from "@tauri-apps/api/core";
import { writeClipboardText } from "./system";

type OperationalEvent =
  | { kind: "frontendError"; line: number; column: number }
  | { kind: "unhandledRejection" }
  | { kind: "updateCheck"; result: "available" | "upToDate" | "noRelease" | "failed" };

/** Send only event types and safe metadata. Messages and stacks can contain user data. */
export function recordOperationalEvent(event: OperationalEvent): void {
  void invoke("diagnostics_event", { event }).catch(() => {});
}

export function watchFrontendErrors(): void {
  window.addEventListener("error", (event) => {
    if (event instanceof ErrorEvent) {
      recordOperationalEvent({ kind: "frontendError", line: event.lineno, column: event.colno });
    }
  });
  window.addEventListener("unhandledrejection", () => {
    recordOperationalEvent({ kind: "unhandledRejection" });
  });
}

export function openLogsDirectory(): Promise<void> {
  return invoke("diagnostics_open_logs");
}

export async function copyDiagnostics(): Promise<void> {
  await writeClipboardText(await invoke<string>("diagnostics_report"));
}
