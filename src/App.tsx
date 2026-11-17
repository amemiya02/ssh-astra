import { SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LocalTerminalView } from "@/features/terminal/LocalTerminalView";

/**
 * Walking skeleton: a tab strip with a single Local terminal. Host list,
 * splits and the File panel arrive in later tickets.
 */
export function App() {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-end gap-1 border-b px-2">
        <div
          role="tab"
          aria-selected="true"
          className="bg-terminal-background text-foreground flex h-8 items-center gap-2 rounded-t-md border border-b-0 px-3 text-sm"
        >
          <SquareTerminal className="text-muted-foreground size-4" aria-hidden />
          {t("tabs.localTerminal")}
        </div>
      </header>
      <main className="bg-terminal-background min-h-0 flex-1">
        <LocalTerminalView />
      </main>
    </div>
  );
}
