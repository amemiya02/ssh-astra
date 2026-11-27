import { Trash2 } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { privacyModeSetting, workspaceHostName } from "@/features/workspace/privacy-mode";
import type { Transfer, TransferId } from "@/lib/ipc/transfers";
import { useSetting } from "@/lib/storage";
import { TransferRow } from "./TransferRow";
import { clearCompletedTransfers, transferGroups, transfersStore, useTransfers, type TransferFilter } from "./transfersStore";

const filters: readonly TransferFilter[] = ["all", "inProgress", "failed", "completed"];
const hiddenTransfers: readonly Transfer[] = [];
const hiddenSpeeds: Record<TransferId, number> = {};

export function GlobalTransfersPane({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const [privacyMode] = useSetting(privacyModeSetting);
  const [filter, setFilter] = useState<TransferFilter>("all");
  const transfers = useTransfers((s) => visible ? s.transfers : hiddenTransfers);
  const speeds = useTransfers((s) => visible ? s.speeds : hiddenSpeeds);
  useLayoutEffect(() => {
    if (visible) return transfersStore.getState().trackVisiblePanel();
  }, [visible]);
  if (!visible) return null;

  const groups = transferGroups(transfers, filter);
  return (
    <section aria-label={t("transfers.title")} className="bg-surface flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <SegmentedControl<TransferFilter>
          label={t("transfers.filter")}
          value={filter}
          options={filters.map((value) => ({ value, label: t(`transfers.filters.${value}`) }))}
          onChange={setFilter}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={!transfers.some(({ state }) => state.type === "done")}
          onClick={clearCompletedTransfers}
        >
          <Trash2 aria-hidden />
          {t("transfers.clearDone")}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-3">
        {groups.length === 0 ? (
          <p className="text-muted-foreground p-4 text-center text-xs">
            {t(`transfers.empty.${filter}`)}
          </p>
        ) : groups.map(({ host, transfers }) => (
          <section key={host ? `host:${host.id}` : "unknown"} className="border-b py-2 last:border-b-0">
            <h2 className="text-muted-foreground truncate text-xs font-semibold">
              {host ? workspaceHostName(host, t, privacyMode) : t("transfers.unknownHost")}
            </h2>
            <ul className="divide-y">
              {transfers.map((transfer) => (
                <TransferRow key={transfer.id} transfer={transfer} speed={speeds[transfer.id]} canReveal />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
