import { PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useGroupRef, usePanelRef } from "react-resizable-panels";
import { IconButton } from "@/components/IconButton";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { FilePanelDockContext } from "./file-panel-dock";
import { isPanelCollapsed, type FilePanelDock } from "./shell-layout";
import { StatusBar } from "./StatusBar";
import { useShellLayout } from "./use-shell-layout";

export interface AppShellProps {
  /** Left column: the Host list (search, Groups, Hosts) and its actions. */
  sidebar: ReactNode;
  /** The tab strip's tabs (role="tablist"); the shell adds its own toggles around them. */
  tabs: ReactNode;
  /** The tab panels for the active tab, painted on the Terminal surface. */
  workspace: ReactNode;
  /**
   * Content of the File panel dock (right or bottom of the workspace, collapsible).
   * It can read the dock and collapse itself with `useFilePanelDock()`.
   */
  filePanel: ReactNode;
  /** Items on the left of the status bar (Connections, Port forwards, transfers). */
  status?: ReactNode;
  /** Opens the Settings tab (status bar button). */
  onOpenSettings(): void;
}

const shellGroup = "shell";
const workspaceGroup = (dock: FilePanelDock) => `workspace-${dock}`;
/** File panel size for a dock with no saved size; it keeps its pixel size when the window resizes. */
const defaultFilesSize: Record<FilePanelDock, string> = { right: "340px", bottom: "260px" };

/**
 * The main window: Host list | (tab strip / Terminal workspace + File panel dock) | status bar.
 * Panel sizes, collapsed panels and the dock position persist across restarts.
 */
export function AppShell({ sidebar, tabs, workspace, filePanel, status, onOpenSettings }: AppShellProps) {
  const { t } = useTranslation();
  const { layout, saveGroup, setDock } = useShellLayout();
  const { dock } = layout;

  const sidebarRef = usePanelRef();
  const filesRef = usePanelRef();
  const workspaceRef = useGroupRef();

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    isPanelCollapsed(layout.groups[shellGroup], "sidebar"),
  );
  const [filesCollapsed, setFilesCollapsed] = useState(() =>
    isPanelCollapsed(layout.groups[workspaceGroup(dock)], "files"),
  );

  // Switching docks keeps the same panels (so Terminals stay alive) and restores that dock's sizes.
  const firstDock = useRef(dock);
  useEffect(() => {
    if (firstDock.current === dock) return;
    firstDock.current = dock;
    const saved = layout.groups[workspaceGroup(dock)];
    if (saved) workspaceRef.current?.setLayout(saved);
    else filesRef.current?.resize(defaultFilesSize[dock]);
    setFilesCollapsed(isPanelCollapsed(saved, "files"));
    // Only a dock change should restore sizes; later saves of the same dock must not re-apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock]);

  const filePanelDock = useMemo(
    () => ({ dock, collapse: () => filesRef.current?.collapse() }),
    [dock, filesRef],
  );

  /**
   * After a restart a collapsed panel has no "previous size" to expand back to and opens at its
   * minimum; `fallback` gives it a comfortable size instead.
   */
  const toggle = (ref: typeof sidebarRef, collapsed: boolean, fallback?: string) => {
    const panel = ref.current;
    if (!panel) return;
    if (!collapsed) {
      panel.collapse();
      return;
    }
    panel.expand();
    if (fallback && panel.getSize().inPixels < parseFloat(fallback)) panel.resize(fallback);
  };

  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">{t("app.name")}</h1>
      <ResizablePanelGroup
        id={shellGroup}
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={layout.groups[shellGroup]}
        onLayoutChange={(next) => setSidebarCollapsed(isPanelCollapsed(next, "sidebar"))}
        onLayoutChanged={(next, meta) => saveGroup(shellGroup, meta.requestedLayout ?? next)}
      >
        <ResizablePanel
          id="sidebar"
          panelRef={sidebarRef}
          defaultSize="248px"
          minSize="200px"
          maxSize="40%"
          collapsible
          groupResizeBehavior="preserve-pixel-size"
        >
          <aside aria-label={t("hosts.title")} className="flex h-full min-w-0 flex-col">
            {sidebar}
          </aside>
        </ResizablePanel>
        <PanelGutter />
        <ResizablePanel id="main" minSize="320px">
          <div className="flex h-full min-w-0 flex-col pr-1.5">
            <div className="flex h-9.5 shrink-0 items-end gap-1">
              <IconButton
                label={sidebarCollapsed ? t("shell.showSidebar") : t("shell.hideSidebar")}
                className="mb-1.5 self-end"
                onClick={() => toggle(sidebarRef, sidebarCollapsed, "248px")}
              >
                <PanelLeft />
              </IconButton>
              <div className="flex min-w-0 flex-1 items-end">{tabs}</div>
              <div className="mb-1.5 flex items-center gap-0.5" role="group" aria-label={t("files.dockGroup")}>
                <DockButton current={dock} dock="bottom" collapsed={filesCollapsed} onSelect={selectDock} />
                <DockButton current={dock} dock="right" collapsed={filesCollapsed} onSelect={selectDock} />
              </div>
            </div>
            <ResizablePanelGroup
              id="workspace"
              groupRef={workspaceRef}
              orientation={dock === "right" ? "horizontal" : "vertical"}
              className="min-h-0 flex-1 pb-1.5"
              defaultLayout={layout.groups[workspaceGroup(dock)]}
              onLayoutChange={(next) => setFilesCollapsed(isPanelCollapsed(next, "files"))}
              onLayoutChanged={(next, meta) => saveGroup(workspaceGroup(dock), meta.requestedLayout ?? next)}
            >
              <ResizablePanel id="terminal" minSize="200px">
                <section
                  aria-label={t("shell.workspace")}
                  className="bg-terminal-background text-terminal-foreground shadow-panel relative h-full overflow-hidden rounded-lg border"
                >
                  {workspace}
                </section>
              </ResizablePanel>
              <PanelGutter />
              <ResizablePanel
                id="files"
                panelRef={filesRef}
                defaultSize={defaultFilesSize[dock]}
                minSize={dock === "right" ? "240px" : "140px"}
                groupResizeBehavior="preserve-pixel-size"
                collapsible
              >
                <section
                  aria-label={t("files.title")}
                  className="bg-surface shadow-panel flex h-full flex-col overflow-hidden rounded-lg border"
                >
                  <FilePanelDockContext value={filePanelDock}>{filePanel}</FilePanelDockContext>
                </section>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <StatusBar onOpenSettings={onOpenSettings}>{status}</StatusBar>
    </div>
  );

  function selectDock(next: FilePanelDock) {
    if (next === dock) {
      toggle(filesRef, filesCollapsed, defaultFilesSize[dock]);
      return;
    }
    setDock(next);
  }
}

/** Dock buttons double as the File panel toggle: clicking the current dock shows or hides it. */
function DockButton({
  current,
  dock,
  collapsed,
  onSelect,
}: {
  current: FilePanelDock;
  dock: FilePanelDock;
  collapsed: boolean;
  onSelect(dock: FilePanelDock): void;
}) {
  const { t } = useTranslation();
  const active = current === dock && !collapsed;
  const label =
    current === dock
      ? collapsed
        ? t("files.show")
        : t("files.hide")
      : dock === "right"
        ? t("files.dockRight")
        : t("files.dockBottom");
  return (
    <IconButton
      label={label}
      className={cn(active && "bg-accent text-foreground")}
      onClick={() => onSelect(dock)}
    >
      {dock === "right" ? <PanelRight /> : <PanelBottom />}
    </IconButton>
  );
}

/** The 6px gap between panels doubles as the resize handle; a short grip appears on hover and focus. */
function PanelGutter() {
  return (
    <ResizableHandle className="group/gutter w-1.5 bg-transparent after:w-1.5 focus-visible:ring-0 aria-[orientation=horizontal]:h-1.5 aria-[orientation=horizontal]:after:h-1.5">
      <span
        aria-hidden
        className="bg-border group-hover/gutter:bg-muted-foreground/40 group-focus-visible/gutter:bg-ring group-data-[separator=active]/gutter:bg-ring h-7 w-0.5 rounded-full transition-colors group-aria-[orientation=horizontal]/gutter:h-0.5 group-aria-[orientation=horizontal]/gutter:w-7"
      />
    </ResizableHandle>
  );
}
