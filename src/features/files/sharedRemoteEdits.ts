import { readCommandError, type CommandError } from "@/lib/ipc/connect";
import * as ipc from "@/lib/ipc/edit";
import type { EditEvent, EditId } from "@/lib/ipc/edit";
import type { HostId } from "@/lib/ipc/hosts";

export type EditCommands = Pick<typeof ipc, "openRemoteEdit" | "closeRemoteEdit" | "retryRemoteEdit">;

export interface RemoteEditItem {
  path: string;
  name: string;
  id: EditId | null;
  status: "opening" | "editing" | "uploading" | "uploaded" | "uploadFailed" | "openFailed";
  error: CommandError | null;
}

type Panel = (item: RemoteEditItem) => void;

interface SharedEdit {
  item: RemoteEditItem;
  panels: Set<Panel>;
  opening?: Promise<void>;
}

function publish(edit: SharedEdit, change: Partial<RemoteEditItem>) {
  edit.item = { ...edit.item, ...change };
  for (const panel of edit.panels) panel(edit.item);
}

/** Rust owns one temp file per Host and path. Share its event channel and release it after the last pane. */
export function createSharedRemoteEdits(api: EditCommands) {
  const edits = new Map<string, SharedEdit>();
  const closing = new Map<string, Promise<void>>();

  function releaseIfUnused(key: string, edit: SharedEdit) {
    if (edit.panels.size || edit.opening || edits.get(key) !== edit) return;
    edits.delete(key);
    if (edit.item.id !== null) {
      // A new open must not reuse a Rust ID whose close is still in flight.
      const done = api.closeRemoteEdit(edit.item.id)
        .catch(() => {})
        .finally(() => closing.delete(key));
      closing.set(key, done);
    }
  }

  return function forPanel(hostId: HostId, panel: Panel) {
    const keyFor = (path: string) => JSON.stringify([hostId, path]);

    async function open(path: string, allowBinary = false) {
      const key = keyFor(path);
      let existing = edits.get(key);
      if (!existing) {
        existing = {
          item: { path, name: path.slice(path.lastIndexOf("/") + 1), id: null, status: "opening", error: null },
          panels: new Set(),
        };
        edits.set(key, existing);
      }
      const edit = existing;
      edit.panels.add(panel);
      if (edit.item.status === "openFailed") publish(edit, { status: "opening", error: null });
      else panel(edit.item);
      if (edit.opening) return edit.opening;

      const onEvent = (event: EditEvent) => {
        publish(edit, {
          status: event.state,
          error: event.state === "uploadFailed" ? { kind: "uploadFailed", message: event.reason } : null,
        });
      };
      const show = async () => {
        const previousClose = closing.get(key);
        if (previousClose) await previousClose;
        if (!edit.panels.size) return;
        try {
          // Opening again brings the existing temp file to the foreground.
          const id = await api.openRemoteEdit(hostId, path, onEvent, { allowBinary });
          publish(edit, { id, status: edit.item.status === "opening" ? "editing" : edit.item.status });
        } catch (cause) {
          if (edit.item.id === null) publish(edit, { status: "openFailed", error: readCommandError(cause) });
        }
      };
      edit.opening = show().finally(() => {
        edit.opening = undefined;
        releaseIfUnused(key, edit);
      });
      return edit.opening;
    }

    return {
      open,
      isOpen: (path: string) => edits.get(keyFor(path))?.item.id != null,
      async retry(path: string) {
        const edit = edits.get(keyFor(path));
        if (!edit?.panels.has(panel)) return;
        if (edit.item.id === null) return open(path);
        publish(edit, { status: "uploading", error: null });
        try {
          await api.retryRemoteEdit(edit.item.id);
        } catch (cause) {
          publish(edit, { status: "uploadFailed", error: readCommandError(cause) });
        }
      },
      release(path: string) {
        const key = keyFor(path);
        const edit = edits.get(key);
        if (edit?.panels.delete(panel)) releaseIfUnused(key, edit);
      },
    };
  };
}

/** Shared by the dock and standalone SFTP workspaces in this window. */
export const sharedRemoteEdits = createSharedRemoteEdits(ipc);
