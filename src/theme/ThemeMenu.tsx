import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isAppThemeId, appThemes, darkThemeIds, lightThemeIds, type AppThemeId } from "./themes";
import { useTheme } from "./theme-context";
import { ThemeSwatch } from "./ThemeSwatch";

const groups = [
  { key: "light", ids: lightThemeIds },
  { key: "dark", ids: darkThemeIds },
] as const;

/**
 * The status bar's appearance menu: follow the system, or pick a theme. Pointing at or
 * moving onto a theme paints it across the window; closing the menu restores the saved one.
 */
export function ThemeMenu() {
  const { t } = useTranslation();
  const { settings, theme, setTheme, preview } = useTheme();
  const Icon = settings.theme === "system" ? Monitor : theme.appearance === "dark" ? Moon : Sun;

  return (
    <DropdownMenu onOpenChange={(open) => !open && preview(null)}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-foreground h-5 font-normal"
          aria-label={t("theme.menuLabel", { current: theme.name })}
        >
          <Icon aria-hidden />
          {theme.name}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="max-h-(--radix-dropdown-menu-content-available-height) min-w-52">
        <DropdownMenuRadioGroup
          value={settings.theme}
          onValueChange={(value) => {
            if (value === "system" || isAppThemeId(value)) setTheme(value);
          }}
        >
          <DropdownMenuRadioItem value="system" onFocus={() => preview(null)}>
            <Monitor aria-hidden className="text-muted-foreground size-4" />
            {t("theme.followSystem")}
          </DropdownMenuRadioItem>
          {groups.map(({ key, ids }) => (
            <div key={key} role="group" aria-label={t(`theme.${key}`)}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">{t(`theme.${key}`)}</DropdownMenuLabel>
              {ids.map((id) => (
                <ThemeMenuItem key={id} id={id} onPreview={preview} />
              ))}
            </div>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeMenuItem({ id, onPreview }: { id: AppThemeId; onPreview(id: AppThemeId): void }) {
  const entry = appThemes[id];
  return (
    <DropdownMenuRadioItem value={id} onFocus={() => onPreview(id)}>
      <ThemeSwatch theme={entry} />
      {entry.name}
    </DropdownMenuRadioItem>
  );
}
