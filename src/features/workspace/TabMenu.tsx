import { Palette, Pencil } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ansiHues } from "@/theme/monogram-ink";
import { tabId, type Tab, type TabCustomizationAction } from "./tabs";

export function TabMenu({ tab, title, onCustomize }: {
  tab: Tab;
  title: string;
  onCustomize(action: TabCustomizationAction): void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <>
      <ContextMenuContent className="min-w-44" onCloseAutoFocus={(event) => {
        if (draft !== null) event.preventDefault();
      }}>
        <ContextMenuItem onSelect={() => setDraft(title)}>
          <Pencil />
          {t("tabs.rename")}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger className="gap-2">
            <Palette />
            {t("tabs.color.label")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup value={tab.color ?? "automatic"} onValueChange={(value) => {
              onCustomize({ type: "setTabColor", id: tab.id, color: ansiHues.find((hue) => hue === value) });
            }}>
              <ContextMenuRadioItem value="automatic">{t("tabs.color.automatic")}</ContextMenuRadioItem>
              {ansiHues.map((hue) => (
                <ContextMenuRadioItem key={hue} value={hue}>
                  <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: `var(--ansi-${hue}-ink)` }} />
                  {t(`tabs.color.${hue}`)}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuCheckboxItem checked={tab.locked ?? false} onCheckedChange={(locked) => {
          onCustomize({ type: "setTabLocked", id: tab.id, locked });
        }}>
          {t("tabs.lock")}
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent showCloseButton={false} className="sm:max-w-100" onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(tabId(tab.id))?.focus();
        }}>
          <DialogHeader>
            <DialogTitle>{t("tabs.rename")}</DialogTitle>
            <DialogDescription>{t("tabs.renameHint")}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={(event) => {
            event.preventDefault();
            if (draft === null) return;
            onCustomize({ type: "renameTab", id: tab.id, title: draft });
            setDraft(null);
          }}>
            <Input value={draft ?? ""} aria-label={t("tabs.title")} onChange={(event) => setDraft(event.target.value)} />
            <DialogFooter>
              <DialogClose asChild><Button type="button" variant="outline">{t("tabs.cancel")}</Button></DialogClose>
              <Button type="submit">{t("tabs.save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
