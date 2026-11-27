import { Copy, Palette, Pencil, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ansiHues } from "@/theme/monogram-ink";
import { canDuplicateTab, tabId, tabPanes, type Tab, type TabMenuAction } from "./tabs";

export function TabMenu({ tab, title, vertical, onAction }: {
  tab: Tab;
  title: string;
  vertical: boolean;
  onAction(action: TabMenuAction): void;
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
              onAction({ type: "setTabColor", id: tab.id, color: ansiHues.find((hue) => hue === value) });
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
          onAction({ type: "setTabLocked", id: tab.id, locked });
        }}>
          {t("tabs.lock")}
        </ContextMenuCheckboxItem>
        <ContextMenuItem disabled={!canDuplicateTab(tab)} onSelect={() => onAction({
          type: "duplicateTab",
          id: tab.id,
          tabId: crypto.randomUUID(),
          paneIds: tabPanes(tab).map(() => crypto.randomUUID()),
        })}>
          <Copy />
          {t("tabs.duplicate")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={tab.locked} onSelect={() => onAction({ type: "close", id: tab.id })}>
          <X />
          {t("tabs.closeTab")}
        </ContextMenuItem>
        <ContextMenuItem inset onSelect={() => onAction({ type: "closeOthers", id: tab.id })}>
          {t("tabs.closeOthers")}
        </ContextMenuItem>
        <ContextMenuItem inset onSelect={() => onAction({ type: "closeRight", id: tab.id })}>
          {t(vertical ? "tabs.closeBelow" : "tabs.closeRight")}
        </ContextMenuItem>
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
            onAction({ type: "renameTab", id: tab.id, title: draft });
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
