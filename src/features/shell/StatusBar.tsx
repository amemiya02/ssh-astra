import { Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { ThemeMenu } from "@/theme/ThemeMenu";
import { currentPlatform, shortcutLabel } from "@/features/workspace/shortcuts";

const settingsShortcut = shortcutLabel("settings", currentPlatform());

/** The bottom bar: app-wide state on the left (`children`), appearance and Settings on the right. */
export function StatusBar({ children, onOpenSettings }: { children?: ReactNode; onOpenSettings(): void }) {
  const { t } = useTranslation();
  return (
    <footer className="text-muted-foreground flex h-6.5 shrink-0 items-center gap-3.5 border-t px-3 text-xs">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">{children}</div>
      <div className="-mr-1.5 flex items-center gap-0.5">
        <ThemeMenu />
        <IconButton label={t("settings.open")} shortcut={settingsShortcut} className="size-5" onClick={onOpenSettings}>
          <Settings className="size-3.5" />
        </IconButton>
      </div>
    </footer>
  );
}
