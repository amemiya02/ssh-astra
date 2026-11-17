import type { ReactNode } from "react";

interface SettingRowProps {
  label: string;
  /** One muted sentence under the label: what the setting changes. */
  description?: string;
  /** The control; give it the same `label` as its accessible name. */
  children: ReactNode;
}

/** One setting: label and description on the left, its control on the right. */
export function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{label}</p>
        {description && <p className="text-muted-foreground text-xs text-pretty">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
