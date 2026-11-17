import { Plus, SquareTerminal, X } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { cn } from "@/lib/utils";
import { tabId, tabPanelId, tabTitle, type Tab } from "./tabs";

interface TabStripProps {
  tabs: Tab[];
  activeId: string | null;
  onActivate(id: string): void;
  onClose(id: string): void;
  onNewLocalTerminal(): void;
}

/**
 * Tabs sit on the chrome; the active one is cut from the Terminal surface below it
 * (same colour, joined edge). Arrow keys move between tabs, middle-click closes.
 */
export function TabStrip({ tabs, activeId, onActivate, onClose, onNewLocalTerminal }: TabStripProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Delete" && activeId) {
      event.preventDefault();
      onClose(activeId);
      return;
    }
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    let next: Tab | undefined;
    if (step !== undefined) next = tabs[(index + step + tabs.length) % tabs.length];
    if (event.key === "Home") next = tabs[0];
    if (event.key === "End") next = tabs.at(-1);
    if (!next) return;
    event.preventDefault();
    onActivate(next.id);
    listRef.current?.querySelector<HTMLElement>(`#${tabId(next.id)}`)?.focus();
  };

  return (
    <div className="flex min-w-0 items-end gap-0.5">
      <div
        ref={listRef}
        role="tablist"
        aria-label={t("tabs.listLabel")}
        className="flex min-w-0 items-end gap-0.5 overflow-x-auto [scrollbar-width:none]"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const title = tabTitle(tab, t);
          return (
            <div
              key={tab.id}
              className={cn(
                "group/tab relative flex h-8 max-w-52 min-w-28 shrink-0 items-center rounded-t-lg transition-colors",
                active
                  ? "bg-terminal-background text-foreground z-10 -mb-px h-[calc(2rem+1px)] border border-b-0"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id);
              }}
            >
              <button
                id={tabId(tab.id)}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={tabPanelId(tab.id)}
                aria-keyshortcuts="Delete"
                tabIndex={active ? 0 : -1}
                title={title}
                className="focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-2 rounded-t-lg pr-1 pl-3 outline-none focus-visible:ring-[3px]"
                onClick={() => onActivate(tab.id)}
              >
                <SquareTerminal className="size-3.5 shrink-0 opacity-70" aria-hidden />
                <span className="truncate">{title}</span>
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-label={t("tabs.close", { title })}
                className={cn(
                  "text-muted-foreground hover:bg-accent hover:text-foreground mr-1.5 grid size-5 shrink-0 place-items-center rounded-md",
                  !active && "opacity-0 group-hover/tab:opacity-100",
                )}
                onClick={() => onClose(tab.id)}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <IconButton label={t("tabs.newLocalTerminal")} className="mb-1.5" onClick={onNewLocalTerminal}>
        <Plus />
      </IconButton>
    </div>
  );
}
