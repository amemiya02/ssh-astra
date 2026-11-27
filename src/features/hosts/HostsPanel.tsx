import { Download, FileInput, FolderPlus, Plus, Search, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { HostConnection } from "@/features/connect/hostConnection";
import type { HostId } from "@/lib/ipc/hosts";
import { useSetting } from "@/lib/storage";
import { HostList } from "./HostList";
import { HostSortMenu } from "./HostSortMenu";
import { HostTagFilter } from "./HostTagFilter";
import { HostsSidebar } from "./HostsSidebar";
import { RowMoreMenu } from "./RowMenu";
import { recentHostsSetting } from "./host-history";
import { hostSortSetting, sortHostTree } from "./host-sort";
import { searchTree } from "./hostTree";
import { useHosts } from "./hostsStore";
import type { HostsController } from "./useHostsController";

/**
 * The Host list in the sidebar: search, nested Groups, drag and drop. Everything it can change
 * (editor, dialogs, row actions) comes from the shared `HostsController`. Double-click (or Enter
 * on) a Host to open it.
 */
export function HostsPanel({
  controller,
  connections,
}: {
  controller: HostsController;
  /** Each Host's Connection, shown on its row. */
  connections: ReadonlyMap<HostId, HostConnection>;
}) {
  const { t } = useTranslation();
  const tree = useHosts((s) => s.tree);
  const status = useHosts((s) => s.status);
  const loadError = useHosts((s) => s.error);
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [sort, setSort] = useSetting(hostSortSetting);
  const [history] = useSetting(recentHostsSetting);
  const { messages, selected, selectedGroupId } = controller;

  const searching = query.trim() !== "" || selectedTag !== null;
  const sortHistory = sort === "recent" ? history : undefined;
  const sortedTree = useMemo(() => sortHostTree(tree, sort, sortHistory), [tree, sort, sortHistory]);
  const nodes = useMemo(() => searchTree(sortedTree, query, selectedTag), [sortedTree, query, selectedTag]);

  let list;
  if (status === "error") {
    list = (
      <div className="flex flex-col gap-2">
        <p role="alert" className="text-destructive px-1 py-2 text-xs">
          {loadError}
        </p>
        {messages}
      </div>
    );
  } else if (tree.hosts.length > 0 || tree.groups.length > 0 || selectedTag !== null) {
    list = (
      <div className="flex h-full flex-col gap-2">
        <SearchField value={query} onChange={setQuery} />
        <HostTagFilter hosts={tree.hosts} value={selectedTag} onChange={setSelectedTag} />
        {messages}
        <div className="min-h-0 flex-1">
          {searching && nodes.length === 0 ? (
            <div className="flex flex-col items-start gap-2 px-1 py-4">
              <Search className="text-muted-foreground size-5" aria-hidden />
              <p className="font-medium">{t("hosts.noResultsTitle")}</p>
              <p className="text-muted-foreground text-pretty">{t("hosts.noResultsBody")}</p>
            </div>
          ) : (
            <HostList
              tree={tree}
              nodes={nodes}
              searching={searching}
              manualOrder={sort === "manual"}
              selected={selected}
              onSelect={controller.setSelected}
              renamingGroupId={controller.renamingGroupId}
              connections={connections}
              actions={controller.actions}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <HostsSidebar
      emptyAction={
        <>
          <Button variant="outline" size="sm" onClick={controller.openImport}>
            <FileInput aria-hidden />
            {t("hosts.import.action")}
          </Button>
          {messages}
        </>
      }
      actions={
        <>
          {(tree.hosts.length > 0 || tree.groups.length > 0) && <HostSortMenu order={sort} onChange={setSort} />}
          <IconButton label={t("hosts.newGroup")} onClick={() => void controller.createGroup(selectedGroupId)}>
            <FolderPlus />
          </IconButton>
          <IconButton label={t("hosts.new")} onClick={controller.newHost}>
            <Plus />
          </IconButton>
          <RowMoreMenu
            label={t("hosts.moreActions")}
            align="end"
            entries={[
              { type: "item", label: t("hosts.import.action"), icon: <FileInput />, onSelect: controller.openImport },
              {
                type: "item",
                label: t("hosts.transfer.import"),
                icon: <Download />,
                onSelect: () => void controller.importHosts(),
              },
              {
                type: "item",
                label: t("hosts.transfer.export"),
                icon: <Upload />,
                onSelect: () => void controller.exportHosts(),
              },
            ]}
          />
        </>
      }
    >
      {list}
    </HostsSidebar>
  );
}

/** Escape clears the search. */
function SearchField({ value, onChange }: { value: string; onChange(value: string): void }) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <Search aria-hidden className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-3.5" />
      <Input
        type="search"
        aria-label={t("hosts.search")}
        placeholder={t("hosts.search")}
        className="bg-surface h-7.5 pr-8 pl-8 text-sm [&::-webkit-search-cancel-button]:hidden"
        value={value}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
      />
      {value && (
        <IconButton label={t("hosts.clearSearch")} className="absolute top-0.5 right-0.5" onClick={() => onChange("")}>
          <X />
        </IconButton>
      )}
    </div>
  );
}
