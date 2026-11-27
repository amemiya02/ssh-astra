import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/IconButton";
import { Input } from "@/components/ui/input";
import type { NameSearchMode } from "@/lib/ipc/files";
import type { FileBrowserStore } from "./fileBrowsers";
import { operationErrorText } from "./fileErrors";
import { childPath } from "./fileList";

export function FileNameSearch({ store, path, onClose }: {
  store: FileBrowserStore;
  path: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<NameSearchMode>("substring");
  const queryInput = useRef<HTMLInputElement>(null);
  const search = useStore(store, (s) => s.search);
  const loading = useStore(store, (s) => s.loading);
  const running = search?.state === "running";
  const result = search?.state === "complete" ? search.result : null;

  useEffect(() => () => store.getState().clearSearch(), [store]);

  return (
    <section aria-label={t("files.search.scope", { path })} className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex shrink-0 items-center gap-1 px-2 pb-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (!running && !loading) void store.getState().searchNames(query, mode);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <Input ref={queryInput} type="search" autoFocus aria-label={t("files.search.query")}
          placeholder={t(mode === "wildcard" ? "files.search.wildcardHint" : "files.search.query")}
          value={query} readOnly={running} onChange={(event) => setQuery(event.target.value)}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} className="h-7 min-w-0 flex-1 px-2 text-xs md:text-xs" />
        <select aria-label={t("files.search.mode")} value={mode} disabled={running}
          onChange={(event) => setMode(event.target.value === "wildcard" ? "wildcard" : "substring")}
          className="border-input bg-surface focus-visible:ring-ring/50 h-7 rounded-md border px-1 text-xs outline-none focus-visible:ring-[3px]">
          <option value="substring">{t("files.search.substring")}</option>
          <option value="wildcard">{t("files.search.wildcard")}</option>
        </select>
        {running ? (
          <Button type="button" variant="outline" size="xs" onClick={() => {
            store.getState().cancelSearch();
            queryInput.current?.focus();
          }}>
            {t("files.search.cancel")}
          </Button>
        ) : (
          <IconButton type="submit" label={t("files.search.submit")} disabled={query === "" || loading}>
            <Search />
          </IconButton>
        )}
      </form>
      {search?.state === "failed" && (
        <p role="alert" className="text-destructive px-3 text-xs">{operationErrorText(t, search.error)}</p>
      )}
      <div role="status" className="text-muted-foreground shrink-0 space-y-0.5 px-3 text-xs">
        {running && <p>{t("files.search.searching")}</p>}
        {search?.state === "cancelled" && <p>{t("files.search.cancelled")}</p>}
        {result && (
          <>
            <p>{result.matches.length === 0 ? t("files.search.noMatches") : t("files.search.matches", { count: result.matches.length })}</p>
            {result.limitReached && <p>{t("files.search.limit", { count: result.visited })}</p>}
            {result.skippedDirectories && <p>{t("files.search.skipped")}</p>}
          </>
        )}
      </div>
      {result && result.matches.length > 0 && (
        <ul aria-label={t("files.search.results")} className="min-h-0 flex-1 overflow-auto p-2">
          {result.matches.map((match) => (
            <li key={childPath(match.parent, match.name)}>
              <button type="button" title={childPath(match.parent, match.name)}
                className="hover:bg-accent focus-visible:ring-ring/50 flex w-full min-w-0 flex-col rounded-md px-2 py-1 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
                onClick={() => {
                  void store.getState().revealSearchMatch(match);
                  onClose();
                }}
              >
                <span className="max-w-full truncate text-xs font-medium">{match.name}</span>
                <span className="text-muted-foreground max-w-full truncate font-mono text-xs">{match.parent}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
