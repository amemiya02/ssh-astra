import { isTauri } from "@tauri-apps/api/core";
import { PanelBottom, PanelRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useGroupRef, usePanelRef } from "react-resizable-panels";
import { IconButton } from "@/components/IconButton";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { usePaletteActions, type PaletteAction } from "@/features/palette/palette-actions";
import { currentPlatform } from "@/features/workspace/shortcuts";
import { compactTabStripWidth, workspaceSetting } from "@/features/workspace/workspace-prefs";
import { getSetting, setSetting, useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { FilePanelDockContext } from "./file-panel-dock";
import { NavRail, type NavRailProps } from "./NavRail";
import { isPanelCollapsed, type FilePanelDock, type SidebarView } from "./shell-layout";
import { StatusBar, type StatusInfo } from "./StatusBar";
import { TabStripGutter, verticalTabsMinMainWidth } from "./TabStripGutter";
import { useShellLayout } from "./use-shell-layout";

export interface AppShellProps {
  /** The sidebar column's views; the nav rail picks which one shows. All stay mounted. */
  sidebar: Record<SidebarView, ReactNode>;
  /** The nav rail's destinations (the shell owns the sidebar view toggles). */
  nav: Omit<NavRailProps, "sidebarView" | "sidebarOpen" | "onSidebarView">;
  /** The tab strip (tabs, new tab, split buttons); the shell adds the dock buttons beside it. */
  tabs: ReactNode;
  /** The tab panels for the active tab, painted on the Terminal surface. */
  workspace: ReactNode;
  /**
   * Content of the File panel dock (right or bottom of the workspace, collapsible).
   * It can read the dock and collapse itself with `useFilePanelDock()`.
   */
  filePanel: ReactNode;
  /** The standalone SFTP tab fills the workspace. */
  fullWorkspace?: boolean;
  /** What the status bar reports. */
  status?: StatusInfo;
}

const shellGroup = "shell";
const workspaceGroup = (dock: FilePanelDock) => `workspace-${dock}`;
/** File panel size for a dock with no saved size; it keeps its pixel size when the window resizes. */
const defaultFilesSize: Record<FilePanelDock, string> = { right: "340px", bottom: "260px" };

/** macOS draws the traffic lights over the window (`titleBarStyle: "Overlay"`); only the app has that title bar. */
const overlayTitleBar = isTauri() && currentPlatform() === "mac";
/** The native traffic lights are 78px wide even when the 48px rail scales with interface zoom. */
const trafficLightInset = "max(0px, calc(78px / var(--interface-scale) - 48px))";
const sidebarSize = "248px";

/**
 * The main window: nav rail | sidebar view | (tab strip / Terminal workspace + File panel dock), over a status bar.
 * Panel sizes, collapsed panels and the dock position persist across restarts.
 */
export function AppShell({ sidebar, nav, tabs, workspace, filePanel, fullWorkspace, status }: AppShellProps) {
  const { t } = useTranslation();
  const { layout, saveGroup, setDock, setSidebarView } = useShellLayout();
  const { dock, sidebarView } = layout;
  const [{ tabOrientation, verticalTabWidth, verticalTabsCompact }] = useSetting(workspaceSetting);
  const verticalTabs = tabOrientation === "vertical";
  const resizableTabs = verticalTabs && !verticalTabsCompact;
  const [previewTabWidth, setPreviewTabWidth] = useState<number | null>(null);
  if (!resizableTabs && previewTabWidth !== null) setPreviewTabWidth(null);
  const tabWidth = verticalTabsCompact ? compactTabStripWidth : previewTabWidth ?? verticalTabWidth;
  function saveTabWidth(width: number) {
    const prefs = getSetting(workspaceSetting);
    if (prefs.verticalTabWidth !== width) setSetting(workspaceSetting, { ...prefs, verticalTabWidth: width });
  }

  const sidebarRef = usePanelRef();
  const filesRef = usePanelRef();
  const workspaceRef = useGroupRef();

  // On Home the Host list repeats Home's own cards, so the column is closed while Home is the
  // focused tab and the sidebar shows Hosts. That is a display rule, not the user's collapse: it
  // saves nothing, and leaving Home reopens the column as it was. `autoHidden` says the rule
  // closed it; `peek` is the Hosts rail button opening it for this visit.
  const [peek, setPeek] = useState(false);
  const homeHosts = nav.activeKind === "home" && sidebarView === "hosts";
  if (peek && !homeHosts) setPeek(false);
  const hideList = homeHosts && !peek;
  // Opened on Home, the column starts closed (no flash of it) unless the user had it closed.
  const [startsHidden] = useState(() => hideList && !isPanelCollapsed(layout.groups[shellGroup], "sidebar"));
  const autoHidden = useRef(startsHidden);
  const [shellLayout] = useState(() =>
    startsHidden ? { ...layout.groups[shellGroup], sidebar: 0, main: 100 } : layout.groups[shellGroup],
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => hideList || isPanelCollapsed(layout.groups[shellGroup], "sidebar"),
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
    () => ({ dock, collapsed: filesCollapsed, collapse: () => filesRef.current?.collapse() }),
    [dock, filesCollapsed, filesRef],
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

  // The palette runs the latest toggle without re-registering on every render.
  const toggleFilesRef = useRef(() => {});
  useEffect(() => {
    toggleFilesRef.current = () => toggle(filesRef, filesCollapsed, defaultFilesSize[dock]);
  });
  usePaletteActions(
    useMemo(
      (): PaletteAction[] => fullWorkspace ? [] : [
        {
          id: "files.togglePanel",
          title: filesCollapsed ? t("files.show") : t("files.hide"),
          run: () => toggleFilesRef.current(),
        },
      ],
      [filesCollapsed, fullWorkspace, t],
    ),
  );

  // The display rule closes and reopens the column; the effect only reacts to the rule changing.
  useEffect(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    if (hideList) {
      if (!panel.isCollapsed()) {
        autoHidden.current = true;
        panel.collapse();
      }
    } else if (autoHidden.current) {
      autoHidden.current = false;
      toggle(sidebarRef, true, sidebarSize);
    }
    // `toggle` only reads refs and its arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hideList]);

  /** Shows `view` in the sidebar, opening the column if it is collapsed. */
  const showSidebarView = (view: SidebarView) => {
    setSidebarView(view);
    if (!sidebarCollapsed) return;
    if (autoHidden.current && view === "hosts") setPeek(true);
    autoHidden.current = false;
    toggle(sidebarRef, true, sidebarSize);
  };
  /**
   * The rail's behaviour: the open view's button collapses the column, any other shows its view.
   * On Home the Hosts button only opens and closes the column for this visit.
   */
  const pickSidebarView = (view: SidebarView) => {
    if (sidebarCollapsed || sidebarView !== view) showSidebarView(view);
    else if (peek) setPeek(false);
    else toggle(sidebarRef, false);
  };
  const showSidebarViewRef = useRef(showSidebarView);
  useEffect(() => {
    showSidebarViewRef.current = showSidebarView;
  });
  usePaletteActions(
    useMemo(
      (): PaletteAction[] => [
        { id: "shell.showHosts", title: t("shell.showHosts"), run: () => showSidebarViewRef.current("hosts") },
        { id: "shell.showForwards", title: t("shell.showForwards"), run: () => showSidebarViewRef.current("forwards") },
      ],
      [t],
    ),
  );

  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">{t("app.name")}</h1>
      <div className="flex min-h-0 flex-1">
        <NavRail
          {...nav}
          sidebarView={sidebarView}
          sidebarOpen={!sidebarCollapsed}
          onSidebarView={pickSidebarView}
        />
        <ResizablePanelGroup
          id={shellGroup}
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={shellLayout}
          onLayoutChange={(next) => setSidebarCollapsed(isPanelCollapsed(next, "sidebar"))}
          onLayoutChanged={(next, meta) => {
            if (!autoHidden.current) saveGroup(shellGroup, meta.requestedLayout ?? next);
          }}
        >
          <ResizablePanel
            id="sidebar"
            panelRef={sidebarRef}
            defaultSize={sidebarSize}
            minSize="200px"
            maxSize="40%"
            collapsible
            groupResizeBehavior="preserve-pixel-size"
          >
            <aside
              aria-label={t("shell.sidebar")}
              className="bg-sidebar h-full min-w-0"
              style={{ "--chrome-inset": overlayTitleBar ? trafficLightInset : "0px" } as CSSProperties}
            >
              {(Object.keys(sidebar) as SidebarView[]).map((view) => (
                <div key={view} hidden={view !== sidebarView} className="h-full min-w-0">
                  {sidebar[view]}
                </div>
              ))}
            </aside>
          </ResizablePanel>
          <ResizableHandle className="focus-visible:ring-0" />
          <ResizablePanel id="main" minSize={resizableTabs ? `${verticalTabsMinMainWidth + 12}px` : "320px"}>
            <div
              className="relative grid h-full min-w-0 grid-cols-[var(--tab-column)_minmax(0,1fr)_auto] grid-rows-[34px_minmax(0,1fr)] px-1.5"
              style={{
                "--chrome-inset": overlayTitleBar && sidebarCollapsed ? trafficLightInset : "0px",
                "--tab-column": verticalTabs
                  ? `min(${tabWidth + 6}px, max(${compactTabStripWidth + 6}px, calc(100% - 200px)))`
                  : "0px",
              } as CSSProperties}
            >
              <div className={cn(
                "min-h-0 min-w-0",
                verticalTabs ? "relative col-start-1 row-start-2 pb-1.5 pr-1.5" : "col-span-2 col-start-1 row-start-1 pl-[var(--chrome-inset)]",
              )}>
                {tabs}
                {resizableTabs && (
                  <TabStripGutter
                    width={tabWidth}
                    onPreview={setPreviewTabWidth}
                    onResize={saveTabWidth}
                    tabListId="workspace-tabs"
                  />
                )}
              </div>
              {verticalTabs && <div data-tauri-drag-region className="col-span-2 col-start-1 row-start-1 ml-[var(--chrome-inset)]" />}
              {!fullWorkspace && (
                <div className="col-start-3 row-start-1 ml-1 flex items-center gap-0.5" role="group" aria-label={t("files.dockGroup")}>
                  <DockButton current={dock} dock="bottom" collapsed={filesCollapsed} onSelect={selectDock} />
                  <DockButton current={dock} dock="right" collapsed={filesCollapsed} onSelect={selectDock} />
                </div>
              )}
              <ResizablePanelGroup
                id="workspace"
                groupRef={workspaceRef}
                orientation={dock === "right" ? "horizontal" : "vertical"}
                className={cn("col-end-4 row-start-2 min-h-0 min-w-0 pb-1.5", verticalTabs ? "col-start-2" : "col-start-1")}
                defaultLayout={layout.groups[workspaceGroup(dock)]}
                onLayoutChange={(next) => {
                  if ("files" in next) setFilesCollapsed(isPanelCollapsed(next, "files"));
                }}
                onLayoutChanged={(next, meta) => {
                  // A live tab-width preview also resizes the inner group through its ResizeObserver.
                  if ("files" in next && (previewTabWidth === null || meta.isUserInteraction)) {
                    saveGroup(workspaceGroup(dock), meta.requestedLayout ?? next);
                  }
                }}
              >
                <ResizablePanel id="terminal" minSize="200px">
                  <section
                    aria-label={t("shell.workspace")}
                    className="bg-terminal-background text-terminal-foreground relative h-full overflow-hidden rounded-lg border"
                  >
                    {workspace}
                  </section>
                </ResizablePanel>
                {!fullWorkspace && <PanelGutter />}
                {!fullWorkspace && (
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
                      className="bg-surface flex h-full flex-col overflow-hidden rounded-lg border"
                    >
                      <FilePanelDockContext value={filePanelDock}>{filePanel}</FilePanelDockContext>
                    </section>
                  </ResizablePanel>
                )}
              </ResizablePanelGroup>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <StatusBar info={status} onShowForwards={() => showSidebarView("forwards")} onOpenSettings={nav.onSettings} />
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
