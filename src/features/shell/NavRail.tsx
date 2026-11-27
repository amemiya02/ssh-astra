import { ArrowRightLeft, FolderTree, House, Settings, SquareTerminal, Waypoints } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { currentPlatform, shortcutLabel } from "@/features/workspace/shortcuts";
import type { PaneKind } from "@/features/workspace/tabs";
import { cn } from "@/lib/utils";
import type { SidebarView } from "./shell-layout";

export interface NavRailProps {
  /** The sidebar view the column shows, and whether the column is open. */
  sidebarView: SidebarView;
  sidebarOpen: boolean;
  /** Clicking the active view collapses the column; any other opens it on that view. */
  onSidebarView(view: SidebarView): void;
  /** The kind of the focused tab's pane, to mark its rail item. */
  activeKind: PaneKind["kind"] | null;
  onHome(): void;
  onSftp(): void;
  onLocalTerminal(): void;
  onSettings(): void;
}

const platform = currentPlatform();

/** The 48px activity rail: places to go (Home, the sidebar's views, SFTP) on top, Local terminal and Settings below. */
export function NavRail({
  sidebarView,
  sidebarOpen,
  onSidebarView,
  activeKind,
  onHome,
  onSftp,
  onLocalTerminal,
  onSettings,
}: NavRailProps) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("shell.navigation")} className="bg-sidebar flex w-12 shrink-0 flex-col items-center pb-2">
      {/* Clear of the macOS traffic lights; also the window's drag handle. */}
      <div data-tauri-drag-region className="h-8.5 w-full shrink-0" />
      <AppMark />
      <div className="mt-2 flex w-full flex-col items-center gap-1 [@media(max-height:340px)]:mt-1 [@media(max-height:340px)]:gap-0.5">
        <RailButton label={t("rail.home")} active={activeKind === "home"} onClick={onHome}>
          <House />
        </RailButton>
        <RailButton
          label={t("rail.hosts")}
          pressed={sidebarOpen && sidebarView === "hosts"}
          onClick={() => onSidebarView("hosts")}
        >
          <FolderTree />
        </RailButton>
        <RailButton
          label={t("rail.forwards")}
          pressed={sidebarOpen && sidebarView === "forwards"}
          onClick={() => onSidebarView("forwards")}
        >
          <Waypoints />
        </RailButton>
        <RailButton label={t("sftp.open")} active={activeKind === "sftp"} onClick={onSftp}>
          <ArrowRightLeft />
        </RailButton>
      </div>
      <div className="mt-auto flex w-full flex-col items-center gap-1">
        <RailButton
          label={t("tabs.newLocalTerminal")}
          shortcut={shortcutLabel("newTab", platform)}
          active={activeKind === "local-terminal"}
          onClick={onLocalTerminal}
        >
          <SquareTerminal />
        </RailButton>
        <RailButton
          label={t("settings.open")}
          shortcut={shortcutLabel("settings", platform)}
          active={activeKind === "settings"}
          onClick={onSettings}
        >
          <Settings />
        </RailButton>
      </div>
    </nav>
  );
}

/**
 * One rail item, in one of two ways. A destination (`active`) takes you to a tab and gets the
 * selected tile while that tab is focused. A sidebar view is a toggle (`pressed`): while it is shown
 * its icon turns to the foreground colour and a 2px primary bar marks the rail's left edge, never
 * the tile, so the focused tab and the shown column never read as one state.
 */
function RailButton({
  label,
  shortcut,
  active,
  pressed,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <div className="relative flex w-full justify-center">
      {pressed && <span aria-hidden data-rail-indicator className="bg-primary absolute top-2 bottom-2 left-0 w-0.5 rounded-r-full" />}
      <IconButton
        label={label}
        shortcut={shortcut}
        tooltipSide="right"
        aria-pressed={pressed}
        aria-current={active ? "page" : undefined}
        className={cn(
          "size-9 rounded-lg [&_svg:not([class*='size-'])]:size-[18px]",
          active
            ? "bg-selected text-primary hover:bg-selected hover:text-primary"
            : cn("hover:bg-accent active:bg-accent/70", pressed && "text-foreground hover:text-foreground"),
        )}
        onClick={onClick}
      >
        {children}
      </IconButton>
    </div>
  );
}

/** The app mark: three stars forming `>` and an underscore, the icon's constellation. */
function AppMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="text-primary size-7 shrink-0" fill="none">
      <path d="M6 6.5 12 11l-6 4.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
      <path d="M13 17.5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="6" cy="6.5" r="1.8" fill="currentColor" />
      <circle cx="12" cy="11" r="1.4" fill="currentColor" />
      <circle cx="6" cy="15.5" r="1.8" fill="currentColor" />
    </svg>
  );
}
