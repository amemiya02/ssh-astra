import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useHosts } from "@/features/hosts/hostsStore";
import type { Host } from "@/lib/ipc/hosts";
import { watchSshLinks, type SshLinkTarget } from "@/lib/ipc/ssh-links";
import { matchSshLink } from "./ssh-links";

const maxPendingLinks = 16;

export function SshLinkConfirmation({ onConnect }: {
  onConnect(target: SshLinkTarget, host: Host | undefined): void;
}) {
  const { t } = useTranslation();
  const hosts = useHosts((state) => state.tree.hosts);
  const [links, setLinks] = useState<{ id: number; target: SshLinkTarget }[]>([]);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let nextId = 0;
    return watchSshLinks((targets) => {
      const arriving = targets.map((target) => ({ id: ++nextId, target }));
      setLinks((previous) => [...previous, ...arriving].slice(0, maxPendingLinks));
    });
  }, []);

  const link = links[0];
  if (!link) return null;
  const { id, target } = link;
  const host = matchSshLink(hosts, target);
  const dismiss = () => setLinks((previous) => previous.filter((entry) => entry.id !== id));
  return (
    <Dialog key={id} open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent showCloseButton={false} className="sm:max-w-100" onOpenAutoFocus={(event) => {
        event.preventDefault();
        cancel.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle>{t("sshLink.title")}</DialogTitle>
          <DialogDescription>
            {host ? t("sshLink.savedHost", { name: host.name }) : t("sshLink.quickConnect")}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("hosts.fields.address")}</dt>
          <dd className="font-mono break-all" dir="ltr">{target.address}</dd>
          <dt className="text-muted-foreground">{t("hosts.fields.port")}</dt>
          <dd className="font-mono">{target.port}</dd>
          <dt className="text-muted-foreground">{t("hosts.fields.user")}</dt>
          <dd className="font-mono break-all" dir="ltr">{target.user}</dd>
        </dl>
        <DialogFooter>
          <Button ref={cancel} variant="outline" onClick={dismiss}>{t("tabs.cancel")}</Button>
          <Button onClick={() => {
            dismiss();
            onConnect(target, host);
          }}>{t("sshLink.connect")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
