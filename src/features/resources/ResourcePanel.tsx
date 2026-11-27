import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatSize } from "@/features/files/fileList";
import { watchResources, type ResourceEvent, type ResourceSnapshot, type ResourceUsage } from "@/lib/ipc/resources";
import type { TerminalId } from "@/lib/ipc/terminal";
import { getSetting, useSetting, watchSetting } from "@/lib/storage";
import { resourceIntervals, resourceSetting } from "./resource-settings";
import { recordResourceSample, resizeResourceHistory, type ResourceHistories, type ResourceTrendSample } from "./resource-history";
import { ResourceTrends } from "./ResourceTrends";

export function ResourcePanel({ terminalId, generation, histories }: {
  terminalId: TerminalId;
  generation: number;
  histories: ResourceHistories;
}) {
  const { t } = useTranslation();
  const [{ intervalSeconds }, setSettings] = useSetting(resourceSetting);
  const [event, setEvent] = useState<ResourceEvent>();
  const [history, setHistory] = useState<readonly ResourceTrendSample[]>([]);
  useEffect(() => {
    let visible = true;
    let activeInterval = getSetting(resourceSetting).intervalSeconds;
    const cached = histories.get(terminalId);
    let samples: readonly ResourceTrendSample[] = [];
    if (cached?.generation === generation) {
      samples = cached.interval === activeInterval ? cached.samples
        : resizeResourceHistory(cached.samples, performance.now(), activeInterval);
    }
    const storeHistory = (next: readonly ResourceTrendSample[]) => {
      samples = next;
      histories.set(terminalId, { generation, interval: activeInterval, samples });
      setHistory(samples);
    };
    const subscription = watchResources(terminalId, activeInterval, (next) => {
      if (!visible) return;
      setEvent(next);
      if (next.type === "snapshot") {
        storeHistory(recordResourceSample(samples, next.snapshot, performance.now(), activeInterval));
      }
    });
    const unwatch = watchSetting(resourceSetting, ({ intervalSeconds }) => {
      if (activeInterval === intervalSeconds) return;
      activeInterval = intervalSeconds;
      if (samples.length) storeHistory(resizeResourceHistory(samples, performance.now(), intervalSeconds));
      subscription.setInterval(intervalSeconds);
    });
    return () => {
      visible = false;
      unwatch();
      subscription.stop();
    };
  }, [generation, histories, terminalId]);

  const intervalLabel = t("resources.sampleInterval");
  return (
    <>
      <label className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs">
        <span>{intervalLabel}</span>
        <select
          aria-label={intervalLabel}
          className="border-input bg-surface text-foreground focus-visible:ring-ring h-7 rounded-md border px-2 outline-none focus-visible:ring-2"
          value={intervalSeconds}
          onChange={(event) => {
            const selected = resourceIntervals.find((seconds) => seconds === Number(event.target.value));
            if (selected !== undefined) setSettings({ intervalSeconds: selected });
          }}
        >
          {resourceIntervals.map((seconds) => (
            <option key={seconds} value={seconds}>{t("resources.sampleSeconds", { count: seconds })}</option>
          ))}
        </select>
      </label>
      {event?.type === "snapshot" ? (
        <>
          <ResourceReadings snapshot={event.snapshot} />
          <ResourceTrends history={history} />
        </>
      ) : (
        <p className="text-muted-foreground p-4 text-sm" role="status">{t(
          event?.type === "unsupported" ? "resources.unsupported"
            : event?.type === "unavailable" ? "resources.unavailable" : "resources.loading",
        )}</p>
      )}
    </>
  );
}

function ResourceReadings({ snapshot }: { snapshot: ResourceSnapshot }) {
  const { t, i18n } = useTranslation();
  const { cpuPercent, cores, load, memory, swap, disks, network, uptimeSeconds } = snapshot;
  const number = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat(i18n.resolvedLanguage, { style: "percent", maximumFractionDigits: 1 });
  const units = new Intl.ListFormat(i18n.resolvedLanguage, { type: "unit", style: "short" });
  const unit = (value: number, unit: Intl.NumberFormatOptions["unit"]) =>
    new Intl.NumberFormat(i18n.resolvedLanguage, { style: "unit", unit }).format(value);
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor(uptimeSeconds / 3600) % 24;
  const minutes = Math.floor(uptimeSeconds / 60) % 60;
  const uptime = units.format(days ? [unit(days, "day"), unit(hours, "hour")]
    : hours ? [unit(hours, "hour"), unit(minutes, "minute")]
      : minutes ? [unit(minutes, "minute")] : [unit(Math.floor(uptimeSeconds), "second")]);
  const usage = ({ used, total }: ResourceUsage) =>
    t("resources.usage", { used: formatSize(used), total: formatSize(total) });
  const rate = (value: number | null) =>
    value === null ? t("resources.waiting") : t("resources.rate", { size: formatSize(Math.round(value)) });
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-x-5 gap-y-4 p-4 text-xs">
      <div className="space-y-3">
        <dl className="space-y-2">
          <ResourceRow label={t("resources.cpu")} value={t("resources.cpuValue", {
            usage: cpuPercent === null ? t("resources.waiting") : percent.format(cpuPercent / 100),
            count: cores,
          })} />
          <ResourceRow label={t("resources.load")} value={load.map((value) => number.format(value)).join(" / ")} />
          <ResourceRow label={t("resources.memory")} value={usage(memory)} />
          <ResourceRow label={t("resources.swap")} value={usage(swap)} />
          <ResourceRow label={t("resources.uptime")} value={uptime} />
        </dl>
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="font-semibold">{t("resources.disks")}</h3>
        {disks.length ? <dl className="space-y-2">
          {disks.map((disk) => <ResourceRow key={disk.mount} label={disk.mount} value={usage(disk)} path />)}
        </dl> : <p className="text-muted-foreground">{t("resources.emptyDisks")}</p>}
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="font-semibold">{t("resources.network")}</h3>
        {network.length ? <dl className="space-y-2">
          {network.map((link) => (
            <ResourceRow key={link.name} label={link.name}
              value={t("resources.networkValue", { receive: rate(link.receiveRate), send: rate(link.sendRate) })} />
          ))}
        </dl> : <p className="text-muted-foreground">{t("resources.emptyNetwork")}</p>}
      </div>
    </div>
  );
}

function ResourceRow({ label, value, path }: { label: string; value: string; path?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className={path ? "min-w-0 truncate font-mono" : "text-muted-foreground min-w-0 truncate"} title={label}>{label}</dt>
      <dd className="max-w-[75%] text-right tabular-nums">{value}</dd>
    </div>
  );
}
