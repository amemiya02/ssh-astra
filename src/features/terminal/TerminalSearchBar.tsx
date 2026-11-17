import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/ui/input";

export type SearchDirection = "next" | "previous";

/** Where the current match is; `count` 0 means no match, `index` is -1 when none is selected. */
export interface SearchResults {
  index: number;
  count: number;
}

interface TerminalSearchBarProps {
  results: SearchResults | null;
  /** `incremental` is a search as you type: it may stay on the current match. */
  onFind(query: string, direction: SearchDirection, incremental?: boolean): void;
  onClose(): void;
}

/**
 * Find in the Terminal's scrollback, floating at its top right. Enter finds the
 * next match, Shift+Enter the previous one, Escape closes and returns to the Terminal.
 */
export function TerminalSearchBar({ results, onFind, onClose }: TerminalSearchBarProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  let status = "";
  if (query && results) {
    status =
      results.count === 0
        ? t("terminal.search.noResults")
        : t("terminal.search.results", { current: Math.max(results.index, 0) + 1, count: results.count });
  }

  return (
    <div
      role="search"
      className="bg-popover shadow-overlay absolute top-2 right-3 z-10 flex items-center gap-0.5 rounded-lg border p-1"
    >
      <Input
        aria-label={t("terminal.search.label")}
        placeholder={t("terminal.search.placeholder")}
        className="h-6.5 w-48 font-mono text-xs"
        value={query}
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          onFind(event.target.value, "next", true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onFind(query, event.shiftKey ? "previous" : "next");
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span aria-live="polite" className="text-muted-foreground min-w-16 px-1.5 text-center text-xs tabular-nums">
        {status}
      </span>
      <IconButton label={t("terminal.search.previous")} shortcut="⇧↵" onClick={() => onFind(query, "previous")}>
        <ChevronUp />
      </IconButton>
      <IconButton label={t("terminal.search.next")} shortcut="↵" onClick={() => onFind(query, "next")}>
        <ChevronDown />
      </IconButton>
      <IconButton label={t("terminal.search.close")} shortcut="Esc" onClick={onClose}>
        <X />
      </IconButton>
    </div>
  );
}
