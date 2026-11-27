import { AppWindow, Server, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { HostMonogram } from "@/features/hosts/HostMonogram";
import { useHosts } from "@/features/hosts/hostsStore";
import type { Host } from "@/lib/ipc/hosts";
import { useSetting } from "@/lib/storage";
import { useRegisteredActions } from "./palette-actions";
import { rankPalette, type PaletteEntry, type RankedEntry } from "./palette-search";
import { recentHostsSetting } from "./recent-hosts";

export interface PaletteTab {
  id: string;
  title: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The open tabs, in strip order, with the titles the strip shows. */
  tabs: PaletteTab[];
  onOpenHost(host: Host): void;
  onActivateTab(id: string): void;
}

interface Row extends PaletteEntry {
  /** A Host row shows the Host's tile instead of the group's icon. */
  host?: Host;
  shortcut?: string;
  run(): void;
}

type Section = "recent" | PaletteEntry["group"] | "results";

const icons = { hosts: Server, tabs: AppWindow, actions: Zap };

/**
 * The ⌘K palette: find and open a Host, switch to a tab, or run an action from the registry
 * (`usePaletteActions`). Ranking is `rankPalette`; cmdk only handles the keyboard and list.
 */
export function CommandPalette({ open, onOpenChange, tabs, onOpenHost, onActivateTab }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const hosts = useHosts((s) => s.tree.hosts);
  const [recent] = useSetting(recentHostsSetting);
  const actions = useRegisteredActions();

  const rows = useMemo((): Row[] => {
    const recency = new Map(recent.map((id, i) => [id, i]));
    return [
      ...hosts.map(
        (host): Row => ({
          id: `host:${host.id}`,
          group: "hosts",
          title: host.name,
          detail: `${host.user}@${host.address}${host.port === 22 ? "" : `:${host.port}`}`,
          recent: recency.get(host.id),
          host,
          run: () => onOpenHost(host),
        }),
      ),
      ...tabs.map((tab): Row => ({ id: `tab:${tab.id}`, group: "tabs", title: tab.title, run: () => onActivateTab(tab.id) })),
      ...actions.map(
        (action): Row => ({
          id: `action:${action.id}`,
          group: "actions",
          title: action.title,
          keywords: action.keywords,
          shortcut: action.shortcut,
          run: action.run,
        }),
      ),
    ];
  }, [hosts, recent, tabs, actions, onOpenHost, onActivateTab]);

  const sections = useMemo(() => {
    const ranked = rankPalette(rows, query);
    const out: { section: Section; items: RankedEntry<Row>[] }[] = [];
    for (const item of ranked) {
      const section: Section = query.trim()
        ? "results"
        : item.entry.recent !== undefined
          ? "recent"
          : item.entry.group;
      const last = out.at(-1);
      if (last?.section === section) last.items.push(item);
      else out.push({ section, items: [item] });
    }
    return out;
  }, [rows, query]);

  const changeOpen = (next: boolean) => {
    if (!next) setQuery("");
    onOpenChange(next);
  };

  const run = (row: Row) => {
    changeOpen(false);
    row.run();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={changeOpen}
      title={t("palette.title")}
      description={t("palette.description")}
      showCloseButton={false}
      className="sm:max-w-xl"
      shouldFilter={false}
    >
      <CommandInput value={query} onValueChange={setQuery} placeholder={t("palette.placeholder")} />
      <CommandList className="max-h-96">
        <CommandEmpty className="text-muted-foreground py-6 text-center text-sm">{t("palette.empty")}</CommandEmpty>
        {sections.map(({ section, items }) => (
          <CommandGroup key={section} heading={section === "results" ? undefined : t(`palette.groups.${section}`)}>
            {items.map(({ entry, titleMatches }) => {
              const Icon = icons[entry.group];
              return (
                <CommandItem key={entry.id} value={entry.id} onSelect={() => run(entry)} className="py-2">
                  {entry.host ? <HostMonogram host={entry.host} /> : <Icon aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">
                    <Highlighted text={entry.title} indexes={titleMatches} />
                    {entry.detail && <span className="text-muted-foreground ml-2 font-mono text-xs">{entry.detail}</span>}
                  </span>
                  {entry.shortcut && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

function Highlighted({ text, indexes }: { text: string; indexes: number[] }) {
  if (indexes.length === 0) return <>{text}</>;
  const hit = new Set(indexes);
  return (
    <>
      {Array.from({ length: text.length }, (_, i) => text.charAt(i)).map((char, i) =>
        hit.has(i) ? (
          <mark key={i} className="text-foreground bg-transparent font-semibold">
            {char}
          </mark>
        ) : (
          char
        ),
      )}
    </>
  );
}
