import { Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ContextMenuItem, ContextMenuPortal, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import type { Broadcast } from "@/features/workspace/broadcast";
import type { HostId } from "@/lib/ipc/hosts";
import type { Snippet } from "@/lib/ipc/snippets";
import { useSnippetLibrary, visibleOnHost } from "./snippet-library";

interface SnippetMenuProps {
  broadcast: Broadcast;
  paneId: string;
  hostId?: HostId;
  onRun(snippet: Snippet): void;
}

export function SnippetMenu({ broadcast, paneId, hostId, onRun }: SnippetMenuProps) {
  const { t } = useTranslation();
  const canRun = useStore(broadcast.store, ({ writers }) => writers.has(paneId));
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={!canRun} className="gap-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50">
        <Play />{t("snippets.title")}
      </ContextMenuSubTrigger>
      <ContextMenuPortal>
        <ContextMenuSubContent className="max-h-(--radix-context-menu-content-available-height) max-w-80 overflow-x-hidden overflow-y-auto">
          <SnippetMenuItems hostId={hostId} onRun={onRun} />
        </ContextMenuSubContent>
      </ContextMenuPortal>
    </ContextMenuSub>
  );
}

function SnippetMenuItems({ hostId, onRun }: Pick<SnippetMenuProps, "hostId" | "onRun">) {
  const { t } = useTranslation();
  const [library] = useSnippetLibrary();
  if (library.status === "loading") return <ContextMenuItem disabled>{t("snippets.loading")}</ContextMenuItem>;
  if (library.status === "error") {
    return <ContextMenuItem disabled>{t("snippets.loadFailed", { message: library.message })}</ContextMenuItem>;
  }
  const available = library.snippets.filter((snippet) => visibleOnHost(snippet, hostId));
  if (!available.length) return <ContextMenuItem disabled>{t("snippets.emptyHere")}</ContextMenuItem>;
  return available.map((snippet) => (
    <ContextMenuItem key={snippet.id} onSelect={() => onRun(snippet)}>
      <span className="truncate" title={snippet.name}>{snippet.name}</span>
    </ContextMenuItem>
  ));
}
