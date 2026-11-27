import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { SegmentedControl } from "@/components/SegmentedControl";
import type { FilePanelDock } from "@/features/shell/shell-layout";
import { useSetting } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { TransferRow } from "./TransferRow";
import { transferSetting } from "./transfer-settings";
import { activeTransfers, clearCompletedTransfers, doneTransfers, transfersStore, useTransfers } from "./transfersStore";

/**
 * The transfer list inside the File panel (DESIGN.md "Transfer row"): Active and Done, each
 * row with progress, speed, time left and the actions available for its current state. Collapsible to its header; hidden
 * while there are no transfers.
 */
export function TransfersPanel({ dock, visible }: { dock: FilePanelDock; visible: boolean }) {
  const { t } = useTranslation();
  const transfers = useTransfers((s) => s.transfers);
  const speeds = useTransfers((s) => s.speeds);
  const [settings, setSettings] = useSetting(transferSetting);
  const [view, setView] = useState<"active" | "done">("active");
  const collapsed = settings.panelCollapsed;
  useLayoutEffect(() => {
    if (visible && !collapsed) return transfersStore.getState().trackVisiblePanel();
  }, [collapsed, visible]);
  if (transfers.length === 0) return null;

  const active = activeTransfers(transfers);
  const done = doneTransfers(transfers);
  const shown = view === "active" ? active : done;
  const toggle = () => setSettings({ ...settings, panelCollapsed: !collapsed });

  return (
    <section
      aria-label={t("transfers.title")}
      className={cn(
        "flex min-h-0 shrink-0 flex-col",
        dock === "bottom" ? "border-l" : "max-h-[45%] border-t",
        dock === "bottom" && !collapsed && "w-[45%] max-w-120 min-w-56",
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 pr-2 pl-1.5">
        <IconButton label={collapsed ? t("transfers.expand") : t("transfers.collapse")} onClick={toggle} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight /> : <ChevronDown />}
        </IconButton>
        <h3 className="flex-1 truncate font-semibold">{t("transfers.title")}</h3>
        {!collapsed && view === "done" && done.length > 0 && (
          <IconButton
            label={t("transfers.clearDone")}
            onClick={clearCompletedTransfers}
          >
            <Trash2 />
          </IconButton>
        )}
        {!collapsed && (
          <SegmentedControl
            label={t("transfers.title")}
            value={view}
            options={[
              { value: "active", label: t("transfers.active", { count: active.length }) },
              { value: "done", label: t("transfers.done", { count: done.length }) },
            ]}
            onChange={(value) => setView(value as "active" | "done")}
          />
        )}
      </header>
      {!collapsed && (
        <ul className="min-h-0 flex-1 overflow-auto px-3 pb-2">
          {shown.length === 0 ? (
            <li className="text-muted-foreground p-4 text-center text-xs">
              {view === "active" ? t("transfers.noneActive") : t("transfers.noneDone")}
            </li>
          ) : (
            shown.map((transfer) => (
              <TransferRow key={transfer.id} transfer={transfer} speed={speeds[transfer.id]} />
            ))
          )}
        </ul>
      )}
    </section>
  );
}
