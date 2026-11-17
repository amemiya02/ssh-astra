---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/features/shell"]
---

Scope: the main window shell (src/App.tsx + src/features/shell). Mode: Operate.

Audience/job: developers and operators working in Terminals for hours, opening Hosts and moving files.

Constraint: direction pinned by the owner in ticket #3 (Termius/Linear restraint: large radii, thin borders, soft shadows, moderate density). Pinned direction beats the roll, so concept-seed was not run.

## Direction contract

THESIS: The Terminal is a lit sheet laid on a quiet desk. Chrome (Host list, tab strip, status bar) shares one tinted ground; work surfaces (Terminal, File panel) are rounded panels floating on it. Refuses the default of edge-to-edge grey panes divided by heavy rules.

OWN-WORLD: Cool-tinted neutrals (hue 255) for chrome, white or near-black panels, one Astra blue accent for primary actions, selection and focus only. Green/amber/red are Connection states. 10px panel radius, 14px dialogs, 1px borders, soft shadow in light and border-led depth in dark. System UI sans at 13px; mono only for Terminal, paths, fingerprints.

STORY: The user sees their Hosts, opens one, and the Terminal fills the stage; files sit beside it; state is always legible in tab dots and the status bar.

FIRST VIEWPORT: Left 248px Host list on the ground (title, add, collapse, search, groups, Local terminal at the bottom). Right: tab strip on the ground; the active tab is cut from the Terminal panel (same colour, joined edge). Terminal panel fills; File panel docked right (340px) or bottom, collapsible; 26px status bar across the bottom.

FORM: pinned direction (Termius/Linear restraint), position 1. Roll skipped: the owner pinned the direction in ticket #3, so concept-seed was deliberately not run (no seed reference). Adaptation: the Host list collapse toggle sits at the start of the tab strip so it stays reachable while the list is collapsed.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
