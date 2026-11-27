import { useTranslation } from "react-i18next";
import { formatSize } from "@/features/files/fileList";
import { resourceHistoryMs, type ResourceTrendSample } from "./resource-history";

const metrics = [
  { field: "cpu", label: "resources.cpu", format: "percent" },
  { field: "load", label: "resources.loadTrend", format: "number" },
  { field: "memory", label: "resources.memory", format: "percent" },
  { field: "swap", label: "resources.swap", format: "percent" },
  { field: "disks", label: "resources.disks", format: "percent" },
  { field: "receive", label: "resources.receiveTrend", format: "rate" },
  { field: "send", label: "resources.sendTrend", format: "rate" },
] as const;

type Metric = (typeof metrics)[number];

export function ResourceTrends({ history }: { history: readonly ResourceTrendSample[] }) {
  const { t, i18n } = useTranslation();
  const latest = history.at(-1);
  if (!latest) return null;

  const number = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat(i18n.resolvedLanguage, { style: "percent", maximumFractionDigits: 1 });
  const format = (value: number, units: Metric["format"]) => {
    if (units === "percent") return percent.format(value / 100);
    if (units === "rate") return t("resources.rate", { size: formatSize(Math.round(value)) });
    return number.format(value);
  };
  return (
    <section className="space-y-2 border-t px-4 py-3 text-xs">
      <h3 className="font-semibold">{t("resources.trends")}</h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,6rem),1fr))] gap-2">
        {metrics.map((metric) => {
          const label = t(metric.label);
          const values = history.flatMap((sample) => sample[metric.field] ?? []);
          const max = metric.format === "percent" ? 100 : Math.max(0.01, ...values);
          const value = latest[metric.field];
          return (
            <figure key={metric.field} className="bg-ground min-w-0 rounded-md border px-2 py-1.5">
              <figcaption className="flex flex-wrap justify-between gap-x-1">
                <span className="text-muted-foreground">{label}</span>
                <span className="tabular-nums">{value === null ? "—" : format(value, metric.format)}</span>
              </figcaption>
              {values.length > 0 && (
                <Sparkline history={history} metric={metric} max={max} latest={latest.sampledAt}
                  label={t("resources.trendRange", {
                    metric: label,
                    low: format(Math.min(...values), metric.format),
                    high: format(Math.max(...values), metric.format),
                  })} />
              )}
            </figure>
          );
        })}
      </div>
    </section>
  );
}

function Sparkline({ history, metric, max, latest, label }: {
  history: readonly ResourceTrendSample[];
  metric: Metric;
  max: number;
  latest: number;
  label: string;
}) {
  const chartWidth = 120;
  const chartHeight = 32;
  const padding = 2;
  const oldest = latest - resourceHistoryMs;
  const x = (timestamp: number) => padding + ((timestamp - oldest) / resourceHistoryMs) * (chartWidth - 2 * padding);
  const y = (value: number) => chartHeight - padding - (value / max) * (chartHeight - 2 * padding);
  let previous: number | undefined;
  let path = "";
  for (const sample of history) {
    const value = sample[metric.field];
    if (value === null) {
      previous = undefined;
      continue;
    }
    const connected = previous !== undefined && sample.sampledAt - previous <= 10_000;
    path += `${connected ? "L" : "M"}${x(sample.sampledAt).toFixed(1)},${y(value).toFixed(1)}`;
    previous = sample.sampledAt;
  }
  const current = history.at(-1)?.[metric.field];
  return (
    <svg className="text-primary mt-1 h-8 w-full" viewBox={`0 0 ${chartWidth} ${chartHeight}`}
      preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={path} stroke="currentColor" fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {current != null && <circle cx={x(latest)} cy={y(current)} r={1.5} fill="currentColor" />}
    </svg>
  );
}
