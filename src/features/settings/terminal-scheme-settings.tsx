import { Trash2, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { terminalSetting, type TerminalPrefs } from "@/features/terminal/terminal-prefs";
import { showToast } from "@/features/toasts/toastStore";
import { getSetting } from "@/lib/storage";
import { maxItermColorsKiB, parseItermColors } from "@/theme/iterm-colors";
import { terminalSchemeName, type ImportedTerminalScheme, type ImportedTerminalSchemeId } from "@/theme/terminal-themes";
import { SettingRow } from "./SettingRow";
import { settingRows } from "./setting-rows";

const schemeFileExtension = /\.itermcolors$/i;
const messageKey = "settings.terminal.importedSchemes";
type ImportResult = "imported" | "invalid" | "tooLarge" | "unreadable";

export function TerminalSchemeSettings({ importedSchemes, updatePrefs }: {
  importedSchemes: readonly ImportedTerminalScheme[];
  updatePrefs(patch: Partial<TerminalPrefs>): void;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const report = (result: ImportResult) => {
    showToast(
      (t) => t(`${messageKey}.${result}`, { max: maxItermColorsKiB }),
      result === "imported" ? "status" : "error",
    );
  };

  const importScheme = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > maxItermColorsKiB * 1024) {
      report("tooLarge");
      return;
    }
    if (!schemeFileExtension.test(file.name)) {
      report("invalid");
      return;
    }

    setImporting(true);
    try {
      const palette = parseItermColors(new Uint8Array(await file.arrayBuffer()));
      if (!palette) {
        report("invalid");
        return;
      }
      // Use the latest settings because another palette may be removed while the file is read.
      const { importedSchemes } = getSetting(terminalSetting);
      const names = new Set(importedSchemes.map(({ name }) => name.toLowerCase()));
      const baseName = terminalSchemeName(file.name.replace(schemeFileExtension, "")) || t(`${messageKey}.unnamed`);
      let name = baseName;
      for (let index = 2; names.has(name.toLowerCase()); index++) {
        name = `${Array.from(baseName).slice(0, 112).join("")} (${index})`;
      }
      const id = `imported:${crypto.randomUUID()}` as const;
      updatePrefs({ importedSchemes: [...importedSchemes, { id, name, palette }] });
      report("imported");
    } catch {
      report("unreadable");
    } finally {
      setImporting(false);
    }
  };

  const removeScheme = (id: ImportedTerminalSchemeId) => {
    const { importedSchemes } = getSetting(terminalSetting);
    updatePrefs({ importedSchemes: importedSchemes.filter((scheme) => scheme.id !== id) });
  };

  return (
    <SettingRow setting={settingRows.importedSchemes}>
      <div className="w-56 max-w-full space-y-2">
        {importedSchemes.length > 0 && (
          <ul aria-label={t(`${messageKey}.label`)}>
            {importedSchemes.map(({ id, name }) => (
              <li key={id} className="flex items-center justify-between gap-2 text-sm">
                <bdi className="truncate" title={name}>{name}</bdi>
                <IconButton
                  label={t(`${messageKey}.remove`, { name })}
                  type="button"
                  onClick={() => removeScheme(id)}
                >
                  <Trash2 />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".itermcolors"
          hidden
          onChange={(event) => void importScheme(event)}
        />
        <Button type="button" size="sm" variant="outline" disabled={importing} onClick={() => fileInput.current?.click()}>
          <Upload />
          {t(`${messageKey}.import`)}
        </Button>
      </div>
    </SettingRow>
  );
}
