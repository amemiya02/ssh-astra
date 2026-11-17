import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/IconButton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** One row action, shown both in the right-click menu and the "More actions" menu. */
export type MenuEntry =
  | {
      type: "item";
      label: string;
      icon?: ReactNode;
      destructive?: boolean;
      disabled?: boolean;
      /** Nesting level, for "Move to" Group lists. */
      depth?: number;
      onSelect(): void;
    }
  | { type: "sub"; label: string; icon?: ReactNode; entries: MenuEntry[] }
  | { type: "separator" };

/** Wraps a row so right-clicking it opens its actions. */
export function RowContextMenu({ entries, children }: { entries: MenuEntry[]; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">{renderContext(entries)}</ContextMenuContent>
    </ContextMenu>
  );
}

/** The row's hover "More actions" button, for pointer and keyboard users who don't right-click. */
export function RowMoreMenu({ entries, label, className }: { entries: MenuEntry[]; label: string; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label} className={className}>
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {renderDropdown(entries)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function renderContext(entries: MenuEntry[]): ReactNode {
  return entries.map((entry, i) => {
    if (entry.type === "separator") return <ContextMenuSeparator key={i} />;
    if (entry.type === "sub") {
      return (
        <ContextMenuSub key={i}>
          <ContextMenuSubTrigger className="gap-2">
            {entry.icon}
            {entry.label}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 overflow-y-auto">{renderContext(entry.entries)}</ContextMenuSubContent>
        </ContextMenuSub>
      );
    }
    return (
      <ContextMenuItem
        key={i}
        variant={entry.destructive ? "destructive" : "default"}
        disabled={entry.disabled}
        style={entry.depth ? { paddingLeft: 8 + entry.depth * 12 } : undefined}
        onSelect={entry.onSelect}
      >
        {entry.icon}
        {entry.label}
      </ContextMenuItem>
    );
  });
}

function renderDropdown(entries: MenuEntry[]): ReactNode {
  return entries.map((entry, i) => {
    if (entry.type === "separator") return <DropdownMenuSeparator key={i} />;
    if (entry.type === "sub") {
      return (
        <DropdownMenuSub key={i}>
          <DropdownMenuSubTrigger className="gap-2">
            {entry.icon}
            {entry.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 overflow-y-auto">{renderDropdown(entry.entries)}</DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    }
    return (
      <DropdownMenuItem
        key={i}
        variant={entry.destructive ? "destructive" : "default"}
        disabled={entry.disabled}
        style={entry.depth ? { paddingLeft: 8 + entry.depth * 12 } : undefined}
        onSelect={entry.onSelect}
      >
        {entry.icon}
        {entry.label}
      </DropdownMenuItem>
    );
  });
}
