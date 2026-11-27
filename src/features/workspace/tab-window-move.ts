import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as XTerm } from "@xterm/xterm";
import { createStore } from "zustand/vanilla";
import type { TrackedShell } from "@/features/terminal/shellIntegration";
import { terminalOutputs } from "@/features/terminal/terminal-outputs";
import { isTemporaryHost } from "@/lib/ipc/hosts";
import { drainTerminalWrites, type TerminalId, type TerminalSize } from "@/lib/ipc/terminal";
import { cancelTabMove, completeTabMove, openTabMove, prepareTabMove, readIncomingTabMove } from "@/lib/ipc/windows";
import { movedTabLayout, tabPanes, type Tab } from "./tabs";

type TerminalState = {
  cwd?: string;
  local?: { shellProgram: string; wslDistribution: string | null; shellFallback: boolean };
  generation?: number;
  shell?: TrackedShell;
};

interface MovedPane extends TerminalState {
  id: TerminalId;
  grid: TerminalSize;
  screen: string;
  scrollOffset: number;
  log: boolean;
  recording: boolean;
}

interface TabMove {
  tab: Tab;
  panes: Record<string, MovedPane>;
}

export const liveMoveTerminals = createStore<ReadonlyMap<string, {
  id: TerminalId; xterm: XTerm; state(): TerminalState;
}>>(() => new Map());

export function registerMovableTerminal(paneId: string, id: TerminalId, xterm: XTerm, state: () => TerminalState) {
  const entry = { id, xterm, state };
  liveMoveTerminals.setState((panes) => new Map(panes).set(paneId, entry), true);
  return () => {
    const panes = liveMoveTerminals.getState();
    if (panes.get(paneId) !== entry) return;
    const next = new Map(panes);
    next.delete(paneId);
    liveMoveTerminals.setState(next, true);
  };
}

export function canMoveToWindow(tab: Tab, live: ReadonlyMap<string, unknown>): boolean {
  return tabPanes(tab).every((pane) => {
    if (pane.kind === "local-terminal") return live.has(pane.id);
    if (pane.kind === "remote-terminal") {
      return (pane.status === "connected" && live.has(pane.id)) || pane.restoreConnection === "manual";
    }
    return true;
  });
}

interface Fence {
  token: string;
  panes: Map<string, () => void>;
}

let fence: Fence | undefined;

export function receiveMoveFence(paneId: string, token: string) {
  if (fence?.token === token) fence.panes.get(paneId)?.();
}

export function movingSourcePane(paneId: string): boolean {
  return fence?.panes.has(paneId) ?? false;
}

/** Serialization can only reproduce complete UTF-8 characters and control sequences. */
function atParserBoundary(xterm: XTerm): boolean {
  // xterm 6's public parser API has no state accessor. Check before moving so a
  // partially parsed sequence can finish in the original renderer on rollback.
  const { _core } = xterm as unknown as {
    _core: { _inputHandler: {
      _parser: { currentState: number; initialState: number };
      _utf8Decoder: { interim: Uint8Array };
    } };
  };
  const { _parser, _utf8Decoder } = _core._inputHandler;
  return _parser.currentState === _parser.initialState && _utf8Decoder.interim[0] === 0;
}

function renderComplete(xterm: XTerm): Promise<void> {
  return new Promise((resolve) => xterm.write("", resolve));
}

export async function moveTabToNewWindow(tab: Tab): Promise<void> {
  const live = liveMoveTerminals.getState();
  if (fence || !canMoveToWindow(tab, live)) throw new Error("The tab is not ready to move");
  const token = crypto.randomUUID();
  const panes = tabPanes(tab);
  const moving = panes.flatMap((pane) => {
    const terminal = live.get(pane.id);
    return terminal ? [{ paneId: pane.id, ...terminal }] : [];
  });
  const ids = moving.map(({ id }) => id);
  const temporaryHosts = [...new Set(panes.flatMap((pane) =>
    "host" in pane && isTemporaryHost(pane.host) ? [pane.host.id] : []))];
  const preparation: Fence = { token, panes: new Map() };
  fence = preparation;
  const drained = Promise.all(moving.map(async ({ paneId, xterm }) => {
    await new Promise<void>((resolve) => preparation.panes.set(paneId, resolve));
    await renderComplete(xterm);
  }));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await prepareTabMove(token, ids, temporaryHosts);
    await Promise.race([
      drained.then(() => drainTerminalWrites(ids)),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("The Terminal screen did not finish rendering")), 5000);
      }),
    ]);
    clearTimeout(deadline);
    const payload: TabMove = { tab: { ...tab, layout: movedTabLayout(tab.layout) }, panes: Object.fromEntries(moving.map(({ paneId, id, xterm, state }) => {
      if (!atParserBoundary(xterm)) throw new Error("The Terminal is parsing a partial sequence");
      const serializer = new SerializeAddon();
      serializer.activate(xterm);
      const buffer = xterm.buffer.active;
      const output = terminalOutputs.store.getState().get(paneId);
      return [paneId, {
        ...state(),
        id,
        grid: { cols: xterm.cols, rows: xterm.rows },
        screen: serializer.serialize(),
        scrollOffset: buffer.baseY - buffer.viewportY,
        log: output?.log ?? false,
        recording: output?.recording ?? false,
      } satisfies MovedPane];
    })) };
    await openTabMove(token, payload);
  } catch (error) {
    await cancelTabMove(token).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(deadline);
    fence = undefined;
  }
}

let incoming: {
  move: TabMove;
  waiting: Set<string>;
  ready: Promise<void>;
  finish(): void;
} | undefined;

/** The payload is delivered only to the new Window, and exists only during the handoff. */
export async function incomingTabMove(): Promise<{ tab: Tab; ready: Promise<void> } | null> {
  const move = await readIncomingTabMove<TabMove>();
  if (!move) return null;
  const waiting = new Set(Object.keys(move.panes));
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = () => {
      // The native timeout closes a target that cannot adopt its tab.
      void completeTabMove().then(resolve, () => undefined);
    };
  });
  incoming = { move, waiting, ready, finish };
  if (waiting.size === 0) finish();
  void ready.then(() => { incoming = undefined; });
  return { tab: move.tab, ready };
}

export function incomingPane(paneId: string): MovedPane | undefined {
  return incoming?.move.panes[paneId];
}

export function movedTerminalReady(paneId: string): Promise<void> | undefined {
  if (!incoming?.waiting.delete(paneId)) return;
  if (incoming.waiting.size === 0) incoming.finish();
  return incoming.ready;
}

export async function restoreTerminalScreen(xterm: XTerm, moved: MovedPane, signal: AbortSignal): Promise<void> {
  const { cols, rows } = xterm;
  const visible = Boolean(xterm.element?.offsetWidth);
  xterm.options.disableStdin = true;
  xterm.resize(moved.grid.cols, moved.grid.rows);
  await new Promise<void>((resolve) => xterm.write(moved.screen, resolve));
  signal.throwIfAborted();
  if (visible) xterm.resize(cols, rows);
  xterm.scrollToLine(xterm.buffer.active.baseY - moved.scrollOffset);
  xterm.options.disableStdin = false;
}
