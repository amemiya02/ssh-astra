---
name: SSH Astra
description: A themeable SSH workstation in the Termius/Warp mould, where one theme recolours the chrome and the Terminal together.
colors:
  ground: "#f4f6fa"
  sidebar: "#eceff5"
  surface: "#ffffff"
  raised: "#ffffff"
  foreground: "#151a26"
  muted-foreground: "#566175"
  border: "#dfe4ed"
  primary: "#2d62d8"
  primary-foreground: "#ffffff"
  success: "#1f8a4c"
  warning: "#a86a00"
  destructive: "#c4372f"
  muted: "#e5e7ec"
  accent: "#dde0e5"
  input: "#bdc0c7"
  selected: "#2d62d824"
  overlay: "#151a264d"
  terminal-background: "#ffffff"
  terminal-foreground: "#2b2f37"
  ansi-red: "#c4372f"
  ansi-green: "#1f8a4c"
  ansi-yellow: "#946200"
  ansi-blue: "#2f5fd0"
  ansi-magenta: "#a33ea1"
  ansi-cyan: "#12808f"
  ground-dark: "#0e121b"
  sidebar-dark: "#0a0d14"
  surface-dark: "#131825"
  raised-dark: "#1a2132"
  foreground-dark: "#e3e7f0"
  muted-foreground-dark: "#98a2b8"
  border-dark: "#222a3b"
  primary-dark: "#6f9cf6"
  primary-foreground-dark: "#0a1020"
  success-dark: "#5fc98a"
  warning-dark: "#e0b45a"
  destructive-dark: "#f0707a"
  muted-dark: "#181c25"
  accent-dark: "#1d212b"
  input-dark: "#353a43"
  selected-dark: "#6f9cf624"
  overlay-dark: "#0a0d14b8"
  terminal-background-dark: "#0b0f17"
  terminal-foreground-dark: "#d9dce3"
  ansi-red-dark: "#f07178"
  ansi-green-dark: "#6fcf8f"
  ansi-yellow-dark: "#e0b45a"
  ansi-blue-dark: "#7aa2f7"
  ansi-magenta-dark: "#d08bd8"
  ansi-cyan-dark: "#66c7d4"
typography:
  title-dialog:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, \"Noto Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "22px"
  title-empty:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, \"Noto Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "22px"
  title-panel:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, \"Noto Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "20px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, \"Noto Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, \"Noto Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: "16px"
  monogram:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, \"Noto Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1
  mono-address:
    fontFamily: "ui-monospace, \"SF Mono\", \"JetBrains Mono\", Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: "16px"
  mono-terminal:
    fontFamily: "ui-monospace, \"SF Mono\", \"JetBrains Mono\", Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
spacing:
  gutter: "6px"
  nav-rail: "48px"
  sidebar: "248px"
  chrome-row: "34px"
  tab: "28px"
  status-bar: "24px"
  icon-button: "26px"
  rail-button: "36px"
  host-row: "30px"
  host-card: "56px"
components:
  nav-rail:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.muted-foreground}"
    width: "48px"
  rail-button:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.lg}"
    size: "36px"
  rail-button-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
  rail-button-current:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.primary}"
  tab:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.lg}"
    height: "28px"
    padding: "0 4px 0 10px"
  tab-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "28px"
  terminal-panel:
    backgroundColor: "{colors.terminal-background}"
    textColor: "{colors.terminal-foreground}"
    rounded: "{rounded.lg}"
  file-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  host-row:
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "30px"
    padding: "0 32px 0 8px"
  host-row-selected:
    backgroundColor: "{colors.selected}"
  host-card:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "56px"
    padding: "0 36px 0 12px"
  host-card-hover:
    backgroundColor: "{colors.accent}"
  status-bar:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label}"
    height: "24px"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-outline:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-ghost-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.ground}"
    rounded: "{rounded.md}"
    height: "32px"
  icon-button:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
    size: "26px"
  icon-button-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
  input:
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "4px 12px"
  menu:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "4px"
  tooltip:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.ground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  dialog:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "24px"
    width: "512px"
  theme-card:
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "6px"
  theme-card-checked:
    backgroundColor: "{colors.selected}"
---

# Design System: SSH Astra

## Overview

**Creative North Star: "One theme, the whole workstation"**

SSH Astra plays the category standard straight: the Termius / Warp / WindTerm workstation. A 48px nav rail on the far left, a Host vault (a 248px Host list column, and Home's grid of Host cards), compact pill tabs, Terminals that fill the stage with the File panel docked beside them, and a dense 24px status bar. Nothing about the layout tries to be novel; the craft is in density, alignment and state.

The identity is the theme model. Thirteen whole-window themes ship, and a theme is never just a Terminal scheme: it names the ground, sidebar, surface, raised layer, text, muted text, border, accent and state colours of the chrome *and* the Terminal's 16-colour palette, and every other token derives from those. Switching theme recolours the window and the open Terminals that follow it in one frame; hovering a theme in the gallery previews it live across the whole window before a click commits. Host monograms and tab marks take their colour from the active theme's ANSI hues, so each Host keeps a stable identity that still belongs to whatever theme is painted.

Density is desktop density: 13px body, 26px icon buttons, 28px tabs, 30px Host rows, 24px status bar. Light and dark are equal citizens; the default follows the OS appearance, with a separately chosen light theme and dark theme. The world replaces the earlier "lit sheet on a tinted desk" system: there is no grey desk with floating white sheets any more, and no single fixed palette.

**Key Characteristics:**
- Thirteen whole-window themes; one theme paints chrome and Terminal together.
- Twelve named roles per theme plus a full Terminal palette; everything else is derived in `src/index.css`.
- Rail and Host list share the sidebar colour; tabs, gutters and status bar sit on the ground.
- Work panels are flush, bordered and 10px rounded; they do not float on shadows.
- Host identity is an ANSI hue (monogram tile, tab underline); Connection state is green, amber, red.
- System UI sans at 13px; mono only where characters must be exact.

## Colors

Every colour is a role in a theme, not a fixed value: the frontmatter carries Astra Light (unsuffixed) and Astra Dark (`-dark`), the two defaults; the other eleven themes live only in `src/theme/themes.ts`.

### The theme model
`src/theme/themes.ts` defines each `AppTheme` as `{ id, name, appearance, ui, terminal }`. `applyTheme` (`src/theme/theme.ts`) writes `ui` onto `<html>` as `--ui-*`, the Terminal's background and foreground as `--terminal-*`, the six chromatic ANSI hues as `--ansi-*` and their computed ink as `--ansi-*-ink`, toggles `.dark` for dark themes, sets `color-scheme` and `data-theme`.

The twelve `ui` roles:
- **Ground** (`ground`): the window behind everything: tab strip, gutters, status bar, Home's Host cards, the base of a destructive button's text.
- **Sidebar** (`sidebar`): the nav rail and the Host list / Port forwards column, one continuous strip. In dark themes it is the deepest colour, and the source of the scrim and overlay shadow.
- **Surface** (`surface`): work panels (File panel, Home, Settings), the active tab, outline buttons, segmented-control thumbs.
- **Raised** (`raised`, the `popover` token): menus, dialogs, the command palette, drag previews.
- **Foreground** and **Muted foreground** (`foreground`, `mutedForeground`): text and secondary text (addresses, counts, hints, status bar, inactive tabs, rail icons at rest).
- **Border** (`border`): every 1px panel, tab, card, divider and status-segment rule.
- **Primary** and **Primary foreground** (`primary`, `primaryForeground`): the accent. Primary buttons, the focus ring (`ring`), the app mark, folder icons, the rail's pressed-view bar, the checked theme card.
- **Success**, **Warning**, **Destructive** (`success`, `warning`, `destructive`): Connection state and destructive actions only.

The `terminal` palette has background, foreground, cursor, cursor text, selection and all 16 ANSI colours. xterm uses hex values, with optional alpha on the selection background. `src/theme/terminal-themes.ts` lists the app themes' Terminal palettes, Ember, and 20 additional palettes from iTerm2-Color-Schemes. The global colour scheme applies to every Terminal that follows it. Hosts can pin a scheme in the advanced options. “Match app theme” uses the Terminal palette from the current app theme, including gallery previews.

Settings → Terminal imports XML and binary `.itermcolors` files through the system file picker. The imported palette uses the exported colours from iTerm2's active mode as a single choice. Imported palettes are stored with Terminal settings and appear in both the global and Host pickers. Removing a selected palette returns the global choice to “Match app theme” and any Host using it to the global choice. Terminal colour schemes affect the Terminal surface, and the app theme controls the chrome and Host colours. The collection, palette authors and parser notices ship in `terminal-palette-notices.txt`.

### Derived tokens
Computed in `src/index.css` with `color-mix(in oklab, ...)`; never stored in a theme:
- **Muted** (`muted`): foreground 6% over ground. Quiet fills: path bar, fingerprint block, segmented track.
- **Accent** (`accent`): foreground 9% over ground. Hover and pressed fills (rows, cards, ghost and icon buttons, pressed toggles).
- **Input** (`input`): foreground 22% over ground. Field strokes.
- **Selected** (`selected`): primary at 14% over transparent. Selected Host row, current rail destination, checked theme card.
- **Overlay**: foreground 30% (light) or sidebar 72% (dark). The dialog scrim.
- **Destructive foreground**: the ground colour, so text reads on light and dark red fills alike.
- **Host hue tile**: an ANSI hue at 15% (`bg-ansi-*/15`), lettered in `--ansi-*-ink`. `monogramInk` (`src/theme/monogram-ink.ts`) blends the hue with the theme's text colour (keeping at least 30% hue, pushing towards black or white only when the text colour is too dull) until the letters reach 4.6:1 on that tile over every surface it sits on: ground, sidebar, raised, accent over ground and selected over sidebar.

### The thirteen themes
Light: **Astra Light** (cool blue-grey ground, white panels and Terminal, Astra blue), **GitHub Light** (GitHub's neutral greys and blue), **Catppuccin Latte** (lavender-grey pastel, Terminal on the ground colour), **Solarized Light** (warm cream base3 surfaces, blue accent).
Dark: **Astra Dark** (blue-black ink, the Terminal a step deeper than the ground, soft periwinkle accent), **Tokyo Night** (indigo night, periwinkle accent), **One Dark** (Atom's slate grey, sky blue), **Nord** (arctic slate, frost cyan accent), **Catppuccin Mocha** (deep violet-grey pastel, mauve-blue), **Dracula** (purple-grey, violet accent, neon state colours), **Gruvbox Dark** (warm brown-black, retro aqua accent), **Solarized Dark** (deep teal base03, blue accent), **GitHub Dark** (GitHub's near-black dimmed blue).
Pickers list light themes first, then dark, Astra's own at the head of each (`appThemeList`).

### Named Rules
**The Twelve Roles Rule.** A theme is exactly the twelve `ThemeUi` roles plus a complete Terminal palette, all `#rrggbb`. A new colour need is a role derived in `src/index.css` from those variables, never a literal in a component and never a thirteenth role added to one theme only. Literal hex lives in the theme and Terminal palette definitions under `src/theme`.

**The AA Rule.** Every app theme passes WCAG AA (4.5:1), enforced per theme by `src/theme/themes.test.ts`: foreground on ground, surface and raised; muted foreground on surface and ground; primary foreground on primary; Terminal foreground on Terminal background. A theme port that fails is adjusted until it passes, not exempted. Monogram ink is held to 4.6:1 on every tile backing.

**The One Accent Rule.** Primary marks what is primary, current, checked or focused. It is not decoration, not a heading colour and not a state colour.

**The State Colour Rule.** Green means connected, amber means connecting or reconnecting (and pulses), red means disconnected, failed, or host key mismatch. They appear wherever a Host appears (Host row, Host card, tab, status bar) and are used for nothing else. State is never colour alone: an `sr-only` label, tooltip or text names it.

**The Hue Is Identity Rule.** A Host's colour is one of six ANSI hues (red, green, yellow, blue, magenta, cyan), a stable FNV-1a hash of its id (`hostHue`), painted only through `--ansi-*` tokens so every theme recolours it. Hue says *which* Host; it never says Connection state.

## Typography

**Body Font:** the system UI stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif`)
**Mono Font:** `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace`

**Character:** native and unbranded, reading as part of the OS in English and Chinese alike. Hierarchy comes from weight (400 / 500 / 600) and from foreground against muted foreground, not size jumps. Tailwind's text scale is overridden in `src/index.css` (`text-xs` 11.5px, `text-sm` 13px, `text-base` 14px, `text-lg` 15px) so shadcn components inherit desktop density.

### Hierarchy
- **Dialog title** (600, 15px / 22px): dialog headings only.
- **Empty-state title** (600, 14px / 22px): the one line of an empty state (Home with no Hosts).
- **Panel title** (600, 13px / 20px): sidebar headers ("Hosts"), panel headers ("Files"), Home's group headings (followed by a `text-xs` muted count with tabular figures).
- **Body** (400, 13px / 20px): the default, set on `body`. Host and file names, tab titles and theme names use 500.
- **Label** (400 or 500, 11.5px / 16px): status bar, tooltips, menu labels, hints, column headers; Host list group rows at 600.
- **Monogram** (600, 11px in lists, 11.5px on Home's cards): up to two initials (`web-01` is `W1`).
- **Address** (mono, 11.5px): `user@host[:port]` under or beside a Host name, and the focused Host's address in the status bar.
- **Terminal** (mono 13px, line height 1.2): the user may change family and size in Settings.

### Named Rules
**The Mono-Means-Exact Rule.** Mono is used only where every character matters: the Terminal, addresses, paths, host key fingerprints and key paths, commands quoted in copy. Never for labels, counts or decoration.

**The Sentence Case Rule.** All UI copy is sentence case. No uppercase labels, no letter-spaced small caps. Theme names are proper nouns, shown untranslated.

## Layout

**Anatomy.** Left to right: the 48px nav rail, then a resizable Host list column (default 248px, min 200px, max 40%, collapsible), both on `sidebar` with no rule between them; a 6px gutter; the main column on the ground. Top to bottom: the window above a full-width 24px status bar.

**Nav rail.** A 34px drag region clear of the macOS traffic lights, the app mark (the three-star `>_` constellation in primary, 28px), then destinations and views 4px apart: Home, Hosts, Port forwards, SFTP. Local terminal and Settings sit at the bottom. Rail buttons are 36px with 18px icons and a tooltip to the right.

**Chrome rows.** The sidebar header, horizontal tab strip and dock toggles align in a 34px row. The empty space in the row drags the window. In vertical mode the dock toggles stay across the top beside a full-height drag region. On macOS the leftmost chrome is inset by `--chrome-inset` (30px) to clear the traffic lights.

**Workspace.** Below the top chrome, the Terminal panel and the File panel (docked right, default 340px, min 240px; or bottom, min 140px; keeping its pixel size as the window resizes) are separated by a 6px gutter, with 6px of ground at the sides and bottom of the main column. Home, Settings and Port forwards are tabs that fill the workspace in a `surface` panel.

Within a tab, the focused pane splits to the right or down. Nested panes share a 1px divider with an 8px drag target. Dividers can also be moved with the arrow keys when focused. The focused pane keeps the primary inset ring, and other panes are dimmed. Broadcast recipients also show a dashed 1px warning-colour border inset by 2px, including the focused pane. The border sits above the Terminal canvas and leaves room for the focus ring.

**Gutters are the handles.** The 6px gap is the resize handle itself: a 2px by 28px grip in `border` at rest, `muted-foreground/40` on hover, `ring` while focused or dragging.

**Home.** A centred column (max 72rem, 24px side and 20px top padding) starts with a 36px search field, the Host sort menu and the New Host, Local terminal and Import buttons. Recent and each Group appear as a section of 56px Host cards in an auto-fill grid (min 15rem per card, 8px gaps), 20px between sections. Home and the Host list share the saved sort order for Hosts within each Group. Recent keeps its most recently opened order.

**Quick connect.** A valid SSH address adds an outline action above Home's Host cards and the first result in the command palette. Both read “Connect to …” and switch to “Quick connect” in privacy mode. An exact saved Host name takes priority in either search.

**Status bar.** Left: one segment per connected Host (green dot and name), per reconnecting Host (pulsing amber dot, try count), a Port forwards count (a button that opens the forwards view), transfers with speed, and the update notice. Each segment is 10px padded and closed by a 1px right rule. Right: the focused Host's address in mono, the theme menu and Settings.

**Rhythm.** Tailwind's 4px scale with 2px steps in chrome: 2px between Host rows, 4px between tabs and rail buttons, 6px gutters, 8 to 12px inside panels, 24px dialog padding.

**Responsive.** A desktop window, not a page: no breakpoints. Minimum sizes (main 320px, Terminal 200px) and collapse do the adapting.

### Named Rules
**The Shared Row Rule.** Chrome rows across columns share one height (34px), so the window reads as one grid; a new header in the sidebar or main column takes the same row.

## Elevation & Depth

Depth is tonal and border-led in every theme. The sidebar, ground, surface and raised roles step in lightness (in dark themes the sidebar is deepest and raised is lightest); work panels are flush on the ground with a 1px border and no shadow. Shadows exist only for things that float above the window or need to lift off a fill: menus, dialogs, the palette, drag previews, drop hints and segmented-control thumbs. Light themes cast soft shadows tinted from the theme's own foreground; dark themes trade the panel shadow for a 1px `border` ring and keep a deep sidebar-tinted shadow under overlays.

### Shadow Vocabulary
- **Panel** (`shadow-panel`; light `0 1px 2px color-mix(in oklab, var(--ui-foreground) 7%, transparent), 0 2px 8px color-mix(in oklab, var(--ui-foreground) 5%, transparent)`, dark `0 0 0 1px var(--ui-border)`): small lifted pieces on a fill: the segmented thumb, the "drop here" hint.
- **Overlay** (`shadow-overlay`; light `0 12px 32px` foreground 18% plus `0 2px 6px` foreground 8%, dark `0 16px 40px` sidebar 85% plus a `0 0 0 1px` border ring): menus, dialogs, the command palette, the dragged Host chip.

### Named Rules
**The Flush Panel Rule.** Terminal, File, Home and Settings panels never float: 1px border, ground around them, no shadow. Depth comes from the theme's tonal steps.

**The Two Shadows Rule.** There are exactly two shadows, `shadow-panel` and `shadow-overlay`, both derived from the theme. Tailwind's `shadow-xs/sm/md/lg` are not part of the system.

## Shapes

One radius scale from `--radius` (10px): `rounded-sm` 6px for inner items (menu items), `rounded-md` 8px for controls (buttons, icon buttons, inputs, menus, tooltips, monogram tiles, theme miniatures), `rounded-lg` 10px for panels, pill tabs, Host rows, Host cards, rail buttons, theme cards and inline alerts, `rounded-xl` 14px for dialogs. Status dots are full circles (6px in the status bar, 8px on tabs and cards); the gutter grip, the rail's pressed-view bar and the tab's hue underline are full pills. Borders are always 1px; the only thicker line is the 3px focus halo.

## Components

Compact and native-feeling; controls recede until hovered, pressed or focused.

### Buttons
- **Shape:** 8px radius, 500 weight, 16px Lucide icons.
- **Primary:** primary fill, primary-foreground text, 90% on hover. At most one per view, for the action that moves forward (New Host on Home).
- **Outline:** `surface` fill with a 1px border, `accent` on hover; secondary actions (Local terminal, Import on Home).
- **Ghost:** transparent until `accent` on hover.
- **Destructive:** destructive fill with ground-coloured text; only for removing data or overriding a security decision.
- **Sizes:** `sm` 32px in panels and dialogs; default 36px beside Home's search; `xs` 24px.
- **Focus:** `ring` border plus a 3px `ring/50` halo on `:focus-visible`.

### Icon buttons
- **Always `IconButton`** (`src/components/IconButton.tsx`): a 26px ghost button with a 16px icon in muted foreground, foreground on hover, and a required `label` that is both `aria-label` and tooltip (with an optional shortcut hint). A toggle that is on shows the `accent` fill (dock toggles).

### Navigation (nav rail)
- **Rest:** 36px, 10px radius, muted icon; `accent` on hover.
- **Destination current** (Home, SFTP, Local terminal, Settings while their tab is focused): `selected` tile, primary icon.
- **View pressed** (Hosts, Port forwards while that column is shown): icon turns foreground and a 2px primary bar marks the rail's left edge, never the tile, so "this tab is focused" and "this column is shown" never read as one state.

### Tabs
- **Style:** pill tabs on the ground, 28px tall, 112 to 208px wide, 10px radius, 4px apart. A Host tab leads with its Connection dot (8px, named in the label and tooltip); other tabs with a 14px kind icon at 70% opacity; then the truncated title; then a 20px close button.
- **Inactive:** muted foreground, transparent border, `accent/60` on hover, close button hidden until hover.
- **Active:** `surface` fill, 1px border, foreground text.
- **Unread output.** A 6px primary dot follows the title when a Terminal in a background tab has new output. The tooltip and accessible label name the indicator. Activating the tab clears it, and output from any split in the active tab leaves it clear.
- **Terminal bell.** The default is None. Flash tab briefly shows a 2px inset primary ring around the ringing tab, fading once. With reduced motion, the ring stays still before clearing. Sound plays a short tone.
- **Tab colour.** A 2px pill underline runs along a Host tab's bottom edge in its automatic ANSI hue at full strength when active and 40% when inactive. The tab's context menu offers six colours and an automatic setting. A custom colour replaces the underline and uses the matching `--ansi-*-ink` token at full strength for contrast in every theme.
- **Locked tabs.** A 14px lock in muted foreground takes the close button's place and appears in the tab's accessible label. Locking applies to the whole tab. Panes in a locked split can close while another pane remains open.
- **Restored panes.** A remote pane restored in Restore layout mode centres its disconnected status and an outlined Connect button on the workspace surface. In Restore and connect mode, each pane waiting its turn shows a muted waiting status.
- **Vertical tabs.** Settings → Appearance can place the same 28px tabs in a scrollable column between the sidebar and workspace. Drag its 6px gutter or use the gutter's arrow keys to resize it. The width defaults to 192px and can grow to 320px when space allows. The strip controls can narrow it to a 38px column of icons. The title and status remain in the tooltip and accessible label. The app remembers the width and icon-only preference.
- **Host grouping.** In vertical mode, tabs that belong to the same Host can sit under its collapsible header. A single tab stays at the top level. The group takes the position of its first tab. Collapsing a group keeps its workspace mounted and shows unread output and bell activity from its hidden tabs on the header.
- **Tab navigation.** Left and Right move across horizontal tabs. Up and Down move between visible vertical tabs. Home and End go to the first and last visible tabs. Delete and middle-click close unlocked tabs. Dragging reorders with a 2px `ring` insertion bar. New Terminal and split controls stay in the tab strip, and the File panel dock toggles stay at the top right.

### Host list rows
- **Style:** 30px, 10px radius, 2px apart: a 20px monogram tile, the name at 500 (max 65% of the row) with an inline Connection dot, then the address in mono `text-xs` muted, truncated. A row menu button appears on hover. Group rows: chevron, primary folder icon, name in `text-xs` 600; children indent 12px.
- **States:** `accent` on hover, `selected` when selected; search matches are bolded in foreground.
- **Sorting:** The header's sort menu offers manual order, name, address and last connected. Only manual order supports drag and drop, and search results keep dragging disabled.

### Host cards (Home)
- **Style:** 56px, 10px radius, 1px border, `ground` fill on Home's `surface` panel, 12px padding: a 32px monogram tile with the Connection dot at its corner (ringed 2px in ground), name at 500 over the mono address; a menu button on hover.
- **States:** `accent` on hover, `accent/70` pressed, 3px focus halo.

### Host monogram (signature)
The Host's tile wherever a Host appears: its initials on its hue at 15%, lettered in `--ansi-*-ink`. 20px with 11px letters in lists and menus; 32px on cards. Because the tile is translucent and the ink is solved against every backing, the same tile reads on ground, sidebar, raised, hover and selection in all thirteen themes.

### Status bar
24px on the ground with a 1px top rule, `text-xs` muted foreground, segments closed by 1px rules; clickable segments take `accent` on hover and an inset focus ring. Every segment is live state, never a placeholder ("No Connections" when there are none).

While Broadcast is active, the first segment shows a warning-colour radio icon and the current scope. Clicking it turns Broadcast off.

The privacy toggle sits beside the theme menu. Its pressed state uses the `selected` surface and an eye-off icon. While active, Host cards, rows, tabs, and the status bar show Host names in place of connection details. Address search remains available and the Port forward count stays visible.

### Settings navigation

The top search field filters settings across all categories. Results keep their category headings and the original controls. Search matches titles, descriptions, and keywords in both English and Simplified Chinese. Clearing the field returns to the selected category. Choosing a category clears the search and scrolls its rows to the top.

The left navigation lists Appearance, Terminal, Files, Connection, Transfers, Updates, and Diagnostics in that order when available. Appearance includes workspace layout and interface language. Updates and Diagnostics use the installed app's native features. The current category uses the `selected` surface, and narrow workspaces place the categories in a horizontally scrolling row above the controls. Shortcuts, Notifications, and Agent access can appear when they have settings available.

Terminal keyword highlighting uses the active Terminal palette. Settings → Terminal offers a switch for the built-in rules and a list of custom text or regular-expression rules. Matches use xterm decorations in the visible normal buffer.

### Theme gallery (signature)
Settings lists every theme as a card (10px radius, 6px padding, auto-fill at min 10rem, 12px gaps), light and dark in their own groups. Each card is a miniature of the window drawn from that theme's own values (tab strip, sidebar, a few lines of Terminal text, the six ANSI swatches and a primary square) with the name in `text-xs` 500. Checked: primary border, `selected` fill, primary check. Hovering or focusing a card previews that theme across the whole window, Terminals included; leaving restores the committed one; click commits. The status bar's theme menu lists the same themes.

### Inputs / Fields
- **Style:** 1px `input` stroke, 8px radius, 36px default (Home's search is 36px on `ground`), placeholder in muted foreground.
- **Focus:** border turns `ring` with a 3px `ring/50` halo.
- **Error:** border turns `destructive` with a `destructive/20` halo; message below in `text-xs` red.

### File panel path bar

- Back, Forward and Up sit beside a compact `muted` field. Each monospaced breadcrumb opens that directory. Long paths scroll horizontally and show the current directory at the right.
- Click the blank space or edit icon to select the path for editing. Enter opens an absolute path, `~` or `~/x`. Escape or leaving the field restores the breadcrumbs. Navigation errors appear below the path bar.
- New file opens a name dialog and creates an empty file in the current directory. Show conflicts in the dialog.
- Find by name opens an inline search below the remote path bar. Match a substring or a wildcard pattern with `*` and `?`. Show each result's parent path and report when only part of the tree could be searched. Selecting a result returns to the file list with the entry selected and in view.
- Alt+Left and Alt+Right browse history when focus is in the File panel outside text fields. Each panel keeps its own history in memory. Opening a different directory from a previous point in history replaces the forward entries.

### File panel list

- The list always includes Name and Size. Settings → Files remembers whether to show Modified (on by default) and Permissions (off by default). Click a column heading to sort within the directory and file groups. The active heading shows the sort direction. If the sorted column is hidden, the list uses ascending name order until that column returns or another sort is chosen.
- Right-align sizes, show modification time in the current locale, and show Unix permissions in monospace. Keep column headings above the scrolling rows and let narrow panels scroll sideways to reveal the enabled columns.
- Use a folder icon in ANSI blue, link icons in cyan, archives in yellow, images in magenta, code in green, and audio and video in red. Documents and other files use muted foreground. Draw coloured icons with the theme's `--ansi-*-ink` tokens. Classify regular files by their extension and use the folder or link shape for those entry kinds.
- F2 and the row menu’s Rename action edit the name within the row. Enter saves, and Escape cancels. Show validation and rename errors below the list and keep the name editable.
- In the remote row menu, Compress takes the selection and opens a name dialog for a new .tar.gz in the current folder. Extract appears for a single supported archive and confirms the new sibling folder. Keep conflicts, missing tools and other operation errors in the dialog.
- The footer shows item and selected counts after filtering. When selected entries are hidden, show their count alongside the visible selection.

### Menus, tooltips, dialogs
- **Menus:** `raised` fill, 1px border, 8px radius, 4px padding, `shadow-overlay`; items 6px radius, `accent` on focus, destructive items red.
- **Tooltips:** inverted (foreground fill, ground text), `text-xs`, 8px radius.
- **Dialogs:** `raised`, 1px border, 14px radius, 24px padding, max 512px, `shadow-overlay` over the overlay scrim; footer buttons right-aligned, primary last.

### Host editor
- **Basic information** is always visible and includes the name, address, port, user, authentication, Group, and Jump host. New Hosts start with Automatic authentication. The private key field appears when Private key is selected. Group shows the current location or the selected destination for a new Host. Use the Host list's move action to change a saved Host's Group.
- **Advanced** is a full-width disclosure below Basic information. It starts collapsed and contains Identities only, Terminal colours, the File panel folder, and the action to clear a saved Host's credentials. A save error attached to an advanced field opens the section, displays the message by the field, and moves focus to it.
- **Test connection** is an outlined action in the footer. The result appears above the footer with a muted progress message, a success message, or the standard Connection error panel.

### Connection view
A remote Terminal pane shows a scrollable Connection view on the workspace surface until its shell opens. The progress list groups steps by Host in route order, including each named Jump host. Reach server, Verify host key and Log in apply to each hop. Open shell applies to the destination. An extra step appears while this pane waits for another connection attempt.

Rows pair a status icon and explicit status text with the current authentication method and right-aligned elapsed time. The active icon uses `warning`, completed icons use `success`, and the failed row uses `destructive`. The existing Connection error panel explains the failure. Retry is the primary action and starts a new attempt in the same pane. Edit Host opens the Host editor, and Close closes the pane.

If the Connection drops, a scrollable overlay covers the Terminal and shows the attempt count and the same progress list for the current attempt. After the final failure, the overlay keeps that attempt's steps and the error text with the Reconnect button.

### Security surfaces
- **Fingerprint block:** `muted` fill, 1px border, 10px radius, 12px by 14px padding; a `text-xs` muted label above the fingerprint in mono, breaking anywhere, selectable.
- **Unknown host key.** The confirmation shows the fingerprint and offers Reject, Trust for this run, and Save and trust. A changed or revoked key displays an error.
- **Connection error panel:** 10px radius, 12px by 14px padding, destructive at 8% (12% dark) fill and a 30% destructive border. A host key mismatch is red and blocks.

## Do's and Don'ts

### Do:
- **Do** style components with semantic tokens only (`bg-background`, `bg-sidebar`, `bg-surface`, `bg-popover`, `bg-muted`, `bg-accent`, `bg-selected`, `text-muted-foreground`, `border`, `ring`, `bg-terminal-background`, `bg-ansi-*`, `text-ansi-*-ink`, `text-success`, `text-warning`, `text-destructive`); derive a new role in `src/index.css` from `--ui-*`.
- **Do** add a theme as a complete `AppTheme` (twelve ui roles plus the full Terminal palette, all `#rrggbb`) and run `src/theme/themes.test.ts`; adjust colours until every AA pair passes.
- **Do** paint a Host's identity only through `hostHue` and `hueClasses` (tile, dot, line), so every theme recolours it.
- **Do** show Connection state wherever a Host appears: green connected, amber connecting (pulsing), red disconnected or host key mismatch, always named in text, `sr-only` or tooltip.
- **Do** keep chrome rows at 34px, panels flush with 6px gutters that are the resize handles, and the status bar at 24px.
- **Do** use the overridden Tailwind sizes (`text-xs` 11.5px, `text-sm` 13px, `text-base` 14px, `text-lg` 15px) and the radius scale (6 / 8 / 10 / 14px).
- **Do** build icon-only controls with `IconButton` and a `label`; give every interactive element a visible `:focus-visible` ring (`ring`, 3px halo).
- **Do** respect `prefers-reduced-motion`: the base layer reduces every animation and transition to near zero.
- **Do** capitalise GLOSSARY.md terms in English copy (Host, Group, Jump host, Connection, Known host, Terminal, Local terminal, File panel, Port forward), write everything else in sentence case, and put all copy behind i18n keys in both locales.

### Don't:
- **Don't** put literal colours, Tailwind palette colours or arbitrary colour values in components; literal hex belongs in the theme and Terminal palette definitions under `src/theme`.
- **Don't** give a theme a colour the Terminal and chrome don't share, or recolour the Terminal without the chrome: one theme paints the whole window.
- **Don't** use primary for decoration, a Host hue for state, or a state colour for identity.
- **Don't** float work panels on shadows, or use shadows other than `shadow-panel` and `shadow-overlay`.
- **Don't** use mono outside the Terminal, addresses, paths, fingerprints and quoted commands.
- **Don't** use uppercase or letter-spaced labels, or set font sizes outside the overridden scale.
- **Don't** reach for a modal first: dialogs are for security confirmations, destructive confirmations and the Host editor.
