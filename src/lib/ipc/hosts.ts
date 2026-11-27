import { Channel, invoke } from "@tauri-apps/api/core";
import type { AnsiHue } from "@/theme/monogram-ink";
import type { PortForward } from "./forwards";

/** Mirrors `sshastra_core::hosts::HostId`. */
export type HostId = string;

/** Mirrors `sshastra_core::hosts::GroupId`. */
export type GroupId = string;

/** Stable ids shared with `sshastra_core::hosts::HostIcon`. */
export const hostIcons = [
  "linux", "ubuntu", "archLinux", "alpineLinux", "linuxMint", "nixos", "freebsd", "macos",
  "server", "database", "cloud", "router",
] as const;
export type HostIcon = (typeof hostIcons)[number];

export type DetectedOs = Extract<HostIcon,
  "linux" | "ubuntu" | "archLinux" | "alpineLinux" | "linuxMint" | "nixos" | "freebsd" | "macos"
> | "debian" | "unknown";

/**
 * Mirrors `sshastra_core::hosts::HostAuth`. The server's allowed methods
 * determine whether a connect tries ssh-agent, then the default or specified
 * key files, then password and keyboard-interactive.
 */
export type HostAuth = { type: "auto" } | { type: "password" } | { type: "key"; identityFile: string };

export const agentPermissions = ["off", "read", "approval"] as const;
export type AgentPermission = (typeof agentPermissions)[number];

export type TerminalCharset = "utf8" | "gbk" | "big5" | "latin1";
export type TerminalBackspace = "del" | "ctrlH";

export type ProxyKind = "socks5" | "httpConnect";

export interface ProxyConfig {
  kind: ProxyKind;
  address: string;
  port: number;
  username?: string;
}

export type HostProxy =
  | { mode: "inherit" | "direct" }
  | { mode: "override"; config: ProxyConfig }
  | { mode: "proxyCommand"; config: string };

/** A Host's editable fields (`sshastra_core::hosts::HostDraft`). */
export interface HostDraft {
  name: string;
  address: string;
  port: number;
  user: string;
  auth: HostAuth;
  /** Organisational labels. An absent list is empty. */
  tags?: string[];
  /** User-selected icon. An absent value uses the automatic icon. */
  icon?: HostIcon;
  /** User-selected ANSI hue. An absent value uses the automatic hue. */
  color?: AnsiHue;
  /** With a selected key, restrict ssh-agent to its matching identity. */
  identitiesOnly?: boolean;
  /** Allow the remote host to use the local SSH agent during a Connection. */
  forwardAgent?: boolean;
  /** Offer legacy SSH algorithms as fallbacks. Off when absent. */
  allowLegacyAlgorithms?: boolean;
  /** Open a Terminal on this saved Host when the app starts. Off when absent. */
  openOnStartup?: boolean;
  /** Local Agent access for this saved Host. Off when absent. */
  agentAccess?: AgentPermission;
  /** Outbound proxy choice when this Host is the first hop. */
  proxy?: HostProxy;
  /** Seconds between keepalives; absent follows the global setting, 0 turns them off. */
  keepaliveSeconds?: number;
  /** Command typed once into each new Terminal shell. */
  postLoginCommand?: string;
  /** Character set for Terminal input and output; absent uses UTF-8. */
  terminalCharset?: TerminalCharset;
  /** Byte sent by the Terminal's Backspace key; absent uses DEL. */
  terminalBackspace?: TerminalBackspace;
  /** The Jump host this Host is reached through, or `null` to connect directly. */
  jumpHost: HostId | null;
  /** This Host's Terminal colour scheme id, overriding the global one; absent follows it. */
  terminalScheme?: string | null;
  /** Where a File panel on this Host opens the first time (`~/x` allowed); absent is home. */
  defaultDirectory?: string | null;
}

/** A saved remote folder (`sshastra_core::hosts::Bookmark`). */
export interface Bookmark {
  path: string;
  name?: string;
}

/** A saved Host (`sshastra_core::hosts::Host`). */
export interface Host extends HostDraft {
  id: HostId;
  /** Absent until detection has finished for this Host. */
  detectedOs?: DetectedOs;
  /** The Group the Host sits in; null is the top level. Changed only by moving it. */
  groupId: GroupId | null;
  /** Port forward rules, in the order added. Changed only through `saveForward` / `deleteForward`. */
  forwards: PortForward[];
  /** Bookmarks in the order added. Changed only through the Bookmark commands. */
  bookmarks?: Bookmark[];
}

/** The address parsed from Home or the command palette. The app supplies the local user. */
export interface QuickConnectTarget {
  address: string;
  port: number;
  user?: string;
}

export interface TemporaryHost extends Host {
  temporary: true;
}

export function isTemporaryHost(host: Host): host is TemporaryHost {
  return "temporary" in host && host.temporary === true;
}

export async function createTemporaryHost(target: QuickConnectTarget): Promise<TemporaryHost> {
  const host = await invoke<Host>("temporary_host_create", { target });
  return { ...host, temporary: true };
}

export function forgetTemporaryHost(hostId: HostId): Promise<void> {
  return invoke("temporary_host_forget", { hostId });
}

/** Persists the Temporary Host under the id of its live Connection. */
export function saveTemporaryHost(hostId: HostId, draft: HostDraft): Promise<Host> {
  return invoke<Host>("temporary_host_save", { hostId, draft });
}

/** A folder in the Host list (`sshastra_core::hosts::Group`). */
export interface Group {
  id: GroupId;
  name: string;
  /** null is the top level. */
  parentId: GroupId | null;
}

/** Every Group and Host; siblings are in display order (`sshastra_core::hosts::HostTree`). */
export interface HostTree {
  groups: Group[];
  hosts: Host[];
}

export function listHosts(): Promise<Host[]> {
  return invoke<Host[]>("hosts_list");
}

export interface HostOsChange {
  hostId: HostId;
  detectedOs: DetectedOs | null;
}

export function loadHostTree(onOsChange?: (event: HostOsChange) => void): Promise<HostTree> {
  return onOsChange
    ? invoke<HostTree>("host_tree_watch", { onOsChange: new Channel(onOsChange) })
    : invoke<HostTree>("host_tree");
}

export function redetectHostOs(id: HostId): Promise<void> {
  return invoke("host_redetect_os", { id });
}

/** Adds a Host (at the top level), or replaces the Host with `id`. */
export function saveHost(draft: HostDraft, id?: HostId): Promise<Host> {
  return invoke<Host>("host_save", { id: id ?? null, draft });
}

export function addBookmark(hostId: HostId, path: string): Promise<Bookmark> {
  return invoke("host_bookmark_add", { hostId, path });
}

export function renameBookmark(hostId: HostId, path: string, name: string): Promise<Bookmark> {
  return invoke("host_bookmark_rename", { hostId, path, name });
}

export function deleteBookmark(hostId: HostId, path: string): Promise<void> {
  return invoke("host_bookmark_delete", { hostId, path });
}

export function deleteHost(id: HostId): Promise<void> {
  return invoke("host_delete", { id });
}

/** Saves a copy of a Host as `name`, right after the original in its Group. */
export function duplicateHost(id: HostId, name: string): Promise<Host> {
  return invoke<Host>("host_duplicate", { id, name });
}

/** Moves a Host into `groupId` (null: top level) as its `index`-th Host. */
export function moveHost(id: HostId, groupId: GroupId | null, index: number): Promise<HostTree> {
  return invoke<HostTree>("host_move", { id, groupId, index });
}

/** Adds a Group at the end of `parentId` (null: top level). */
export function createGroup(name: string, parentId: GroupId | null): Promise<Group> {
  return invoke<Group>("group_create", { name, parentId });
}

export function renameGroup(id: GroupId, name: string): Promise<Group> {
  return invoke<Group>("group_rename", { id, name });
}

/** Deletes a Group; its Hosts and Groups move up into its parent. */
export function deleteGroup(id: GroupId): Promise<HostTree> {
  return invoke<HostTree>("group_delete", { id });
}

/** Moves a Group under `parentId` (null: top level) as its `index`-th Group. */
export function moveGroup(id: GroupId, parentId: GroupId | null, index: number): Promise<HostTree> {
  return invoke<HostTree>("group_move", { id, parentId, index });
}

/** Why an entry was left out (`sshastra_core::host_import::ImportProblem`). */
export type ImportProblem =
  | { kind: "invalidValue"; directive: string; value: string }
  | { kind: "unsupported"; directive: string }
  | { kind: "includeFailed"; reason: string }
  | { kind: "jumpChainConflict"; hop: string }
  | { kind: "jumpHostLoop" }
  | { kind: "jumpHostUnavailable"; hop: string }
  | { kind: "csvHeaders" | "csvInvalidPort" | "csvInvalidGroup" | "csvMalformedRecord" }
  | { kind: "csvMissingField"; field: string };

/** One thing an import left out (`sshastra_core::host_import::ImportIssue`). */
export interface ImportIssue {
  /** The OpenSSH Host alias or directive. CSV reports a line instead. */
  entry: string;
  line?: number;
  /** The whole Host was left out, not just part of it. */
  dropped: boolean;
  problem: ImportProblem;
}

/** What an import did, by Host name (`sshastra_core::hosts::ImportReport`). */
export interface ImportReport {
  imported: string[];
  /** Already saved under that name, so left alone. */
  skipped: string[];
  issues: ImportIssue[];
  proxyCommands: { host: string; command: string }[];
}

export type HostImportSource = { kind: "sshConfig" } | { kind: "csv"; path: string };

/** Imports Hosts from the chosen source, skipping names already taken. */
export function importHostSource(source: HostImportSource): Promise<{ tree: HostTree; report: ImportReport }> {
  return invoke("hosts_import_source", { source });
}

/** What an import added and left out (`sshastra_core::hosts::ImportSummary`). */
export interface ImportSummary {
  hostsAdded: number;
  groupsAdded: number;
  /** Names of Hosts not added because a Host with that name already exists. */
  skippedHosts: string[];
}

/** Writes the Host list and its Groups, Bookmarks and Port forwards to an export file at `path`. */
export function exportHosts(path: string): Promise<void> {
  return invoke("hosts_export", { path });
}

/** Adds the Groups and Hosts of the export file at `path`; returns what changed and the new tree. */
export function importHosts(path: string): Promise<{ summary: ImportSummary; tree: HostTree }> {
  return invoke("hosts_import", { path });
}
