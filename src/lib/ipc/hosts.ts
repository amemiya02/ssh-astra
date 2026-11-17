import { invoke } from "@tauri-apps/api/core";

/** Mirrors `sshastra_core::hosts::HostId`. */
export type HostId = string;

/** Mirrors `sshastra_core::hosts::GroupId`. */
export type GroupId = string;

/** Mirrors `sshastra_core::hosts::HostAuth`. */
export type HostAuth = { type: "password" };

/** A Host's editable fields (`sshastra_core::hosts::HostDraft`). */
export interface HostDraft {
  name: string;
  address: string;
  port: number;
  user: string;
  auth: HostAuth;
}

/** A saved Host (`sshastra_core::hosts::Host`). */
export interface Host extends HostDraft {
  id: HostId;
  /** The Group the Host sits in; null is the top level. Changed only by moving it. */
  groupId: GroupId | null;
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
