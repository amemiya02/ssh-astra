import { FolderTree, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { useFilePanelDock } from "@/features/shell/file-panel-dock";
import { TransfersPanel } from "@/features/transfers/TransfersPanel";
import { cn } from "@/lib/utils";

interface FilePanelProps {
  /** Header actions left of the close button (sync to Terminal directory, refresh, ...). */
  actions?: ReactNode;
  /** The file browser for the active Terminal's Host. Omit to show the empty state. */
  children?: ReactNode;
  /** Pinned under the body (files open in the editor). */
  footer?: ReactNode;
}

/**
 * Frame of the File panel dock: header with actions, a body slot, the transfers (beside
 * the body in the bottom dock, below it in the right dock) and a footer.
 */
export function FilePanel({ actions, children, footer }: FilePanelProps) {
  const { t } = useTranslation();
  const { collapse, dock } = useFilePanelDock();
  const bottom = dock === "bottom";
  return (
    <>
      <header className="flex h-10 shrink-0 items-center gap-0.5 border-b pr-2 pl-3">
        <h2 className="flex-1 truncate font-semibold">{t("files.title")}</h2>
        {actions}
        <IconButton label={t("files.hide")} onClick={collapse}>
          <X />
        </IconButton>
      </header>
      <div className={cn("flex min-h-0 flex-1", bottom ? "flex-row" : "flex-col")}>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {children ?? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <FolderTree className="text-muted-foreground size-5" aria-hidden />
              <p className="text-muted-foreground max-w-64 text-balance">{t("files.empty")}</p>
            </div>
          )}
        </div>
        <TransfersPanel dock={dock} />
      </div>
      {footer}
    </>
  );
}
