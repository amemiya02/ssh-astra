import { Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ThemePreference } from "@/theme/theme";
import { useTheme } from "@/theme/theme-context";

/** The bottom bar: app-wide state on the left (`children`), appearance on the right. */
export function StatusBar({ children }: { children?: ReactNode }) {
  return (
    <footer className="text-muted-foreground flex h-6.5 shrink-0 items-center gap-3.5 border-t px-3 text-xs">
      <div className="flex min-w-0 flex-1 items-center gap-3.5">{children}</div>
      <ThemeMenu />
    </footer>
  );
}

const themeIcons = { system: Monitor, light: Sun, dark: Moon } as const;

function ThemeMenu() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const Icon = themeIcons[preference];
  const label = t(`theme.${preference}`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-foreground -mr-1.5 h-5 font-normal"
          aria-label={t("theme.menuLabel", { current: label })}
        >
          <Icon aria-hidden />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-40">
        <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">{t("theme.title")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
          {(["system", "light", "dark"] as const).map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {t(`theme.${option}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
