import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Host } from "@/lib/ipc/hosts";
import { cn } from "@/lib/utils";
import { hostTagNames, tagKey } from "./host-tags";

export function HostTagFilter({ hosts, value, onChange }: {
  hosts: readonly Host[];
  value: string | null;
  onChange(tag: string | null): void;
}) {
  const { t } = useTranslation();
  const tags = useMemo(() => hostTagNames(hosts), [hosts]);
  if (tags.length === 0 && value === null) return null;

  const active = value === null ? null : tagKey(value);
  const visible = value !== null && !tags.some((tag) => tagKey(tag) === active) ? [...tags, value] : tags;
  const chip = (tag: string | null, label: string) => {
    const pressed = (tag === null ? null : tagKey(tag)) === active;
    return (
      <button
        key={tag === null ? "all" : `tag:${tagKey(tag)}`}
        type="button"
        aria-pressed={pressed}
        title={label}
        onClick={() => onChange(tag)}
        className={cn(
          "focus-visible:ring-ring/50 h-6 max-w-44 shrink-0 truncate rounded-sm border px-2 text-xs font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-inset",
          pressed ? "bg-selected text-foreground" : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        {label}
      </button>
    );
  };

  return (
    <div role="group" aria-label={t("hosts.tags.filter")} className="flex shrink-0 gap-1.5 overflow-x-auto">
      {chip(null, t("hosts.tags.all"))}
      {visible.map((tag) => chip(tag, tag))}
    </div>
  );
}
