import type { Pane, PaneLayout, SplitOrientation } from "./tabs";

export interface SplitDivider {
  /** Child indices from the root to the split. */
  path: readonly number[];
  /** The divider sits just after this child. */
  after: number;
}

export interface SplitResize extends SplitDivider {
  /** The first of the two adjacent children gets this fraction of their combined space. */
  fraction: number;
}

export function resizePaneLayout(layout: PaneLayout, { path, after, fraction }: SplitResize): PaneLayout {
  if (layout.type !== "split" || !(fraction > 0 && fraction < 1)) return layout;

  const [index, ...rest] = path;
  if (index !== undefined) {
    const child = layout.children[index];
    if (!child) return layout;
    const next = resizePaneLayout(child.layout, { path: rest, after, fraction });
    if (next === child.layout) return layout;
    return { ...layout, children: layout.children.map((child, at) => at === index ? { ...child, layout: next } : child) };
  }

  const before = layout.children[after];
  const next = layout.children[after + 1];
  if (!before || !next) return layout;
  const combined = before.ratio + next.ratio;
  const ratio = combined * fraction;
  if (ratio <= 0 || ratio >= combined || ratio === before.ratio) return layout;
  const children = [...layout.children];
  children[after] = { ...before, ratio };
  children[after + 1] = { ...next, ratio: combined - ratio };
  return { ...layout, children };
}

/** Coordinates are fractions of the whole tab. */
export interface PaneBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PositionedDivider extends SplitDivider {
  id: string;
  orientation: SplitOrientation;
  bounds: PaneBounds;
  /** The two adjacent children together span this fraction of the tab on the split axis. */
  span: number;
  fraction: number;
  paneIds: string[];
}

/** A flat projection keeps each live Terminal under the same React and DOM parent. */
export function positionPanes(layout: PaneLayout) {
  const panes: { pane: Pane; bounds: PaneBounds }[] = [];
  const dividers: PositionedDivider[] = [];

  function place(node: PaneLayout, bounds: PaneBounds, path: number[]): string[] {
    if (node.type === "pane") {
      panes.push({ pane: node.pane, bounds });
      return [node.pane.id];
    }

    const horizontal = node.orientation === "horizontal";
    const size = horizontal ? bounds.width : bounds.height;
    let offset = 0;
    const placed = node.children.map((child, index) => {
      const childBounds = horizontal
        ? { ...bounds, left: bounds.left + size * offset, width: size * child.ratio }
        : { ...bounds, top: bounds.top + size * offset, height: size * child.ratio };
      offset += child.ratio;
      return { paneIds: place(child.layout, childBounds, [...path, index]), childBounds, ratio: child.ratio };
    });

    for (let after = 0; after < placed.length - 1; after++) {
      const before = placed[after]!;
      const next = placed[after + 1]!;
      const combined = before.ratio + next.ratio;
      dividers.push({
        id: JSON.stringify([before.paneIds, next.paneIds]),
        path,
        after,
        orientation: node.orientation,
        bounds: horizontal
          ? { ...bounds, left: next.childBounds.left, width: 0 }
          : { ...bounds, top: next.childBounds.top, height: 0 },
        span: size * combined,
        fraction: before.ratio / combined,
        paneIds: before.paneIds,
      });
    }
    return placed.flatMap((child) => child.paneIds);
  }

  place(layout, { left: 0, top: 0, width: 1, height: 1 }, []);
  return { panes, dividers };
}
