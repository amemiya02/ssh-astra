import { useTranslation } from "react-i18next";
import { settingsPageSections } from "./sections";

/**
 * The Settings tab. Every change applies at once and is saved to the settings file;
 * there is no Save button.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="text-foreground h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <h2 className="text-lg font-semibold">{t("settings.title")}</h2>
        <p className="text-muted-foreground mt-0.5">{t("settings.lead")}</p>
        {settingsPageSections.map(({ id, title, Component }) => (
          <section key={id} aria-labelledby={`settings-${id}`} className="mt-6">
            <h3 id={`settings-${id}`} className="text-muted-foreground border-b pb-1.5 text-xs font-semibold">
              {t(`settings.sections.${title}`)}
            </h3>
            <div className="divide-y">
              <Component />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
