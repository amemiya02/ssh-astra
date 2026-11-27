import { FileInput, Plus, Search, Server, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hostHue, hueClasses, monogram } from "@/features/hosts/hostHue";
import { Highlighted } from "@/features/hosts/HostList";
import { hostMenuEntries } from "@/features/hosts/hostMenu";
import { RowContextMenu, RowMoreMenu } from "@/features/hosts/RowMenu";
import { useHosts } from "@/features/hosts/hostsStore";
import type { HostsController } from "@/features/hosts/useHostsController";
import { recentHostsSetting } from "@/features/palette/recent-hosts";
import type { Host, HostId } from "@/lib/ipc/hosts";
import { useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { firstHost, homeSections, recentHostsOf } from "./homeSections";

const recentLimit = 4;
const cardGrid = "grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]";

interface HomeViewProps {
  /** The Home tab is the one shown: its search field takes focus. */
  active: boolean;
  controller: HostsController;
  /** Hosts with a live Connection (a Terminal, "Connect only" or a Port forward). */
  connectedIds: ReadonlySet<HostId>;
  onOpenLocalTerminal(): void;
}

/**
 * The Host vault: search, the actions for getting Hosts in, Hosts opened lately, and every Host
 * as a card, by Group. A card opens a Terminal; its menu offers what the Host list's row menu does.
 */
export function HomeView({ active, controller, connectedIds, onOpenLocalTerminal }: HomeViewProps) {
  const { t } = useTranslation();
  const tree = useHosts((s) => s.tree);
  const status = useHosts((s) => s.status);
  const loadError = useHosts((s) => s.error);
  const [recent] = useSetting(recentHostsSetting);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const empty = tree.hosts.length === 0;
  // The field only exists once there are Hosts, which load after the first render.
  useEffect(() => {
    if (active) search.current?.focus({ preventScroll: true });
  }, [active, empty]);

  const searching = query.trim() !== "";
  const sections = useMemo(() => homeSections(tree, query), [tree, query]);
  const recents = useMemo(() => recentHostsOf(tree.hosts, recent, recentLimit), [tree.hosts, recent]);
  const { actions, messages } = controller;

  return (
    <div className="bg-surface h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-5">
        <div className="flex flex-wrap items-center gap-2">
          {!empty && (
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
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    setQuery("");
                  } else if (event.key === "Enter") {
                    const first = firstHost(sections);
                    if (first && searching) {
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
          )}
          <div className={cn("flex flex-wrap items-center gap-2", empty && "flex-1")}>
            <Button size="sm" onClick={controller.newHost}>
              <Plus aria-hidden />
              {t("hosts.new")}
            </Button>
            <Button variant="outline" size="sm" onClick={onOpenLocalTerminal}>
              <SquareTerminal aria-hidden />
              {t("tabs.localTerminal")}
            </Button>
            <Button variant="outline" size="sm" onClick={controller.importSshConfig}>
              <FileInput aria-hidden />
              {t("hosts.import.action")}
            </Button>
          </div>
        </div>
        {messages}
        {status === "error" ? (
          <p role="alert" className="text-destructive text-xs">
            {loadError}
          </p>
        ) : empty ? (
          status === "ready" && (
            <div className="flex flex-col items-start gap-2 py-8">
              <Server className="text-muted-foreground size-6" aria-hidden />
              <h2 className="text-base font-semibold">{t("home.emptyTitle")}</h2>
              <p className="text-muted-foreground max-w-prose text-pretty">{t("home.emptyBody")}</p>
            </div>
          )
        ) : sections.length === 0 ? (
          <div className="flex flex-col items-start gap-2 py-8">
            <Search className="text-muted-foreground size-5" aria-hidden />
            <h2 className="font-semibold">{t("hosts.noResultsTitle")}</h2>
            <p className="text-muted-foreground text-pretty">{t("hosts.noResultsBody")}</p>
          </div>
        ) : (
          <>
            {!searching && recents.length > 0 && (
              <section aria-labelledby="home-recent" className="flex flex-col gap-2">
                <h2 id="home-recent" className="text-sm font-semibold">
                  {t("home.recent")}
                </h2>
                <ul className={cardGrid}>
                  {recents.map((host) => (
                    <li key={host.id}>
                      <HostCard host={host} controller={controller} connected={connectedIds.has(host.id)} />
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
                <ul className={cardGrid}>
                  {section.hosts.map(({ host, matches }) => (
                    <li key={host.id}>
                      <HostCard host={host} matches={matches} controller={controller} connected={connectedIds.has(host.id)} />
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

/** One Host: monogram tile in its hue, name, `user@address`, a dot while connected. Click or Enter opens a Terminal. */
function HostCard({
  host,
  matches,
  controller,
  connected,
}: {
  host: Host;
  matches?: { name?: number[]; address?: number[]; user?: number[] };
  controller: HostsController;
  connected: boolean;
}) {
  const { t } = useTranslation();
  const { actions } = controller;
  const entries = hostMenuEntries(host, actions, t);
  return (
    <RowContextMenu entries={entries}>
      <div className="group/card relative">
        <button
          type="button"
          className="bg-background hover:bg-accent active:bg-accent/70 focus-visible:ring-ring/50 flex h-14 w-full min-w-0 items-center gap-3 rounded-lg border px-3 pr-9 text-left transition-colors outline-none focus-visible:ring-[3px]"
          onClick={() => actions.open(host)}
        >
          <span
            aria-hidden
            className={cn(
              "relative grid size-8 shrink-0 place-items-center rounded-md text-xs font-semibold",
              hueClasses[hostHue(host.id)].tile,
            )}
          >
            {monogram(host.name)}
            {connected && <span className="bg-success ring-background absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">
              <Highlighted text={host.name} indexes={matches?.name} />
            </span>
            <span className="text-muted-foreground block truncate font-mono text-xs">
              <Highlighted text={host.user} indexes={matches?.user} />@<Highlighted text={host.address} indexes={matches?.address} />
              {host.port === 22 ? "" : `:${host.port}`}
            </span>
          </span>
          {connected && <span className="sr-only">{t("tabs.status.connected")}</span>}
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
