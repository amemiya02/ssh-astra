import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectErrorPanel } from "@/features/connect/ConnectErrorPanel";
import { ConnectPromptDialog } from "@/features/connect/ConnectPromptDialog";
import { DisconnectedOverlay } from "@/features/connect/DisconnectedOverlay";
import {
  openRemoteTerminal,
  readCommandError,
  refusal,
  type CommandError,
  type ConnectPrompt,
  type PromptAnswer,
} from "@/lib/ipc/connect";
import type { Host } from "@/lib/ipc/hosts";
import { reconnectTerminal, type ConnectionState, type TerminalId } from "@/lib/ipc/terminal";
import type { ConnectionStatus, ReconnectProgress } from "@/features/workspace/tabs";
import { isTerminalColorScheme } from "@/theme/terminal-themes";
import { TerminalSurface, type OpenTerminal } from "./TerminalSurface";

/** The tab dot while a dropped Connection is retried. */
const statusAfterDrop: Record<ConnectionState["state"], ConnectionStatus> = {
  connected: "connected",
  reconnecting: "connecting",
  disconnected: "disconnected",
};

interface PendingPrompt {
  prompt: ConnectPrompt;
  resolve: (answer: PromptAnswer) => void;
}

interface RemoteTerminalViewProps {
  paneId: string;
  host: Host;
  /** Whether its tab is shown. A question asked while hidden waits until the tab is shown. */
  active?: boolean;
  /** Startup restoration can ask sign-in questions before this pane is focused. */
  showPrompts?: boolean;
  onTitleChange?(title: string): void;
  /**
   * Connecting until the shell runs, then connected; disconnected once it ends or the connect fails.
   * After the Connection drops: connecting while it reconnects, disconnected once the tries give up.
   */
  onStatusChange?(status: ConnectionStatus, reconnecting?: ReconnectProgress): void;
  /** Its shell reported its directory (ShellIntegration, or when asked with `reportTerminalCwd`). */
  onCwd?(path: string): void;
  /** Its Terminal opened (`null`: it ended). */
  onTerminal?(id: TerminalId | null): void;
}

/**
 * A Terminal on a saved Host: connects (asking about host keys and the
 * password in a dialog) and then shows the remote shell.
 */
export function RemoteTerminalView({
  paneId,
  host,
  active = true,
  showPrompts = active,
  onTitleChange,
  onStatusChange,
  onCwd,
  onTerminal,
}: RemoteTerminalViewProps) {
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

  // Set while the Connection is down; the Terminal stays mounted under the overlay.
  const [lost, setLost] = useState<Exclude<ConnectionState, { state: "connected" }> | null>(null);
  const terminalId = useRef<TerminalId | null>(null);
  const onStatusChangeRef = useRef(onStatusChange);
  const onCwdRef = useRef(onCwd);
  const onTerminalRef = useRef(onTerminal);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
    onCwdRef.current = onCwd;
    onTerminalRef.current = onTerminal;
  });

  const open = useCallback<OpenTerminal>(
    async (size, onEvent) => {
      const id = await openRemoteTerminal(
        host.id,
        size,
        (event) => {
          if (event.type === "cwd") return onCwdRef.current?.(event.path);
          if (event.type === "exit") onTerminalRef.current?.(null);
          onEvent(event);
          if (event.type !== "connection") return;
          const state = event.state;
          setLost(state.state === "connected" ? null : state);
          onStatusChangeRef.current?.(
            statusAfterDrop[state.state],
            state.state === "reconnecting" ? { attempt: state.attempt, attempts: state.attempts } : undefined,
          );
        },
        (prompt) => new Promise((resolve) => show({ prompt, resolve })),
      );
      terminalId.current = id;
      onTerminalRef.current?.(id);
      return id;
    },
    [host.id, show],
  );
  const reconnect = useCallback(() => {
    if (terminalId.current !== null) void reconnectTerminal(terminalId.current);
  }, []);
  const onOpenError = useCallback(
    (e: unknown) => {
      setError(readCommandError(e));
      onStatusChange?.("disconnected");
    },
    [onStatusChange],
  );

  return (
    <div className="relative h-full">
      {error ? (
        <ConnectErrorPanel error={error} />
      ) : (
        <TerminalSurface
          paneId={paneId}
          open={open}
          onOpenError={onOpenError}
          onOpened={() => onStatusChange?.("connected")}
          onExit={() => {
            setLost(null);
            onStatusChange?.("disconnected");
          }}
          label={host.name}
          active={active}
          colorScheme={isTerminalColorScheme(host.terminalScheme) ? host.terminalScheme : undefined}
          onTitleChange={onTitleChange}
        />
      )}
      {lost && !error && <DisconnectedOverlay state={lost} onReconnect={reconnect} />}
      {pending && (
        <ConnectPromptDialog
          prompt={pending.prompt}
          open={showPrompts}
          onAnswer={(answer) => {
            show(null);
            pending.resolve(answer);
          }}
        />
      )}
    </div>
  );
}
