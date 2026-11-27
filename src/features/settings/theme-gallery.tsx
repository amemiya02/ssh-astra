import { Check } from "lucide-react";
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useTheme } from "@/theme/theme-context";
import { appThemes, darkThemeIds, lightThemeIds, type AppTheme, type AppThemeId } from "@/theme/themes";
import { settingRows } from "./setting-rows";

/** The six ANSI hues a swatch row shows, then the accent: what tells dark themes apart at a glance. */
const swatchHues = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;

/** A small picture of a theme: tab strip, Host list strip and a Terminal sample with a row of its colours, all in the theme's own colours. */
function Miniature({ theme }: { theme: AppTheme }) {
  const { ui, terminal: term } = theme;
  return (
    <div
      aria-hidden
      className="flex aspect-16/10 w-full flex-col overflow-hidden rounded-md border"
      style={{ backgroundColor: ui.ground, borderColor: ui.border }}
    >
      <div className="flex h-[14%] shrink-0 items-end gap-1 px-1.5">
        <span className="h-[70%] w-[22%] rounded-t-[3px]" style={{ backgroundColor: ui.surface }} />
        <span className="h-[50%] w-[16%] rounded-t-[3px]" style={{ backgroundColor: ui.border }} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[24%] flex-col gap-1 p-1.5" style={{ backgroundColor: ui.sidebar }}>
          <span className="h-1 w-full rounded-full" style={{ backgroundColor: ui.primary }} />
          <span className="h-1 w-3/4 rounded-full" style={{ backgroundColor: ui.mutedForeground, opacity: 0.45 }} />
          <span className="h-1 w-2/3 rounded-full" style={{ backgroundColor: ui.mutedForeground, opacity: 0.45 }} />
        </div>
        <div
          className="flex min-w-0 flex-1 flex-col overflow-hidden px-2 py-1.5 font-mono text-[9px] leading-[1.45] whitespace-nowrap"
          style={{ backgroundColor: term.background, color: term.foreground }}
        >
          <div>
            <span style={{ color: term.green }}>$ </span>
            <span style={{ color: term.blue }}>ssh</span> <span style={{ color: term.yellow }}>prod</span>
          </div>
          <div>
            <span style={{ color: term.cyan }}>deploy</span> <span style={{ color: term.magenta }}>ok</span>
          </div>
          <div>
            <span style={{ color: term.red }}>warn</span> disk 91%
          </div>
          <div data-swatches className="mt-auto flex items-center gap-[3px] pt-1">
            {swatchHues.map((hue) => (
              <span key={hue} className="size-1.5 rounded-full" style={{ backgroundColor: term[hue] }} />
            ))}
            <span className="size-1.5 rounded-[2px]" style={{ backgroundColor: ui.primary }} />
          </div>
        </div>
      </div>
    </div>
  );
}

interface ThemeGroupProps<T extends AppThemeId> {
  label: string;
  hint?: string;
  ids: readonly T[];
  /** The card that is checked in this group, if any. */
  checked: T | null;
  onPick(id: T): void;
  onPreview(id: AppThemeId | null): void;
}

/** One radio group of theme cards: arrow keys move between cards, Enter or Space picks. Focus and hover preview. */
function ThemeGroup<T extends AppThemeId>({ label, hint, ids, checked, onPick, onPreview }: ThemeGroupProps<T>) {
  const cards = useRef<(HTMLButtonElement | null)[]>([]);
  const focused = useRef<AppThemeId | null>(null);
  const tabbable = checked ?? ids[0];

  const move = (event: KeyboardEvent, from: number) => {
    const last = ids.length - 1;
    const to = { ArrowRight: from + 1, ArrowDown: from + 1, ArrowLeft: from - 1, ArrowUp: from - 1, Home: 0, End: last }[
      event.key
    ];
    if (to === undefined) return;
    event.preventDefault();
    cards.current[(to + ids.length) % ids.length]?.focus();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h4 className="text-xs font-medium">{label}</h4>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
      </div>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
        {ids.map((id, index) => {
          const theme = appThemes[id];
          const isChecked = id === checked;
          return (
            <button
              key={id}
              ref={(node) => {
                cards.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-label={theme.name}
              aria-checked={isChecked}
              tabIndex={id === tabbable ? 0 : -1}
              onClick={() => onPick(id)}
              onKeyDown={(event) => move(event, index)}
              onPointerEnter={(event) => event.pointerType !== "touch" && onPreview(id)}
              onPointerLeave={() => onPreview(focused.current)}
              onFocus={() => {
                focused.current = id;
                onPreview(id);
              }}
              onBlur={() => {
                focused.current = null;
                onPreview(null);
              }}
              className={cn(
                "group/card flex cursor-pointer flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors outline-none",
                "hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                isChecked ? "border-primary bg-selected" : "border-transparent",
              )}
            >
              <Miniature theme={theme} />
              <span className="flex items-center justify-between gap-2 px-0.5">
                <span className="truncate text-xs font-medium">{theme.name}</span>
                {isChecked && <Check aria-hidden className="text-primary size-3.5 shrink-0" />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Every theme as a card, light ones and dark ones in their own groups. While following the
 * system each group has its own pick (used when the computer is light / dark); otherwise
 * one theme is checked. Pointing at or focusing a card previews it; leaving restores.
 */
export function ThemeGallery() {
  const { t } = useTranslation();
  const { settings, setTheme, setLightTheme, setDarkTheme, preview } = useTheme();
  const following = settings.theme === "system";
  const heading = useId();

  // A preview must not outlive the gallery (a tab switch can unmount a focused card without a blur).
  useEffect(() => () => preview(null), [preview]);

  const fixed = following ? null : settings.theme;
  return (
    <div role="group" aria-labelledby={heading} className="space-y-3 py-3">
      <p id={heading} className="font-medium">{t(settingRows.themeGallery.title)}</p>
      <ThemeGroup
        label={t("settings.theme.lightGroup")}
        hint={following ? t("settings.theme.usedWhenLight") : undefined}
        ids={lightThemeIds}
        checked={following ? settings.lightTheme : lightThemeIds.find((id) => id === fixed) ?? null}
        onPick={following ? setLightTheme : setTheme}
        onPreview={preview}
      />
      <ThemeGroup
        label={t("settings.theme.darkGroup")}
        hint={following ? t("settings.theme.usedWhenDark") : undefined}
        ids={darkThemeIds}
        checked={following ? settings.darkTheme : darkThemeIds.find((id) => id === fixed) ?? null}
        onPick={following ? setDarkTheme : setTheme}
        onPreview={preview}
      />
    </div>
  );
}
