import { invoke } from "@tauri-apps/api/core";
import type { PortForward } from "./forwards";

/** Mirrors `sshastra_core::hosts::HostId`. */
export type HostId = string;

/** Mirrors `sshastra_core::hosts::GroupId`. */
export type GroupId = string;

/**
 * Mirrors `sshastra_core::hosts::HostAuth`. Either way a connect tries
 * ssh-agent, then the key file (if any), then password, then
 * keyboard-interactive, as far as the server allows.
 */
export type HostAuth = { type: "password" } | { type: "key"; identityFile: string };

/** A Host's editable fields (`sshastra_core::hosts::HostDraft`). */
export interface HostDraft {
  name: string;
  address: string;
  port: number;
  user: string;
  auth: HostAuth;
  /** The Jump host this Host is reached through, or `null` to connect directly. */
  jumpHost: HostId | null;
  /** This Host's Terminal colour scheme id, overriding the global one; absent follows it. */
  terminalScheme?: string | null;
}

/** A saved Host (`sshastra_core::hosts::Host`). */
export interface Host extends HostDraft {
  id: HostId;
  /** The Group the Host sits in; null is the top level. Changed only by moving it. */
  groupId: GroupId | null;
  /** Port forward rules, in the order added. Changed only through `saveForward` / `deleteForward`. */
  forwards: PortForward[];
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

export function loadHostTree(): Promise<HostTree> {
  return invoke<HostTree>("host_tree");
}

/** Adds a Host (at the top level), or replaces the Host with `id`. */
export function saveHost(draft: HostDraft, id?: HostId): Promise<Host> {
  return invoke<Host>("host_save", { id: id ?? null, draft });
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

/** Why part of `~/.ssh/config` was not imported (`sshastra_core::ssh_config::ImportProblem`). */
export type ImportProblem =
  | { kind: "invalidValue"; directive: string; value: string }
  | { kind: "unsupported"; directive: string }
  | { kind: "includeFailed"; reason: string }
  | { kind: "jumpChainConflict"; hop: string }
  | { kind: "jumpHostLoop" }
  | { kind: "jumpHostUnavailable"; hop: string };

/** One thing an import left out (`sshastra_core::ssh_config::ImportIssue`). */
export interface ImportIssue {
  /** The Host alias, or the `Include` / `Match` line. */
  entry: string;
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
}

/**
 * Imports the Hosts in `~/.ssh/config` (and its `Include`s) at the top level, skipping names
 * already taken. Returns the whole Host list and the report.
 */
export function importSshConfig(): Promise<{ tree: HostTree; report: ImportReport }> {
  return invoke("hosts_import_ssh_config");
}

/** What an import added and left out (`sshastra_core::hosts::ImportSummary`). */
export interface ImportSummary {
  hostsAdded: number;
  groupsAdded: number;
  /** Names of Hosts not added because a Host with that name already exists. */
  skippedHosts: string[];
}

/** Writes the whole Host list (Groups, Hosts, Port forwards; never credentials) to an export file at `path`. */
export function exportHosts(path: string): Promise<void> {
  return invoke("hosts_export", { path });
}

/** Adds the Groups and Hosts of the export file at `path`; returns what changed and the new tree. */
export function importHosts(path: string): Promise<{ summary: ImportSummary; tree: HostTree }> {
  return invoke("hosts_import", { path });
}
