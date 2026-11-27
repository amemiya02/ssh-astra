import type { TFunction } from "i18next";
import { ArrowRightLeft, Copy, FolderInput, Pencil, PlugZap, SquareTerminal, Trash2, Unplug } from "lucide-react";
import type { Host } from "@/lib/ipc/hosts";
import type { HostListActions } from "./HostList";
import type { MenuEntry } from "./RowMenu";

/**
 * What a Host's right-click and "More actions" menus offer, in the Host list and on Home alike.
 * `moveTo` (the Group picker) is only the Host list's: Home has no tree to move within.
 */
export function hostMenuEntries(
  host: Host,
  actions: HostListActions,
  t: TFunction,
  moveTo?: MenuEntry[],
): MenuEntry[] {
  return [
    { type: "item", label: t("hosts.open"), icon: <SquareTerminal />, onSelect: () => actions.open(host) },
    { type: "item", label: t("sftp.open"), icon: <ArrowRightLeft />, onSelect: () => actions.openSftp(host) },
    actions.isHeld(host)
      ? { type: "item", label: t("hosts.disconnect"), icon: <Unplug />, onSelect: () => actions.disconnect(host) }
      : { type: "item", label: t("hosts.connectOnly"), icon: <PlugZap />, onSelect: () => actions.connectOnly(host) },
    { type: "item", label: t("hosts.portForwards"), icon: <ArrowRightLeft />, onSelect: () => actions.openForwards(host) },
    { type: "item", label: t("hosts.edit"), icon: <Pencil />, onSelect: () => actions.edit(host) },
    { type: "item", label: t("hosts.duplicate"), icon: <Copy />, onSelect: () => actions.duplicate(host) },
    ...(moveTo ? [{ type: "sub", label: t("hosts.moveTo"), icon: <FolderInput />, entries: moveTo } satisfies MenuEntry] : []),
    { type: "separator" },
    {
      type: "item",
      label: t("hosts.delete"),
      icon: <Trash2 />,
      destructive: true,
      onSelect: () => actions.remove({ kind: "host", host }),
    },
  ];
}
