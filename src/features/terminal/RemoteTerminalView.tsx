import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { notifySystem } from "@/features/notifications/system-notifications";
import { ConnectionView, type ObservedProgress } from "@/features/connect/ConnectionView";
import { ConnectPromptDialog } from "@/features/connect/ConnectPromptDialog";
import { DisconnectedOverlay } from "@/features/connect/DisconnectedOverlay";
import { fileBrowsers } from "@/features/files/fileBrowsers";
import { terminalCwds } from "@/features/files/terminalCwds";
import { showToast } from "@/features/toasts/toastStore";
import { transfersStore } from "@/features/transfers/transfersStore";
import { useOsFileDrop } from "@/features/transfers/use-os-file-drop";
import { privacyModeSetting, workspaceHostName } from "@/features/workspace/privacy-mode";
import {
  connectPromptChannel,
  openRemoteTerminal,
  readCommandError,
  refusal,
  type CommandError,
  type ConnectPrompt,
  type PromptAnswer,
} from "@/lib/ipc/connect";
import { remoteHomeDirectory } from "@/lib/ipc/files";
import { isTemporaryHost, type Host } from "@/lib/ipc/hosts";
import type { SshLinkTarget } from "@/lib/ipc/ssh-links";
import { reconnectTerminal, setTerminalTitle, type ConnectionState, type TerminalId } from "@/lib/ipc/terminal";
import { transferHost } from "@/lib/ipc/transfers";
import { useSetting } from "@/lib/storage";
import type { ConnectionStatus, ReconnectProgress } from "@/features/workspace/tabs";
import { incomingPane } from "@/features/workspace/tab-window-move";
import { stageMovedTerminal } from "@/lib/ipc/windows";
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
  expectedTarget?: SshLinkTarget;
  savedHostTerminal?: boolean;
  /** Whether this is the focused pane of the shown tab. */
  active?: boolean;
  /** Non-focused splits in the shown tab can also receive dropped files. */
  visible?: boolean;
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
  onTerminal?(id: TerminalId | null, savedHost: boolean): void;
}

/**
 * A remote Terminal: connects (asking about host keys and the
 * password in a dialog) and then shows the remote shell.
 */
export function RemoteTerminalView({
  paneId,
  host,
  initialCwd,
  expectedTarget,
  savedHostTerminal,
  active = true,
  visible = active,
  onEditHost,
  onClose,
  showPrompts = active,
  onTitleChange,
  onStatusChange,
  onCwd,
  onTerminal,
}: RemoteTerminalViewProps) {
  const { t } = useTranslation();
  const [privacyMode] = useSetting(privacyModeSetting);
  const temporary = isTemporaryHost(host);
  const displayHost = { id: host.id, name: workspaceHostName(host, t, privacyMode) };
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [opened, setOpened] = useState(false);
  const [connected, setConnected] = useState(false);
  const [steps, setSteps] = useState<ObservedProgress[]>([]);
  const [dropQuestion, setDropQuestion] = useState<{ paths: string[]; panelPath: string | null } | null>(null);

  // Set while the Connection is down; the Terminal stays mounted under the overlay.
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const terminalId = useRef<TerminalId | null>(null);
  const onSavedHost = useRef(false);
  const shellTitle = useRef("");
  const dropTarget = useRef<HTMLDivElement>(null);
  const upload = async (paths: string[], directory: string | null) => {
    try {
      const path = directory ?? await remoteHomeDirectory(host.id);
      await transfersStore.getState().upload(transferHost(host), paths, path);
    } catch {
      showToast((t) => t("terminal.fileDrop.uploadFailed", { host: displayHost.name }), "error");
    }
  };
  const drop = useOsFileDrop(dropTarget, visible && connected, (paths) => {
    const path = terminalCwds.lastReported(paneId);
    if (path !== undefined) void upload(paths, path);
    else setDropQuestion({ paths, panelPath: fileBrowsers.find(paneId)?.getState().path ?? null });
  });
  const chooseDropDirectory = (directory: string | null) => {
    if (dropQuestion === null) return;
    setDropQuestion(null);
    void upload(dropQuestion.paths, directory);
  };
  const displayNameRef = useRef(displayHost.name);
  const onStatusChangeRef = useRef(onStatusChange);
  const onCwdRef = useRef(onCwd);
  const onTerminalRef = useRef(onTerminal);
  useEffect(() => {
    displayNameRef.current = displayHost.name;
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
      const handleEvent: Parameters<OpenTerminal>[1] = (event) => {
        if (signal.aborted) return;
        if (event.type === "cwd") onCwdRef.current?.(event.path);
        if (event.type === "exit") exited = true;
        onEvent(event);
        if (event.type !== "connection") return;
        const state = event.state;
        setConnected(state.state === "connected");
        if (state.state !== "connected") {
          terminalCwds.resetReport(paneId);
          setDropQuestion(null);
        }
        if (state.state === "disconnected" && state.reportReconnectFailure) {
          notifySystem({ category: "reconnect" }, (t) => ({
            title: t("notifications.reconnect.title"),
            body: t("notifications.reconnect.body", { host: displayNameRef.current }),
          }));
        }
        onStatusChangeRef.current?.(
          statusAfterDrop[state.state],
          state.state === "reconnecting" ? { attempt: state.attempt, attempts: state.attempts } : undefined,
        );
      };
      const ask = (prompt: ConnectPrompt) => new Promise<PromptAnswer>((resolve) => {
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
      });
      const updates: Parameters<typeof connectPromptChannel>[1] = {
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
      };
      const moved = incomingPane(paneId);
      if (moved) {
        await stageMovedTerminal(moved.id, handleEvent, connectPromptChannel(ask, updates));
        opening = false;
        onSavedHost.current = savedHostTerminal === true;
        return moved.id;
      }
      const registered = await openRemoteTerminal(
        host.id, size, handleEvent, ask, updates, initialCwd, expectedTarget,
      ).finally(() => {
        opening = false;
      });
      onSavedHost.current = registered.savedHost;
      return registered.id;
    },
    [host.id, initialCwd, expectedTarget, paneId, savedHostTerminal],
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
    <div ref={dropTarget} className="relative h-full">
      {!error && (
        // Keep the measured grid and its buffered output ready for the shell.
        <div className={opened ? "h-full" : "invisible h-full"} inert={!opened}>
          <TerminalSurface
            paneId={paneId}
            host={transferHost(host)}
            open={open}
            onOpenError={onOpenError}
            onOpened={(id) => {
              terminalId.current = id;
              onTerminalRef.current?.(id, onSavedHost.current);
              if (onSavedHost.current && shellTitle.current) {
                void setTerminalTitle(id, shellTitle.current).catch(() => undefined);
              }
              setOpened(true);
              setConnected(true);
              onStatusChange?.("connected");
            }}
            onExit={() => {
              terminalId.current = null;
              setOpened(true);
              setConnected(false);
              terminalCwds.resetReport(paneId);
              setDropQuestion(null);
              onTerminalRef.current?.(null, false);
              setRecovery(null);
              onStatusChange?.("disconnected");
            }}
            label={displayHost.name}
            active={active && opened}
            colorScheme={host.terminalScheme}
            historyHostId={temporary ? undefined : host.id}
            onTitleChange={(title) => {
              const updated = shellTitle.current !== title;
              shellTitle.current = title;
              if (updated && onSavedHost.current && terminalId.current !== null) {
                void setTerminalTitle(terminalId.current, title).catch(() => undefined);
              }
              onTitleChange?.(title);
            }}
          />
        </div>
      )}
      {!opened && (
        <ConnectionView host={displayHost} steps={steps} error={error} onRetry={retry} onEditHost={temporary ? undefined : onEditHost} onClose={onClose} />
      )}
      {opened && recovery && (
        <DisconnectedOverlay host={displayHost} state={recovery.state} steps={recovery.steps} onReconnect={reconnect} />
      )}
      {drop.over && <span aria-hidden className="ring-primary pointer-events-none absolute inset-1 z-10 rounded-md ring-2 ring-inset" />}
      <Dialog open={visible && connected && dropQuestion !== null} onOpenChange={(open) => !open && setDropQuestion(null)}>
        {dropQuestion !== null && (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{t("terminal.fileDrop.destinationTitle")}</DialogTitle>
              <DialogDescription>{t("terminal.fileDrop.destinationBody", { host: displayHost.name })}</DialogDescription>
            </DialogHeader>
            {dropQuestion.panelPath !== null && (
              <p className="bg-muted rounded-md border px-3 py-2 font-mono text-xs break-all">{dropQuestion.panelPath}</p>
            )}
            <DialogFooter>
              <Button variant="outline" autoFocus onClick={() => setDropQuestion(null)}>{t("terminal.fileDrop.cancel")}</Button>
              <Button variant="outline" disabled={dropQuestion.panelPath === null}
                onClick={() => chooseDropDirectory(dropQuestion.panelPath)}>{t("terminal.fileDrop.filePanel")}</Button>
              <Button onClick={() => chooseDropDirectory(null)}>{t("terminal.fileDrop.home")}</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
      {pending && (
        <ConnectPromptDialog
          prompt={pending.prompt}
          open={showPrompts}
          hideCredentialSaving={temporary}
          onAnswer={(answer) => {
            setPending(null);
            pending.resolve(answer);
          }}
        />
      )}
    </div>
  );
}
