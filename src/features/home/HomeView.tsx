import { FileInput, Plus, Search, Server, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConnectionDot } from "@/features/connect/ConnectionDot";
import type { HostConnection } from "@/features/connect/hostConnection";
import { connectionSearch, quickConnectLabel } from "@/features/connect/quick-connect";
import { HostMonogram } from "@/features/hosts/HostMonogram";
import { OpenSshMissing } from "@/features/hosts/openSshSync";
import { Highlighted } from "@/features/hosts/HostList";
import { HostSortMenu } from "@/features/hosts/HostSortMenu";
import { HostTagFilter } from "@/features/hosts/HostTagFilter";
import { recentHostIds, recentHostsSetting } from "@/features/hosts/host-history";
import { hostSortSetting, sortHostTree } from "@/features/hosts/host-sort";
import { hasHostTag } from "@/features/hosts/host-tags";
import { hostHue, hueClasses } from "@/features/hosts/hostHue";
import { hostMenuEntries } from "@/features/hosts/hostMenu";
import type { HostMatches } from "@/features/hosts/hostTree";
import { RowContextMenu, RowMoreMenu } from "@/features/hosts/RowMenu";
import { useHosts } from "@/features/hosts/hostsStore";
import type { HostsController } from "@/features/hosts/useHostsController";
import { privacyModeSetting } from "@/features/workspace/privacy-mode";
import { reportHomeFirstPaint } from "@/lib/ipc/home";
import type { Host, HostId, QuickConnectTarget } from "@/lib/ipc/hosts";
import { defineSection, useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { firstHost, homeSections, recentHostsOf } from "./homeSections";

const recentLimit = 4;
const cardGrid = "grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]";

type HomeLayout = "cards" | "list";
const homeLayoutSetting = defineSection<HomeLayout>("homeLayout", "cards", (raw) => raw === "list" ? "list" : "cards");

interface HomeViewProps {
  /** The Home tab is the one shown: its search field takes focus. */
  active: boolean;
  controller: HostsController;
  /** Each Host's Connection (a Terminal, "Connect only" or a Port forward). */
  connections: ReadonlyMap<HostId, HostConnection>;
  onOpenLocalTerminal(): void;
  onQuickConnect(target: QuickConnectTarget): void;
}

/**
 * The Host vault: search, the actions for getting Hosts in, Hosts opened lately, and every Host
 * by Group. Host cards and rows open Terminals and share the Host list's actions.
 */
export function HomeView({ active, controller, connections, onOpenLocalTerminal, onQuickConnect }: HomeViewProps) {
  const { t } = useTranslation();
  const tree = useHosts((s) => s.tree);
  const status = useHosts((s) => s.status);
  const loadError = useHosts((s) => s.error);
  const [privacyMode] = useSetting(privacyModeSetting);
  const [recent] = useSetting(recentHostsSetting);
  const [sort, setSort] = useSetting(hostSortSetting);
  const [layout, setLayout] = useSetting(homeLayoutSetting);
  const listView = layout === "list";
  const hostLayout = listView ? "grid grid-cols-1 gap-1.5" : cardGrid;
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const measurement = window as Window & { __sshastraMeasureStartup?: boolean };
    if (!active || !measurement.__sshastraMeasureStartup) return;
    let afterPaint = 0;
    const beforePaint = requestAnimationFrame(() => {
      afterPaint = requestAnimationFrame(() => {
        delete measurement.__sshastraMeasureStartup;
        void reportHomeFirstPaint();
      });
    });
    return () => {
      cancelAnimationFrame(beforePaint);
      cancelAnimationFrame(afterPaint);
    };
  }, [active]);

  const empty = tree.hosts.length === 0;
  useEffect(() => {
    if (active) search.current?.focus({ preventScroll: true });
  }, [active]);

  const searching = query.trim() !== "";
  const filtering = searching || selectedTag !== null;
  const { exact: exactHost, quick } = connectionSearch(tree.hosts, query);
  const exact = selectedTag === null || hasHostTag(exactHost?.tags, selectedTag) ? exactHost : undefined;
  const sortHistory = sort === "recent" ? recent : undefined;
  const sortedTree = useMemo(() => sortHostTree(tree, sort, sortHistory), [tree, sort, sortHistory]);
  const sections = useMemo(() => homeSections(exact
    ? { ...sortedTree, hosts: sortedTree.hosts.filter((host) => host.id !== exact.id) }
    : sortedTree, query, selectedTag), [sortedTree, query, exact, selectedTag]);
  const recents = useMemo(() => recentHostsOf(tree.hosts, recentHostIds(recent), recentLimit), [tree.hosts, recent]);
  const { actions, messages } = controller;
  const runQuickConnect = (target: QuickConnectTarget) => {
    setQuery("");
    onQuickConnect(target);
  };

  return (
    <div className="bg-surface h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search aria-hidden className="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" />
            <Input
              ref={search}
              type="search"
              aria-label={t("home.search")}
              placeholder={t("home.search")}
              className="bg-background h-9 pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
              value={query}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                } else if (event.key === "Enter" && searching) {
                  const first = exact ?? firstHost(sections);
                  if (quick) {
                    event.preventDefault();
                    runQuickConnect(quick);
                  } else if (first) {
                    event.preventDefault();
                    actions.open(first);
                  }
                }
              }}
            />
            {query && (
              <IconButton label={t("hosts.clearSearch")} className="absolute top-1.5 right-1.5" onClick={() => setQuery("")}>
                <X />
              </IconButton>
            )}
          </div>
          {!empty && <HostSortMenu order={sort} onChange={setSort} />}
          {!empty && (
            <SegmentedControl
              label={t("home.layout.label")}
              value={layout}
              options={[{ value: "cards", label: t("home.layout.cards") }, { value: "list", label: t("home.layout.list") }]}
              onChange={setLayout}
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={controller.newHost}>
              <Plus aria-hidden />
              {t("hosts.new")}
            </Button>
            <Button variant="outline" size="sm" onClick={onOpenLocalTerminal}>
              <SquareTerminal aria-hidden />
              {t("tabs.localTerminal")}
            </Button>
            <Button variant="outline" size="sm" onClick={controller.openImport}>
              <FileInput aria-hidden />
              {t("hosts.import.action")}
            </Button>
          </div>
        </div>
        <HostTagFilter hosts={tree.hosts} value={selectedTag} onChange={setSelectedTag} />
        {messages}
        {quick && (
          <Button variant="outline" className="w-fit" onClick={() => runQuickConnect(quick)}>
            <SquareTerminal aria-hidden />
            {privacyMode ? t("quickConnect.action") : t("quickConnect.connectTo", { target: quickConnectLabel(quick) })}
          </Button>
        )}
        {exact && (
          <div className={hostLayout}>
            <HomeHost host={exact} listView={listView} privacyMode={privacyMode} controller={controller} connection={connections.get(exact.id)} />
          </div>
        )}
        {status === "error" ? (
          <p role="alert" className="text-destructive text-xs">
            {loadError}
          </p>
        ) : empty && !filtering ? (
          status === "ready" && (
            <div className="flex flex-col items-start gap-2 py-8">
              <Server className="text-muted-foreground size-6" aria-hidden />
              <h2 className="text-base font-semibold">{t("home.emptyTitle")}</h2>
              <p className="text-muted-foreground max-w-prose text-pretty">{t("home.emptyBody")}</p>
            </div>
          )
        ) : sections.length === 0 && !quick && !exact ? (
          <div className="flex flex-col items-start gap-2 py-8">
            <Search className="text-muted-foreground size-5" aria-hidden />
            <h2 className="font-semibold">{t("hosts.noResultsTitle")}</h2>
            <p className="text-muted-foreground text-pretty">{t("hosts.noResultsBody")}</p>
          </div>
        ) : (
          <>
            {!filtering && recents.length > 0 && (
              <section aria-labelledby="home-recent" className="flex flex-col gap-2">
                <h2 id="home-recent" className="text-sm font-semibold">
                  {t("home.recent")}
                </h2>
                <ul className={hostLayout}>
                  {recents.map((host) => (
                    <li key={host.id}>
                      <HomeHost host={host} listView={listView} privacyMode={privacyMode} controller={controller} connection={connections.get(host.id)} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {sections.map((section) => (
              <section key={section.id} aria-labelledby={`home-group-${section.id}`} className="flex flex-col gap-2">
                <h2 id={`home-group-${section.id}`} className="text-sm font-semibold">
                  {section.title ?? t(tree.groups.length > 0 ? "home.ungrouped" : "home.hosts")}
                  <span className="text-muted-foreground ml-1.5 text-xs font-normal tabular-nums">{section.hosts.length}</span>
                </h2>
                <ul className={hostLayout}>
                  {section.hosts.map(({ host, matches }) => (
                    <li key={host.id}>
                      <HomeHost host={host} listView={listView} privacyMode={privacyMode} matches={matches} controller={controller} connection={connections.get(host.id)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** Keep the same button and menus when switching between the Host card and row. */
function HomeHost({
  host,
  listView,
  privacyMode,
  matches,
  controller,
  connection,
}: {
  host: Host;
  listView: boolean;
  privacyMode: boolean;
  matches?: HostMatches;
  controller: HostsController;
  connection?: HostConnection;
}) {
  const { t } = useTranslation();
  const { actions } = controller;
  const entries = hostMenuEntries(host, actions, t);
  return (
    <RowContextMenu entries={entries}>
      <div className="group/card relative">
        <button
          type="button"
          className={cn(
            "bg-background hover:bg-accent active:bg-accent/70 focus-visible:ring-ring/50 relative flex w-full min-w-0 items-center gap-3 rounded-lg border px-3 pr-9 text-left transition-colors outline-none focus-visible:ring-[3px]",
            listView ? "min-h-12 py-2" : "h-14",
          )}
          onClick={() => actions.open(host)}
        >
          {listView && (
            <span
              aria-hidden
              className={cn("absolute inset-y-2 left-0 w-0.5 rounded-full", hueClasses[hostHue(host)].line)}
            />
          )}
          <HostMonogram host={host} size={listView ? "sm" : "md"}>
            {connection && !listView && <ConnectionDot state={connection} className="ring-background absolute -right-0.5 -bottom-0.5 size-2 ring-2" />}
          </HostMonogram>
          <span className={cn("min-w-0 flex-1", listView && "flex flex-wrap items-center gap-x-3 gap-y-1")}>
            <span className={cn("block min-w-0", listView && "grow basis-40")}>
              <span className="flex min-w-0 items-center gap-1.5 font-medium">
                <span className="truncate"><Highlighted text={host.name} indexes={matches?.name} /></span>
                <OpenSshMissing host={host} />
              </span>
              {!privacyMode && (
                <span className="text-muted-foreground block truncate font-mono text-xs">
                  <Highlighted text={host.user} indexes={matches?.user} />@<Highlighted text={host.address} indexes={matches?.address} />
                  {host.port === 22 ? "" : `:${host.port}`}
                </span>
              )}
            </span>
            {listView && host.tags && host.tags.length > 0 && (
              <span className="flex min-w-0 max-w-full flex-wrap gap-1">
                {host.tags.map((tag) => (
                  <span key={tag} className="bg-muted text-muted-foreground max-w-full rounded-sm border px-1.5 py-0.5 text-xs [overflow-wrap:anywhere]">
                    {tag}
                  </span>
                ))}
              </span>
            )}
          </span>
          {listView ? (
            <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
              {connection && <ConnectionDot state={connection} />}
              {t(`tabs.status.${connection ?? "disconnected"}`)}
            </span>
          ) : connection && <span className="sr-only">{t(`tabs.status.${connection}`)}</span>}
        </button>
        <RowMoreMenu
          entries={entries}
          label={t("hosts.moreActions")}
          align="end"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        />
      </div>
    </RowContextMenu>
  );
}
