import { terminalSetting } from "@/features/terminal/terminal-prefs";
import { reportTerminalCwd, type TerminalId } from "@/lib/ipc/terminal";
import { getSetting } from "@/lib/storage";
import { fileBrowsers, type FileBrowsers } from "./fileBrowsers";

/**
 * The directory each remote Terminal pane's shell is in, driving its File panel: the panel
 * follows `cd` (ShellIntegration reports), and the "sync" button brings it back, asking the
 * shell when it does not report by itself.
 */
export interface TerminalCwds {
  /** The pane's Terminal opened, or ended (`null`). */
  attach(paneId: string, terminal: TerminalId | null): void;
  /** The pane's shell reported its directory. */
  report(paneId: string, path: string): void;
  /** The latest directory reported by this pane's shell, if any. */
  lastReported(paneId: string): string | undefined;
  /** Takes the pane's File panel to its shell's directory. */
  sync(paneId: string): void;
  /** Forgets the panes not in `paneIds`. */
  retain(paneIds: ReadonlySet<string>): void;
}

interface PaneCwd {
  terminal: TerminalId | null;
  /** The last directory reported. */
  path: string | null;
  /** Reports arrived unasked: the shell has the hook, so `path` is current. */
  reporting: boolean;
  /** `sync` asked the shell; its next report moves the panel even if unchanged. */
  asked: boolean;
}

/**
 * `following` says whether panels follow `cd` on their own (Shell integration is on); checked on
 * every report, so turning it off stops open Terminals' panels at once. `sync` works either way.
 */
export function createTerminalCwds(
  browsers: Pick<FileBrowsers, "find">,
  askShell: (terminal: TerminalId) => Promise<void>,
  following: () => boolean = () => true,
): TerminalCwds {
  const panes = new Map<string, PaneCwd>();
  const pane = (paneId: string) => {
    let state = panes.get(paneId);
    if (!state) {
      state = { terminal: null, path: null, reporting: false, asked: false };
      panes.set(paneId, state);
    }
    return state;
  };
  const show = (paneId: string, path: string) => void browsers.find(paneId)?.getState().navigate(path, "terminal");

  return {
    attach(paneId, terminal) {
      pane(paneId).terminal = terminal;
    },
    report(paneId, path) {
      const state = pane(paneId);
      const changed = path !== state.path;
      state.path = path;
      const asked = state.asked;
      state.asked = false;
      if (!asked) state.reporting = true;
      if (asked || (changed && following())) show(paneId, path);
    },
    lastReported(paneId) {
      return panes.get(paneId)?.path ?? undefined;
    },
    sync(paneId) {
      const state = pane(paneId);
      if (state.reporting && state.path !== null) return show(paneId, state.path);
      if (state.terminal === null) return;
      state.asked = true;
      askShell(state.terminal).catch(() => {
        state.asked = false;
      });
    },
    retain(paneIds) {
      for (const paneId of panes.keys()) if (!paneIds.has(paneId)) panes.delete(paneId);
    },
  };
}

/** The app's Terminal directories, driving `fileBrowsers`. */
export const terminalCwds = createTerminalCwds(
  fileBrowsers,
  reportTerminalCwd,
  () => getSetting(terminalSetting).shellIntegration,
);
