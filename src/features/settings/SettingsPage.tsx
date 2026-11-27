import { Search, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { settingsPageSections } from "./sections";
import { settingRows, type SettingsCategory } from "./setting-rows";
import { filterSettingsRows } from "./settings-search";
import { SettingsViewContext } from "./settings-view";

const availableRows = Object.values(settingRows).filter((row) =>
  settingsPageSections.some(({ id }) => id === row.category)
);

/** The Settings tab. Every change applies at once and is saved to the settings file. */
export function SettingsPage() {
  const { t } = useTranslation();
  const pageId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [category, setCategory] = useState<SettingsCategory>("appearance");
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const visibleRows = useMemo(() => new Set(
    searching ? filterSettingsRows(availableRows, query) : availableRows.filter((row) => row.category === category),
  ), [category, query, searching]);
  const visibleCategories = new Set([...visibleRows].map((row) => row.category));

  function updateQuery(value: string) {
    setQuery(value);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }

  return (
    <div className="@container text-foreground flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-5 py-4">
        <h2 className="text-lg font-semibold">{t("settings.title")}</h2>
        <p className="text-muted-foreground mt-0.5">{t("settings.lead")}</p>
        <div role="search" className="relative mt-3 max-w-md">
          <Search aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            ref={inputRef}
            type="search"
            aria-label={t("settings.search.placeholder")}
            placeholder={t("settings.search.placeholder")}
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="bg-ground pl-9 pr-9 shadow-none [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("settings.search.clear")}
              className="absolute top-1/2 right-1.5 -translate-y-1/2"
              onClick={() => {
                updateQuery("");
                inputRef.current?.focus();
              }}
            >
              <X aria-hidden />
            </Button>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col @[34rem]:flex-row">
        <nav
          aria-label={t("settings.search.categories")}
          className="flex shrink-0 gap-1 overflow-auto border-b p-2 @[34rem]:w-36 @[34rem]:flex-col @[34rem]:border-r @[34rem]:border-b-0"
        >
          {settingsPageSections.map(({ id }) => {
            const current = !searching && id === category;
            return (
              <Button
                key={id}
                type="button"
                variant="ghost"
                size="sm"
                aria-current={current || undefined}
                onClick={() => {
                  setCategory(id);
                  updateQuery("");
                }}
                className={cn(
                  "justify-start",
                  current ? "bg-selected text-foreground" : "text-muted-foreground",
                )}
              >
                {t(`settings.sections.${id}`)}
              </Button>
            );
          })}
        </nav>
        <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-5 py-4">
            {visibleRows.size === 0 && (
              <p role="status" className="text-muted-foreground py-2">{t("settings.search.noResults")}</p>
            )}
            <SettingsViewContext.Provider value={{ visibleRows, searching }}>
              {settingsPageSections.map(({ id, Component }) => (
                <section
                  key={id}
                  hidden={!visibleCategories.has(id)}
                  aria-labelledby={`${pageId}-${id}`}
                  className="mb-5 last:mb-0"
                >
                  <h3 id={`${pageId}-${id}`} className="text-muted-foreground border-b pb-1.5 text-xs font-semibold">
                    {t(`settings.sections.${id}`)}
                  </h3>
                  <div className="divide-y">
                    <Component />
                  </div>
                </section>
              ))}
            </SettingsViewContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
