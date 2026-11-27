import { showToast } from "@/features/toasts/toastStore";
import { readCommandError, type CommandError } from "@/lib/ipc/connect";
import * as ipc from "@/lib/ipc/edit";
import type { EditEvent, EditId } from "@/lib/ipc/edit";
import type { HostId } from "@/lib/ipc/hosts";

export type EditCommands = Pick<typeof ipc,
  "openRemoteEdit" | "closeRemoteEdit" | "retryRemoteEdit" | "overwriteRemoteEdit" | "openRemoteEditConflictCopy"
>;

/** The original uses its remote path. Each separately opened copy uses its edit ID. */
export type RemoteEditKey = string | EditId;
export type EditConflictAction = "overwrite" | "openRemote" | "cancel";

export interface RemoteEditItem {
  key: RemoteEditKey;
  path: string;
  name: string;
  id: EditId | null;
  status: "opening" | "editing" | "uploading" | "uploaded" | "uploadFailed" | "openFailed"
    | "conflict" | "conflictPaused" | "resolvingConflict";
  conflictId: number | null;
  error: CommandError | null;
}

type Panel = (item: RemoteEditItem) => void;

interface SharedEdit {
  item: RemoteEditItem;
  panels: Set<Panel>;
  opening?: Promise<void>;
  resolving?: boolean;
}

function publish(edit: SharedEdit, change: Partial<RemoteEditItem>) {
  edit.item = { ...edit.item, ...change };
  for (const panel of edit.panels) panel(edit.item);
}

/** Share each temp file's event channel and release it after the last pane. */
export function createSharedRemoteEdits(api: EditCommands, onUploadFailed?: (name: string, reason: string) => void) {
  const edits = new Map<string, SharedEdit>();
  const closing = new Map<string, Promise<void>>();

  function uploadFailed(edit: SharedEdit, error: CommandError) {
    if (!edit.panels.size) return;
    publish(edit, { status: "uploadFailed", error });
    onUploadFailed?.(edit.item.name, error.message);
  }

  function onEditEvent(edit: SharedEdit, event: EditEvent) {
    if (event.state === "applicationFallback") {
      if (edit.panels.size) showToast((t) => t("toast.editApplicationFallback", { name: edit.item.name }));
    } else if (event.state === "uploadFailed") {
      uploadFailed(edit, { kind: "uploadFailed", message: event.reason });
    } else if (event.state === "conflict") {
      const error = event.reason === undefined ? null : { kind: "uploadFailed", message: event.reason };
      publish(edit, { status: "conflict", conflictId: event.conflictId, error });
      if (error && edit.panels.size) onUploadFailed?.(edit.item.name, error.message);
    } else {
      publish(edit, { status: event.state, error: null, ...(event.state === "uploaded" && { conflictId: null }) });
    }
  }

  function releaseIfUnused(key: string, edit: SharedEdit) {
    if (edit.panels.size || edit.opening || edit.resolving || edits.get(key) !== edit) return;
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
    const keyFor = (key: RemoteEditKey) => JSON.stringify([hostId, key]);

    async function open(path: string, allowBinary = false) {
      const key = keyFor(path);
      let existing = edits.get(key);
      if (!existing) {
        existing = {
          item: { key: path, path, name: path.slice(path.lastIndexOf("/") + 1), id: null, status: "opening", conflictId: null, error: null },
          panels: new Set(),
        };
        edits.set(key, existing);
      }
      const edit = existing;
      edit.panels.add(panel);
      if (edit.item.status === "openFailed") publish(edit, { status: "opening", error: null });
      else panel(edit.item);
      if (edit.opening) return edit.opening;

      const show = async () => {
        const previousClose = closing.get(key);
        if (previousClose) await previousClose;
        if (!edit.panels.size) return;
        try {
          // Opening again brings the existing temp file to the foreground.
          const id = await api.openRemoteEdit(hostId, path, (event) => onEditEvent(edit, event), { allowBinary });
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

    async function resolveConflict(editKey: RemoteEditKey, action: EditConflictAction): Promise<boolean> {
      const key = keyFor(editKey);
      const edit = edits.get(key);
      if (!edit?.panels.has(panel) || edit.resolving) return false;
      const { id, conflictId, status } = edit.item;
      if (id === null || conflictId === null || (status !== "conflict" && status !== "conflictPaused")) return false;
      if (action === "cancel") {
        publish(edit, { status: "conflictPaused", error: null });
        return true;
      }

      edit.resolving = true;
      publish(edit, { status: "resolvingConflict", error: null });
      try {
        if (action === "overwrite") await api.overwriteRemoteEdit(id, conflictId);
        else {
          const earlyEvents: EditEvent[] = [];
          let handleCopyEvent = (event: EditEvent) => {
            earlyEvents.push(event);
          };
          const copyId = await api.openRemoteEditConflictCopy(id, conflictId, (event) => {
            handleCopyEvent(event);
          });
          const copy: SharedEdit = {
            item: { ...edit.item, key: copyId, id: copyId, status: "editing", conflictId: null, error: null },
            panels: new Set(edit.panels),
          };
          handleCopyEvent = (event) => onEditEvent(copy, event);
          const copyKey = keyFor(copyId);
          edits.set(copyKey, copy);
          publish(edit, { status: "conflictPaused" });
          for (const event of earlyEvents) onEditEvent(copy, event);
          publish(copy, {});
          releaseIfUnused(copyKey, copy);
        }
        return true;
      } catch (cause) {
        publish(edit, { status: "conflict", error: readCommandError(cause) });
        return false;
      } finally {
        edit.resolving = false;
        releaseIfUnused(key, edit);
      }
    }

    return {
      open,
      resolveConflict,
      isOpen: (path: string) => edits.get(keyFor(path))?.item.id != null,
      async retry(key: RemoteEditKey) {
        const edit = edits.get(keyFor(key));
        if (!edit?.panels.has(panel)) return;
        if (edit.item.id === null) return typeof key === "string" ? open(key) : undefined;
        if (edit.item.conflictId !== null) return;
        publish(edit, { status: "uploading", error: null });
        try {
          await api.retryRemoteEdit(edit.item.id);
        } catch (cause) {
          uploadFailed(edit, readCommandError(cause));
        }
      },
      release(editKey: RemoteEditKey) {
        const key = keyFor(editKey);
        const edit = edits.get(key);
        if (edit?.panels.delete(panel)) releaseIfUnused(key, edit);
      },
    };
  };
}

/** Shared by the dock and standalone SFTP workspaces in this window. */
export const sharedRemoteEdits = createSharedRemoteEdits(ipc, (name, reason) => {
  showToast((t) => t("toast.editUploadFailed", { name, reason }), "error");
});
