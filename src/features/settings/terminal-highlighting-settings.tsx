import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  isValidHighlightPattern,
  maxCustomHighlightRules,
  type CustomHighlightRule,
  type TerminalHighlighting,
} from "@/features/terminal/terminal-highlighting";
import { terminalSetting, type TerminalPrefs } from "@/features/terminal/terminal-prefs";
import { getSetting } from "@/lib/storage";
import { ansiHues } from "@/theme/monogram-ink";
import { SettingRow } from "./SettingRow";

const selectClass = "h-8 min-w-0 rounded-md border border-input bg-surface px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function RuleRow({ rule, autoFocus, onChange, onRemove }: {
  rule: CustomHighlightRule;
  autoFocus: boolean;
  onChange(patch: Partial<CustomHighlightRule>): void;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState<Pick<CustomHighlightRule, "kind" | "pattern"> | null>(null);
  const { kind, pattern } = draft ?? rule;
  const invalid = pattern.length > 0 && !isValidHighlightPattern(kind, pattern);

  const commit = () => {
    if (draft === null || invalid) return;
    setDraft(null);
    if (draft.pattern !== rule.pattern || draft.kind !== rule.kind) onChange(draft);
  };

  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoFocus={autoFocus}
          aria-label={t("settings.terminal.highlighting.pattern")}
          placeholder={t("settings.terminal.highlighting.pattern")}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? id : undefined}
          value={pattern}
          onChange={(event) => setDraft({ kind, pattern: event.target.value })}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setDraft(null);
          }}
          className="h-8 min-w-32 flex-1 font-mono"
          spellCheck={false}
          autoComplete="off"
        />
        <div className="flex shrink-0 items-center gap-2">
          <select
            aria-label={t("settings.terminal.highlighting.kind")}
            className={selectClass}
            value={kind}
            onChange={(event) => {
              const next = { kind: event.target.value === "regex" ? "regex" : "text", pattern } as const;
              if (pattern && !isValidHighlightPattern(next.kind, pattern)) {
                setDraft(next);
              } else {
                onChange(next);
                setDraft(null);
              }
            }}
          >
            <option value="text">{t("settings.terminal.highlighting.text")}</option>
            <option value="regex">{t("settings.terminal.highlighting.regex")}</option>
          </select>
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: `var(--ansi-${rule.hue})` }} />
            <select
              aria-label={t("settings.terminal.highlighting.color")}
              className={selectClass}
              value={rule.hue}
              onChange={(event) => {
                const hue = ansiHues.find((value) => value === event.target.value);
                if (hue) onChange({ hue });
              }}
            >
              {ansiHues.map((hue) => <option key={hue} value={hue}>{t(`settings.terminal.highlighting.colors.${hue}`)}</option>)}
            </select>
          </div>
          <Checkbox
            aria-label={t("settings.terminal.highlighting.enabled")}
            checked={rule.enabled}
            onCheckedChange={(checked) => onChange({ enabled: checked === true })}
          />
          <Button
            aria-label={t("settings.terminal.highlighting.remove")}
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {invalid && <p id={id} role="status" className="text-destructive text-xs">{t("settings.terminal.highlighting.invalidRegex")}</p>}
    </li>
  );
}

export function TerminalHighlightingSettings({ config, updatePrefs }: {
  config: TerminalHighlighting;
  updatePrefs(patch: Partial<TerminalPrefs>): void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const [addedId, setAddedId] = useState<string>();
  const builtInLabel = t("settings.terminal.highlighting.builtIn.label");

  const update = (change: (current: TerminalHighlighting) => TerminalHighlighting) =>
    updatePrefs({ highlighting: change(getSetting(terminalSetting).highlighting) });
  const updateRules = (change: (rules: CustomHighlightRule[]) => CustomHighlightRule[]) =>
    update((current) => ({ ...current, rules: change(current.rules) }));

  return (
    <div className="py-3" role="group" aria-labelledby={headingId}>
      <p id={headingId} className="font-medium">{t("settings.terminal.highlighting.label")}</p>
      <SettingRow label={builtInLabel} description={t("settings.terminal.highlighting.builtIn.description")}>
        <SegmentedControl
          label={builtInLabel}
          value={config.builtIn ? "on" : "off"}
          options={[
            { value: "on", label: t("settings.on") },
            { value: "off", label: t("settings.off") },
          ]}
          onChange={(next) => update((current) => ({ ...current, builtIn: next === "on" }))}
        />
      </SettingRow>
      <p className="text-muted-foreground mb-2 text-xs">
        {t("settings.terminal.highlighting.description", { max: maxCustomHighlightRules })}
      </p>
      {config.rules.length > 0 && (
        <ul className="mb-2 space-y-2" aria-label={t("settings.terminal.highlighting.custom")}>
          {config.rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              autoFocus={rule.id === addedId}
              onChange={(patch) => updateRules((rules) => rules.map((item) => item.id === rule.id ? { ...item, ...patch } : item))}
              onRemove={() => updateRules((rules) => rules.filter((item) => item.id !== rule.id))}
            />
          ))}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={config.rules.length >= maxCustomHighlightRules}
        onClick={() => {
          const id = crypto.randomUUID();
          setAddedId(id);
          updateRules((rules) => [...rules, { id, pattern: "", kind: "text", hue: "cyan", enabled: true }]);
        }}
      >
        <Plus />
        {t("settings.terminal.highlighting.add")}
      </Button>
    </div>
  );
}
