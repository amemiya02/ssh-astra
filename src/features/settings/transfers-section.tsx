import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { concurrencyChoices, transferSetting } from "@/features/transfers/transfer-settings";
import { useSetting } from "@/lib/storage";
import { SettingRow } from "./SettingRow";

export function TransfersSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useSetting(transferSetting);
  const label = t("settings.transfers.concurrency.label");
  // A hand-edited value outside the choices still shows, as its own option.
  const choices = concurrencyChoices.some((n) => n === settings.concurrency)
    ? [...concurrencyChoices]
    : [...concurrencyChoices, settings.concurrency].sort((a, b) => a - b);
  return (
    <SettingRow label={label} description={t("settings.transfers.concurrency.description")}>
      <SegmentedControl
        label={label}
        value={String(settings.concurrency)}
        options={choices.map((n) => ({ value: String(n), label: String(n) }))}
        onChange={(value) => setSettings({ ...settings, concurrency: Number(value) })}
      />
    </SettingRow>
  );
}
