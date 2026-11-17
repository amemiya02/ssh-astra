import { Server, SquareTerminal, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HostsPanel } from "@/features/hosts/HostsPanel";
import { LocalTerminalView } from "@/features/terminal/LocalTerminalView";
import { RemoteTerminalView } from "@/features/terminal/RemoteTerminalView";
import type { Host } from "@/lib/ipc/hosts";

type Tab = { key: string; kind: "local" } | { key: string; kind: "remote"; host: Host };

let nextTabKey = 0;
const localTab: Tab = { key: "local", kind: "local" };

/**
 * Walking skeleton: a Host list beside a tab strip of Terminals. The main
 * window layout and design system replace this shell in a later ticket.
 */
export function App() {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<Tab[]>([localTab]);
  const [active, setActive] = useState(localTab.key);

  const openHost = (host: Host) => {
    const tab: Tab = { key: `remote-${++nextTabKey}`, kind: "remote", host };
    setTabs((all) => [...all, tab]);
    setActive(tab.key);
  };
  const closeTab = (key: string) => {
    setTabs((all) => all.filter((tab) => tab.key !== key));
    if (active === key) setActive(localTab.key);
  };

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 border-r">
        <HostsPanel onOpen={openHost} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header role="tablist" className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b px-2">
          {tabs.map((tab) => (
            <div
              key={tab.key}
              role="tab"
              tabIndex={0}
              aria-selected={tab.key === active}
              onClick={() => setActive(tab.key)}
              onKeyDown={(event) => {
                if (event.key === "Enter") setActive(tab.key);
              }}
              className={`flex h-8 shrink-0 cursor-default items-center gap-2 rounded-t-md border border-b-0 px-3 text-sm ${
                tab.key === active ? "bg-terminal-background text-foreground" : "text-muted-foreground border-transparent"
              }`}
            >
              {tab.kind === "local" ? (
                <SquareTerminal className="size-4" aria-hidden />
              ) : (
                <Server className="size-4" aria-hidden />
              )}
              {tab.kind === "local" ? t("tabs.localTerminal") : tab.host.name}
              {tab.kind === "remote" && (
                <button
                  type="button"
                  aria-label={t("tabs.close")}
                  className="hover:bg-accent -mr-1 rounded p-0.5"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.key);
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
          ))}
        </header>
        <main className="bg-terminal-background relative min-h-0 flex-1">
          {/* Every tab stays mounted so its shell survives switching tabs. */}
          {tabs.map((tab) => (
            <div key={tab.key} role="tabpanel" className={tab.key === active ? "h-full" : "hidden"}>
              {tab.kind === "local" ? <LocalTerminalView /> : <RemoteTerminalView host={tab.host} />}
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
