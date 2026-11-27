import { Bookmark as BookmarkIcon, Star } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/IconButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { hostsStore, useHosts } from "@/features/hosts/hostsStore";
import { showToast } from "@/features/toasts/toastStore";
import type { Bookmark, HostId } from "@/lib/ipc/hosts";

/** The current directory's star and the saved Host's Bookmark menu. */
export function FileBookmarks({ hostId, path, onNavigate }: {
  hostId: HostId;
  path: string;
  onNavigate(path: string): void;
}) {
  const { t } = useTranslation();
  const host = useHosts((s) => s.tree.hosts.find((item) => item.id === hostId));
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [pending, setPending] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const afterMenuClose = useRef<(() => void) | null>(null);
  if (!host) return null;
  const bookmarks = host.bookmarks ?? [];
  const starred = bookmarks.some((bookmark) => bookmark.path === path);
  const toggle = async () => {
    const { addBookmark, deleteBookmark } = hostsStore.getState();
    setPending(true);
    try {
      if (starred) await deleteBookmark(hostId, path);
      else await addBookmark(hostId, path);
    } catch {
      showToast((t) => t("files.bookmarks.saveFailed"), "error");
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <IconButton type="button" label={t("files.bookmarks.star")} className="size-6"
        aria-pressed={starred} aria-disabled={pending || undefined}
        onClick={() => { if (!pending) void toggle(); }}>
        <Star className={starred ? "fill-current text-ansi-yellow-ink" : undefined} />
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton ref={trigger} type="button" label={t("files.bookmarks.menu")} className="size-6">
            <BookmarkIcon />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-[min(20rem,90vw)]"
          onCloseAutoFocus={(event) => {
            const action = afterMenuClose.current;
            if (!action) return;
            afterMenuClose.current = null;
            event.preventDefault();
            action();
          }}>
          {bookmarks.length === 0 ? <DropdownMenuLabel>{t("files.bookmarks.empty")}</DropdownMenuLabel>
            : bookmarks.map((bookmark) => (
              <DropdownMenuItem key={bookmark.path} title={bookmark.path}
                aria-current={bookmark.path === path ? "location" : undefined} onSelect={() => {
                  afterMenuClose.current = () => onNavigate(bookmark.path);
                }}>
                <BookmarkText bookmark={bookmark} />
              </DropdownMenuItem>
            ))}
          {bookmarks.length > 0 && <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("files.bookmarks.manage")}</DropdownMenuSubTrigger>
              <DropdownMenuPortal>
                <DropdownMenuSubContent className="max-h-(--radix-dropdown-menu-content-available-height) max-w-[min(20rem,90vw)] overflow-y-auto">
                  {bookmarks.map((bookmark) => (
                    <DropdownMenuItem key={bookmark.path} title={bookmark.path} onSelect={() => {
                      afterMenuClose.current = () => setEditing(bookmark);
                    }}>
                      <BookmarkText bookmark={bookmark} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuPortal>
            </DropdownMenuSub>
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
      {editing && <EditBookmark hostId={hostId} bookmark={editing} onClose={() => setEditing(null)}
        restoreFocus={() => trigger.current?.focus()} />}
    </>
  );
}

function BookmarkText({ bookmark }: { bookmark: Bookmark }) {
  return bookmark.name ? (
    <span className="min-w-0">
      <span className="block truncate">{bookmark.name}</span>
      <span className="text-muted-foreground block truncate font-mono text-xs">{bookmark.path}</span>
    </span>
  ) : <span className="truncate font-mono">{bookmark.path}</span>;
}

function EditBookmark({ hostId, bookmark, onClose, restoreFocus }: {
  hostId: HostId;
  bookmark: Bookmark;
  onClose(): void;
  restoreFocus(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(bookmark.name ?? "");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = async (remove: boolean) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const { renameBookmark, deleteBookmark } = hostsStore.getState();
      if (remove) await deleteBookmark(hostId, bookmark.path);
      else await renameBookmark(hostId, bookmark.path, name);
      onClose();
    } catch {
      setFailed(true);
      setPending(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent showCloseButton={false} onCloseAutoFocus={(event) => {
        event.preventDefault();
        restoreFocus();
      }}>
        <DialogHeader>
          <DialogTitle>{t("files.bookmarks.edit")}</DialogTitle>
          <DialogDescription className="font-mono break-all">{bookmark.path}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void save(false);
        }}>
          <Input aria-label={t("files.bookmarks.name")} placeholder={t("files.bookmarks.name")}
            value={name} onChange={(event) => setName(event.target.value)} readOnly={pending} />
          {failed && <p role="alert" className="text-destructive text-xs">{t("files.bookmarks.saveFailed")}</p>}
          <DialogFooter>
            <Button type="button" variant="destructive" className="sm:mr-auto" disabled={pending}
              onClick={() => void save(true)}>{t("files.bookmarks.remove")}</Button>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t("files.cancel")}</Button>
            <Button type="submit" disabled={pending}>{t("files.bookmarks.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
