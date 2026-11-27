import { X } from "lucide-react";
import { useId, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Host } from "@/lib/ipc/hosts";
import { appendHostTag, hasHostTag, hostTagNames, maxHostTags, maxTagLength, tagKey } from "./host-tags";

export function HostTagInput({ hosts, tags, value, onInput, onChange }: {
  hosts: Host[];
  tags: string[];
  value: string;
  onInput(input: string): void;
  onChange(tags: string[]): void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const names = useMemo(() => hostTagNames(hosts), [hosts]);
  const added = appendHostTag(tags, value);
  const add = () => {
    if (added === tags) return;
    onChange(added);
    onInput("");
    input.current?.focus();
  };

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">{t("hosts.tags.label")}</Label>
      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("hosts.tags.label")}>
          {tags.map((tag) => (
            <li key={tagKey(tag)} className="bg-muted flex h-6 min-w-0 max-w-full items-center gap-1 rounded-sm border pl-2 text-xs">
              <span className="truncate" title={tag}>{tag}</span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground rounded-sm"
                aria-label={t("hosts.tags.remove", { tag })}
                onClick={() => {
                  onChange(tags.filter((current) => current !== tag));
                  input.current?.focus();
                }}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          ref={input}
          id={id}
          className="h-8"
          list={`${id}-suggestions`}
          aria-describedby={`${id}-limits`}
          value={value}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key !== "Enter" || !value || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            event.preventDefault();
            add();
          }}
        />
        <datalist id={`${id}-suggestions`}>
          {names.filter((tag) => !hasHostTag(tags, tag)).map((tag) => <option key={tagKey(tag)} value={tag} />)}
        </datalist>
        <Button type="button" variant="outline" size="sm" disabled={added === tags} onClick={add}>
          {t("hosts.tags.add")}
        </Button>
      </div>
      <p id={`${id}-limits`} className="text-muted-foreground text-xs">
        {t("hosts.tags.limits", { maxTags: maxHostTags, maxLength: maxTagLength })}
      </p>
    </div>
  );
}
