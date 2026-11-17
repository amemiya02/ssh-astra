import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectErrorPanel } from "@/features/connect/ConnectErrorPanel";
import { ConnectPromptDialog } from "@/features/connect/ConnectPromptDialog";
import {
  openRemoteTerminal,
  readCommandError,
  refusal,
  type CommandError,
  type ConnectPrompt,
  type PromptAnswer,
} from "@/lib/ipc/connect";
import type { Host } from "@/lib/ipc/hosts";
import { TerminalSurface, type OpenTerminal } from "./TerminalSurface";

interface PendingPrompt {
  prompt: ConnectPrompt;
  resolve: (answer: PromptAnswer) => void;
}

/**
 * A Terminal on a saved Host: connects (asking about host keys and the
 * password in place) and then shows the remote shell.
 */
export function RemoteTerminalView({ host }: { host: Host }) {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  const show = useCallback((next: PendingPrompt | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  // Closing the tab mid-connect refuses the open question so the backend stops waiting.
  useEffect(
    () => () => {
      const open = pendingRef.current;
      if (open) open.resolve(refusal(open.prompt));
    },
    [],
  );

  const open = useCallback<OpenTerminal>(
    (size, onEvent) =>
      openRemoteTerminal(host.id, size, onEvent, (prompt) => new Promise((resolve) => show({ prompt, resolve }))),
    [host.id, show],
  );
  const onOpenError = useCallback((e: unknown) => setError(readCommandError(e)), []);

  return (
    <div className="relative h-full">
      {error ? <ConnectErrorPanel error={error} /> : <TerminalSurface open={open} onOpenError={onOpenError} label={host.name} />}
      {pending && (
        <ConnectPromptDialog
          prompt={pending.prompt}
          onAnswer={(answer) => {
            show(null);
            pending.resolve(answer);
          }}
        />
      )}
    </div>
  );
}
