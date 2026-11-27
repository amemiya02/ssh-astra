---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/features/shell","src/theme"]
---

Scope: the main window shell (src/App.tsx + src/features/shell, the nav rail, Home, tab strip, status bar) and the app theme system (src/theme). Mode: Operate.

Audience/job: developers and operators working in Terminals for hours, opening Hosts and moving files.

Constraint: redesign requested by the owner on 2026-11-27, replacing the ticket #3 "lit sheet on a tinted desk" world. The owner pinned the category standard: "仿照主流的terminal和ssh软件", benchmarked on Termius, Warp and WindTerm/MobaXterm, with whole-window themes. Pinned canon beats the roll, so concept-seed was not run. Defaults follow the system light/dark setting.

## Direction contract

THESIS: A themeable SSH workstation in the Termius/Warp mould: a nav rail, a Host vault, and Terminals that fill the window, where one theme recolours chrome and Terminal together. Refuses the old grey desk with floating white sheets and a single fixed palette.

OWN-WORLD: Thirteen whole-window themes (Astra Light/Dark, Tokyo Night, One Dark, Nord, Catppuccin Mocha/Latte, Dracula, Gruvbox Dark, Solarized Light/Dark, GitHub Light/Dark). Each theme names a ground, a sidebar, a surface, a raised layer, text, muted text, border, accent and state colours, and its own 16-colour Terminal palette; every other token is derived. Chrome sits on the theme's ground; the Terminal panel is the theme's Terminal background, flush, 8px radius, 1px border, no floating shadow in dark themes. System UI sans 13px; mono for Terminal, addresses, paths, fingerprints.

STORY: The user lands on Home, a Host vault of cards with recent Hosts first, types to filter, clicks a card and the Terminal fills the stage; files follow beside it; Connection state shows on the card, the tab and the status bar.

FIRST VIEWPORT: 48px nav rail far left (app mark; Hosts, SFTP, Port forwards; then Local terminal and Settings at the bottom), Host list column 248px, compact 34px tab strip (pill tabs, status dot, Host colour), Terminal filling the workspace with the File panel docked right, a 24px dense status bar with per-Host Connection segments, forwards, transfers, the active theme and Settings.

FORM: pinned canon (category standard played straight, at Termius/Warp/WindTerm craft level), position 1. No concept-seed roll ran: the owner pinned the canon in words, so there is no seed reference. Signature move: Host monograms and tab marks take their colour from the active theme's ANSI palette, and hovering a theme in the gallery previews it live across the whole window, Terminals included, before click commits.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
