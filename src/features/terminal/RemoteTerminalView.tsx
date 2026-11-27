import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionView, type ObservedProgress } from "@/features/connect/ConnectionView";
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
import { TerminalSurface, type OpenTerminal } from "./TerminalSurface";

/** The tab dot while a dropped Connection is retried. */
const statusAfterDrop: Record<ConnectionState["state"], ConnectionStatus> = {
  connected: "connected",
  reconnecting: "connecting",
  disconnected: "disconnected",
};

/** One entry per Host and step, keeping the order in which the route was reported. */
function updateConnectionSteps(previous: ObservedProgress[], progress: ObservedProgress): ObservedProgress[] {
  const index = previous.findIndex((step) => step.hostId === progress.hostId && step.stage === progress.stage);
  if (index < 0) return [...previous, progress];
  return previous.map((step, i) => i === index ? progress : step);
}

interface PendingPrompt {
  prompt: ConnectPrompt;
  resolve: (answer: PromptAnswer) => void;
}

interface Recovery {
  state: Exclude<ConnectionState, { state: "connected" }>;
  steps: ObservedProgress[];
}

interface RemoteTerminalViewProps {
  paneId: string;
  host: Host;
  initialCwd?: string;
  /** Whether its tab is shown. A question asked while hidden waits until the tab is shown. */
  active?: boolean;
  onEditHost(): void;
  onClose(): void;
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
  initialCwd,
  active = true,
  onEditHost,
  onClose,
  showPrompts = active,
  onTitleChange,
  onStatusChange,
  onCwd,
  onTerminal,
}: RemoteTerminalViewProps) {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [opened, setOpened] = useState(false);
  const [steps, setSteps] = useState<ObservedProgress[]>([]);

  // Set while the Connection is down; the Terminal stays mounted under the overlay.
  const [recovery, setRecovery] = useState<Recovery | null>(null);
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
    async (size, onEvent, signal) => {
      // Strict Mode detaches the first development mount before it can open a shell.
      await Promise.resolve();
      signal.throwIfAborted();
      let opening = true;
      let exited = false;
      return openRemoteTerminal(
        host.id,
        size,
        (event) => {
          if (signal.aborted) return;
          if (event.type === "cwd") return onCwdRef.current?.(event.path);
          if (event.type === "exit") exited = true;
          onEvent(event);
          if (event.type !== "connection") return;
          const state = event.state;
          onStatusChangeRef.current?.(
            statusAfterDrop[state.state],
            state.state === "reconnecting" ? { attempt: state.attempt, attempts: state.attempts } : undefined,
          );
        },
        (prompt) => new Promise((resolve) => {
          if (signal.aborted) {
            resolve(refusal(prompt));
            return;
          }
          const cancel = () => {
            setPending((current) => current?.prompt.id === prompt.id ? null : current);
            resolve(refusal(prompt));
          };
          signal.addEventListener("abort", cancel, { once: true });
          setPending({
            prompt,
            resolve: (answer) => {
              signal.removeEventListener("abort", cancel);
              resolve(answer);
            },
          });
        }),
        {
          onProgress(progress) {
            if (signal.aborted || exited) return;
            const observed = { ...progress, receivedAt: performance.now() };
            if (opening) setSteps((previous) => updateConnectionSteps(previous, observed));
            else setRecovery((current) => current?.state.state === "reconnecting"
              ? { ...current, steps: updateConnectionSteps(current.steps, observed) }
              : current);
          },
          onReconnect(state) {
            if (signal.aborted || exited) return;
            opening = false;
            setRecovery((current) => {
              if (state.state === "connected") return null;
              return { state, steps: state.state === "reconnecting" ? [] : current?.steps ?? [] };
            });
          },
        },
        initialCwd,
      ).finally(() => {
        opening = false;
      });
    },
    [host.id, initialCwd],
  );
  const reconnect = useCallback(() => {
    if (terminalId.current !== null) void reconnectTerminal(terminalId.current);
  }, []);
  const onOpenError = useCallback(
    (e: unknown) => {
      setError(readCommandError(e));
      setSteps((previous) => previous.map((step) => step.status === "running"
        ? { ...step, status: "failed", elapsedMs: step.elapsedMs + Math.max(0, performance.now() - step.receivedAt) }
        : step));
      onStatusChange?.("disconnected");
    },
    [onStatusChange],
  );

  const retry = () => {
    setSteps([]);
    setError(null);
    onStatusChange?.("connecting");
  };

  return (
    <div className="relative h-full">
      {!error && (
        // Keep the measured grid and its buffered output ready for the shell.
        <div className={opened ? "h-full" : "invisible h-full"} inert={!opened}>
          <TerminalSurface
            paneId={paneId}
            open={open}
            onOpenError={onOpenError}
            onOpened={(id) => {
              terminalId.current = id;
              onTerminalRef.current?.(id);
              setOpened(true);
              onStatusChange?.("connected");
            }}
            onExit={() => {
              terminalId.current = null;
              setOpened(true);
              onTerminalRef.current?.(null);
              setRecovery(null);
              onStatusChange?.("disconnected");
            }}
            label={host.name}
            active={active && opened}
            colorScheme={host.terminalScheme}
            onTitleChange={onTitleChange}
          />
        </div>
      )}
      {!opened && (
        <ConnectionView host={host} steps={steps} error={error} onRetry={retry} onEditHost={onEditHost} onClose={onClose} />
      )}
      {opened && recovery && (
        <DisconnectedOverlay host={host} state={recovery.state} steps={recovery.steps} onReconnect={reconnect} />
      )}
      {pending && (
        <ConnectPromptDialog
          prompt={pending.prompt}
          open={showPrompts}
          onAnswer={(answer) => {
            setPending(null);
            pending.resolve(answer);
          }}
        />
      )}
    </div>
  );
}
