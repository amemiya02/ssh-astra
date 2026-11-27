interface NotificationPolicy {
  foreground: boolean;
  enabled: boolean;
  terminal?: { now: number; lastSent?: number };
  command?: { durationMs: number; thresholdMs: number };
}

export function shouldSendNotification({ foreground, enabled, terminal, command }: NotificationPolicy): boolean {
  return !foreground && enabled
    && (terminal?.lastSent === undefined || terminal.now - terminal.lastSent >= 1000)
    && (!command || command.durationMs > command.thresholdMs);
}
