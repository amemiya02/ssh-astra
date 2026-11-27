import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePaletteActions, type PaletteAction } from "@/features/palette/palette-actions";
import { getSetting, useSetting } from "@/lib/storage";
import { appearanceSetting, applyInterfaceFont, applyInterfaceZoom, applyTheme, darkQuery, resolveTheme, systemPrefersDark, type AppearanceSettings } from "./theme";
import { ThemeContext, type ThemeContextValue } from "./theme-context";
import { appThemeList, appThemes, type AppThemeId } from "./themes";

function subscribeToSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia(darkQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Paints the chosen theme (following the system's light/dark when asked) and repaints live on any change, a preview included. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useSetting(appearanceSetting);
  const systemDark = useSyncExternalStore(subscribeToSystemTheme, systemPrefersDark);
  const [previewId, preview] = useState<AppThemeId | null>(null);
  const theme = previewId ? appThemes[previewId] : resolveTheme(settings, systemDark);

  useEffect(() => applyTheme(document.documentElement, theme), [theme]);
  useLayoutEffect(() => { void applyInterfaceZoom(document.documentElement, settings.zoom); }, [settings.zoom]);
  useLayoutEffect(() => applyInterfaceFont(document.documentElement, settings.fontFamily), [settings.fontFamily]);

  const updateAppearance = useCallback((patch: Partial<AppearanceSettings>) => {
    setSettings(appearanceSetting.parse({ ...getSetting(appearanceSetting), ...patch }));
  }, [setSettings]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      settings,
      theme,
      setTheme: (next) => updateAppearance({ theme: next }),
      setLightTheme: (lightTheme) => updateAppearance({ lightTheme }),
      setDarkTheme: (darkTheme) => updateAppearance({ darkTheme }),
      setZoom: (zoom) => updateAppearance({ zoom }),
      setFontFamily: (fontFamily) => updateAppearance({ fontFamily }),
      preview,
    }),
    [settings, theme, updateAppearance],
  );

  const { setTheme } = value;
  const keywords = t("palette.keywords.theme");
  usePaletteActions(
    useMemo(
      (): PaletteAction[] => [
        ...appThemeList.map((entry) => ({
          id: `theme.${entry.id}`,
          title: t("theme.paletteAction", { name: entry.name }),
          keywords: [keywords],
          run: () => setTheme(entry.id),
        })),
        { id: "theme.system", title: t("theme.followSystemAction"), keywords: [keywords], run: () => setTheme("system") },
      ],
      [t, keywords, setTheme],
    ),
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}
