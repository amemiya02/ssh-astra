import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SettingRowDefinition } from "./setting-rows";
import { useSettingRowVisible } from "./settings-view";

interface SettingRowProps {
  setting: SettingRowDefinition;
  /** Override the description when it needs values or depends on the current setting. */
  description?: string | null;
  descriptionValues?: Record<string, string | number>;
  /** The editable control or action button. */
  children?: ReactNode;
}

/** One setting: title and description on the left, its control on the right. */
export function SettingRow({ setting, description, descriptionValues, children }: SettingRowProps) {
  const { t } = useTranslation();
  const visible = useSettingRowVisible(setting);
  if (!visible) return null;
  const details = description === undefined && setting.description ? t(setting.description, descriptionValues ?? {}) : description;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
      <div className="min-w-36 flex-1 space-y-0.5">
        <p className="font-medium">{t(setting.title)}</p>
        {details && <p className="text-muted-foreground text-xs text-pretty">{details}</p>}
      </div>
      {children && <div className="max-w-full shrink-0">{children}</div>}
    </div>
  );
}
