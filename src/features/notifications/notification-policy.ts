interface NotificationPolicy {
  foreground: boolean;
  enabled: boolean;
  terminal?: { now: number; lastSent?: number };
}

export function shouldSendNotification({ foreground, enabled, terminal }: NotificationPolicy): boolean {
  return !foreground && enabled && (terminal?.lastSent === undefined || terminal.now - terminal.lastSent >= 1000);
}
