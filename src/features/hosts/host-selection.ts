import type { HostId } from "@/lib/ipc/hosts";

export interface HostSelection {
  anchor: HostId | null;
  ids: readonly HostId[];
}

export const emptyHostSelection: HostSelection = { anchor: null, ids: [] };

export function selectHost(
  selection: HostSelection,
  id: HostId,
  visibleIds: readonly HostId[],
  mode: "single" | "toggle" | "range",
): HostSelection {
  if (!visibleIds.includes(id)) return selection;
  if (mode === "single") return { anchor: id, ids: [id] };

  if (mode === "toggle") {
    const selected = new Set(selection.ids);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    return { anchor: id, ids: visibleIds.filter((row) => selected.has(row)) };
  }

  const anchor = selection.anchor === null ? -1 : visibleIds.indexOf(selection.anchor);
  if (anchor < 0) return { anchor: id, ids: [id] };
  const target = visibleIds.indexOf(id);
  return {
    anchor: selection.anchor,
    ids: visibleIds.slice(Math.min(anchor, target), Math.max(anchor, target) + 1),
  };
}
