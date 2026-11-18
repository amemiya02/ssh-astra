---
name: SSH Astra
description: A quiet desktop SSH/SFTP client where the Terminal is a lit sheet laid on a tinted desk.
colors:
  background: "oklch(0.972 0.003 255)"
  foreground: "oklch(0.22 0.012 255)"
  surface: "oklch(0.995 0.001 255)"
  popover: "oklch(1 0 0)"
  primary: "oklch(0.55 0.17 258)"
  primary-foreground: "oklch(0.99 0 0)"
  muted: "oklch(0.945 0.004 255)"
  muted-foreground: "oklch(0.5 0.012 255)"
  accent: "oklch(0.93 0.006 255)"
  selected: "oklch(0.55 0.17 258 / 0.1)"
  border: "oklch(0.905 0.005 255)"
  input: "oklch(0.875 0.006 255)"
  destructive: "oklch(0.55 0.2 25)"
  destructive-foreground: "oklch(0.99 0 0)"
  success: "oklch(0.6 0.14 155)"
  warning: "oklch(0.7 0.15 70)"
  overlay: "oklch(0.2 0.01 255 / 0.28)"
  terminal-background: "#ffffff"
  terminal-foreground: "#2b2f37"
  background-dark: "oklch(0.15 0.006 255)"
  foreground-dark: "oklch(0.93 0.005 255)"
  surface-dark: "oklch(0.205 0.007 255)"
  popover-dark: "oklch(0.225 0.008 255)"
  primary-dark: "oklch(0.7 0.14 258)"
  primary-foreground-dark: "oklch(0.17 0.02 258)"
  muted-dark: "oklch(0.245 0.008 255)"
  muted-foreground-dark: "oklch(0.7 0.01 255)"
  accent-dark: "oklch(0.255 0.008 255)"
  selected-dark: "oklch(0.7 0.14 258 / 0.14)"
  border-dark: "oklch(1 0 0 / 0.08)"
  input-dark: "oklch(1 0 0 / 0.13)"
  destructive-dark: "oklch(0.68 0.18 25)"
  success-dark: "oklch(0.72 0.14 155)"
  warning-dark: "oklch(0.8 0.14 75)"
  overlay-dark: "oklch(0 0 0 / 0.5)"
  terminal-background-dark: "#131519"
  terminal-foreground-dark: "#d9dce3"
typography:
  title-dialog:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, \"Noto Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "15px"
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
  body-large:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, \"Noto Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, \"Noto Sans\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
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
  status-bar: "26px"
  tab-strip: "38px"
  icon-button: "26px"
  sidebar: "248px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  button-ghost-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
  icon-button:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
    size: "26px"
  icon-button-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.foreground}"
  tab:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 4px 0 12px"
  tab-active:
    backgroundColor: "{colors.terminal-background}"
    textColor: "{colors.foreground}"
    height: "33px"
  terminal-panel:
    backgroundColor: "{colors.terminal-background}"
    textColor: "{colors.terminal-foreground}"
    rounded: "{rounded.lg}"
  file-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
  status-bar:
    backgroundColor: "{colors.background}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label}"
    height: "26px"
    padding: "0 12px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 10px"
  tooltip:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.background}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  dialog:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    width: "520px"
---

# Design System: SSH Astra

## Overview

**Creative North Star: "The Terminal is a lit sheet laid on a quiet desk"**

The window is a desk and a few sheets of paper on it. The chrome (Host list, tab strip, status bar) is one tinted ground with no rules dividing it; the work surfaces (the Terminal and the File panel) are rounded panels that float on that ground, separated by thin gutters instead of heavy dividers. The Terminal is the brightest sheet in light mode and the deepest in dark mode, and the active tab is cut from that same sheet so the tab and its Terminal read as one object.

The restraint is pinned by the owner: Termius and Linear, meaning large radii, 1px borders, soft shadow in light, border-led depth in dark, and desktop density with a 13px body. Colour is almost entirely cool neutral (hue 255). One Astra blue does the work of primary actions, selection and focus; green, amber and red belong to Connection state and nothing else. The look refuses edge-to-edge grey panes divided by heavy rules.

Density is moderate desktop density, not web-page spacing: 26px icon buttons, 32px tabs and controls, a 26px status bar. Everything a later screen needs (dialogs, Host rows, file tables, transfers) is drawn from the same tokens; the mockups in `docs/design/mockups.html` show those screens before they are built.

**Key Characteristics:**
- Two materials only: the chrome ground and floating rounded panels.
- 6px gutters between panels that double as resize handles.
- The active tab is joined to the Terminal surface (same colour, shared edge).
- One blue accent; green, amber and red are reserved for Connection state.
- System UI sans at 13px; mono only where characters must be exact.
- Light and dark are equal citizens, switched by the `.dark` class on `<html>`.

## Colors

Cool, near-colourless neutrals at hue 255 carry the whole window; one saturated blue and three state colours are the only voices. Tokens are OKLCH in `src/index.css`; light values are listed first in the frontmatter, dark values carry the `-dark` suffix and live under `.dark`.

### Primary
- **Astra Blue** (`primary`): primary buttons, the selected Host avatar, folder icons, transfer progress, the focus ring (`ring` equals `primary`) and the text selection tint. Brighter and less saturated in dark (`primary-dark`) so it holds contrast on near-black.
- **Selection Wash** (`selected`): Astra Blue at 10% (14% in dark). The background of a selected Host row or file row. It never carries text colour of its own.

### Secondary (Connection state)
- **Connected Green** (`success`): a live Connection; the state dot on a Host avatar and tab, completed transfers.
- **Connecting Amber** (`warning`): connecting, reconnecting, or degraded.
- **Blocking Red** (`destructive`): disconnected with an error, failed transfers, destructive actions, and a host key mismatch.

### Neutral
- **Desk Grey** (`background`): the chrome ground behind the Host list, tab strip and status bar. Also the base of outline buttons.
- **Ink** (`foreground`): primary text, panel titles.
- **Sheet White** (`surface`): raised work panels (File panel, cards, inputs in mockups).
- **Popover White** (`popover`): menus and dialogs; the highest layer.
- **Muted Grey** (`muted`) and **Pencil Grey** (`muted-foreground`): quiet fills (path bar, segmented control track, fingerprint block, avatars) and secondary text (status bar, addresses, column headers, hints).
- **Hover Grey** (`accent`): hover and pressed fills for ghost and icon buttons, the active dock toggle.
- **Hairline** (`border`) and **Field Line** (`input`): 1px panel, tab and divider borders; input strokes. In dark both are translucent white so they read as edges of light.
- **Scrim** (`overlay`): the layer behind dialogs.
- **Terminal Paper** (`terminal-background`, `terminal-foreground`): the Terminal surface and the active tab. Hex, because xterm.js parses hex; it must equal the xterm theme in `src/theme/terminal-themes.ts` (a test checks this).

### Named Rules
**The Semantic Token Rule.** Components use only semantic tokens (`bg-background`, `bg-surface`, `bg-popover`, `bg-muted`, `text-muted-foreground`, `bg-accent`, `bg-selected`, `bg-terminal-background`, `text-terminal-foreground`, `border`, `ring`, `shadow-panel`, `shadow-overlay`, `text-success`, `text-warning`, `text-destructive`, `bg-overlay`), never raw colours, Tailwind palette colours (`bg-zinc-800`, `text-white`, `bg-black/50`) or arbitrary values. A new colour need is a new token in `src/index.css`, in both `:root` and `.dark`. `src/theme/terminal-themes.ts` is the one sanctioned place for literal hex: the 16 ANSI colours, cursor and selection for xterm.

**The One Blue Rule.** Astra Blue marks what is primary, selected or focused. It is not decoration, not a heading colour and not a second state colour.

**The State Colour Rule.** Green means connected, amber means connecting or degraded, red means disconnected, failed, or host key mismatch. These colours appear wherever a Host appears (Host row dot, tab dot, status bar) and are never used for anything else. State is never colour alone: a label or tooltip names it.

## Typography

**Body Font:** the system UI stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif`)
**Mono Font:** `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace`

**Character:** native and unbranded; the app should feel like part of the OS it runs on, in English and Chinese alike. Hierarchy comes from weight (400 / 500 / 600) and colour (Ink vs Pencil Grey), not from size jumps.

Tailwind's text scale is overridden in `src/index.css` so shadcn components inherit desktop density. Use the Tailwind names; never set arbitrary sizes.

### Hierarchy
- **Dialog title** (600, `text-lg` 15px / 22px): dialog headings only.
- **Large body** (400, `text-base` 14px / 22px): rare; reserved for emphasis inside dialogs.
- **Panel title** (600, `text-sm` 13px / 20px): "Hosts", "Files", section headings inside panels.
- **Body** (400, `text-sm` 13px / 20px): the default for everything; set on `body`. Names of Hosts and files use 500.
- **Label** (400 or 500, `text-xs` 11.5px / 16px): status bar, tooltips, menu labels, addresses under Host names, table column headers, field hints. Group headers in the Host list use 600 at this size in sentence case.
- **Terminal** (mono 13px, line height 1.2): set in xterm options.

### Named Rules
**The Mono-Means-Exact Rule.** Mono is used only where every character matters: the Terminal, file paths, host key fingerprints, addresses and commands quoted in copy. Never for labels, numbers in general, or decoration.

**The Sentence Case Rule.** All UI copy is sentence case. No uppercase labels, no letter-spaced small caps.

## Layout

**Anatomy.** Top to bottom, the window is a flex column: a horizontal resizable group (Host list | main column) and a 26px status bar. Left to right: the Host list (default 248px, min 200px, max 40%, collapsible) sits directly on the ground with 10px inset; a 6px gutter; the main column. The main column is a 38px tab strip on the ground, then the workspace: the Terminal panel and the File panel, docked right (default 340px) or bottom (default 260px), keeping its pixel size when the window resizes, separated by a 6px gutter. The main column keeps 6px of ground to its right and below the panels, so every panel edge has ground around it.

**Gutters are the handles.** The 6px gap between panels is the resize handle itself; there are no separate splitter bars. At rest a 2px by 28px grip in `border` colour sits centred in the gutter; it turns `muted-foreground/40` on hover and `ring` while focused or dragging. Panel sizes, collapsed state and the File panel dock persist across restarts per dock.

**Tab strip.** Tabs (32px tall, 112 to 208px wide, 2px apart) bottom-align on the ground. The active tab is `terminal-background`, bordered on three sides, 1px taller and pulled 1px down so it overlaps the Terminal panel's top border: the tab and the Terminal are one sheet. The sidebar toggle sits left of the tabs; the dock toggles (bottom, right) sit at the far right as a group.

**Status bar.** 26px, full width, on the ground with a 1px top border, 12px side padding, 14px gap between items, `text-xs` in Pencil Grey. App-wide state (Connections, Port forwards, transfers) on the left in a polite live region; the appearance menu on the right.

**Rhythm.** Spacing follows Tailwind's 4px scale with 2px steps for chrome: 2px between tabs and icon buttons, 6px gutters, 8 to 12px inside panels, 10px sidebar inset, 20px dialog padding (mockups). Panel headers are 40px with 12px left padding and a bottom border.

**Responsive.** This is a desktop window, not a page: there are no breakpoints. Minimum sizes (main 320px, Terminal 200px, File panel 240px right / 140px bottom) and collapse do the adapting.

### Named Rules
**The Ground-and-Sheets Rule.** Chrome never gets its own panel, fill or dividing rule; it lives on the ground. Work surfaces are always rounded, bordered panels with ground on every side.

## Elevation & Depth

A hybrid of tonal layering and soft shadow. In light mode panels lift with a barely-there two-layer shadow; in dark mode shadows nearly vanish and depth is carried by translucent white borders and slightly lighter surfaces (ground 0.15, Terminal about 0.19, surface 0.205, popover 0.225 lightness; the Terminal must stay a visible step above the ground). Layers, lowest to highest: ground, panels, popovers and tooltips, dialogs over a scrim.

### Shadow Vocabulary
- **Panel** (`shadow-panel`; light `0 1px 2px oklch(0.2 0.02 255 / 0.05), 0 2px 8px oklch(0.2 0.02 255 / 0.04)`, dark `0 1px 2px oklch(0 0 0 / 0.3)`): the Terminal and File panels, cards.
- **Overlay** (`shadow-overlay`; light `0 12px 32px oklch(0.2 0.02 255 / 0.16), 0 2px 6px oklch(0.2 0.02 255 / 0.06)`, dark `0 16px 40px oklch(0 0 0 / 0.5), 0 0 0 1px oklch(1 0 0 / 0.06)`): dialogs, menus and popovers.

### Named Rules
**The Two Shadows Rule.** There are exactly two shadows, `shadow-panel` and `shadow-overlay`. Tailwind's `shadow-sm/md/lg` are not part of the system.

## Shapes

Large, consistent radii and 1px borders. The scale derives from `--radius` (10px): `rounded-sm` 6px for inner pills (segmented control thumbs, selected table rows), `rounded-md` 8px for controls (buttons, icon buttons, inputs, menus, tooltips), `rounded-lg` 10px for panels and the top corners of tabs (also fingerprint blocks and alerts), `rounded-xl` 14px for dialogs. Status dots and the gutter grip are full circles and pills. Borders are always 1px in `border` (or `input` for fields); nothing is outlined thicker except the 3px focus ring.

## Components

Quiet, compact and native-feeling; controls recede until hovered or focused.

### Buttons
- **Shape:** gently rounded (8px).
- **Primary:** Astra Blue fill, `primary-foreground` text, 500 weight. One per view at most, for the action that moves the user forward.
- **Outline:** `background` fill with a 1px border; the default for secondary actions (e.g. the Local terminal button pinned at the bottom of the Host list).
- **Ghost:** transparent until hover (`accent`); used in chrome and for the appearance menu.
- **Destructive:** Blocking Red fill; only for removing data or overriding a security decision.
- **Sizes:** `sm` 32px is the working size in panels and dialogs; `xs` 24px in the status bar.
- **Focus:** `ring` border plus a 3px `ring/50` halo on `:focus-visible`.

### Icon buttons
- **Always `IconButton`** (`src/components/IconButton.tsx`): a 26px ghost button with a 16px Lucide icon in Pencil Grey, Ink on hover. It requires a `label` that becomes both `aria-label` and the tooltip (with an optional shortcut hint). A toggle that is on shows the `accent` fill (see the dock toggles).

### Tabs
- **Style:** 32px, top corners 10px, icon (or state dot for a Host) then a truncated title, close button 20px. Inactive tabs are Pencil Grey on the ground, `accent/60` on hover, with the close button hidden until hover.
- **Active:** Terminal Paper fill, 1px border without a bottom edge, joined to the Terminal panel. Arrow keys, Home and End move between tabs, Delete closes, middle-click closes.

### Panels
- **Terminal panel:** Terminal Paper, 10px radius, 1px border, `shadow-panel`. Every open tab stays mounted; only the active one is visible.
- **File panel:** `surface`, 10px radius, 1px border, `shadow-panel`; a 40px header (panel title, actions, hide button) with a bottom border, scrolling body.
- **Empty states:** centred in the panel, a 20 to 24px muted Lucide icon, one line in 500 weight, one muted sentence (max ~18rem, balanced), and at most one outline button.

### Inputs / Fields
- **Style:** 1px `input` stroke, 8px radius, 32px high in dialogs (mockups), placeholder in Pencil Grey.
- **Focus:** border turns `ring` with a 3px `ring/50` halo.
- **Error:** border turns `destructive` with a `destructive/20` halo; the message sits below in `text-xs` red.
- **Label:** 12px, 500 weight above the field; hint in `text-xs` Pencil Grey below.

### Menus and tooltips
- **Menus:** `popover` fill, 1px border, 8px radius, 4px inner padding; radio items for exclusive choices (appearance: Follow system, Light, Dark).
- **Tooltips:** inverted (`foreground` fill, `background` text), `text-xs`, 8px radius; every icon button has one.

### Specified in mockups, not built yet
The following patterns are drawn in `docs/design/mockups.html` (rendered to `docs/design/{main,bottom,editor,known,mismatch}-{light,dark}.png`) with the same tokens. They are the intended specs; where a mockup value differs from the built shell (mockup icon buttons at 7px radius, tabs at 8px, Terminal text at 12.5px), the built shell wins.

- **Host row:** 26px square avatar (7 to 8px radius, `muted` fill, two-letter initials at 11.5px 600) with a 9px state dot at its bottom-right, ringed 2px in `background`; name at 500 and the address below in `text-xs` Pencil Grey (`user@host`, port and jump host appended). 6px by 8px padding, 8px radius. Selected: `selected` wash, avatar turns Astra Blue. No dot when there is no Connection. Group headers above rows: chevron plus name, `text-xs` 600 Pencil Grey. A search field (30px, `surface`, 1px border, 8px radius, with a ⌘K hint) sits above the list.
- **File table:** inside the File panel, a mono path bar (28px, `muted` fill, 8px radius, up-arrow on the left) then a table at 12.5px: column headers `text-xs` 500 Pencil Grey, rows padded 5px by 12px, folder icons Astra Blue and file icons Pencil Grey, size and date in Pencil Grey with tabular figures, size right-aligned. A selected row is a `selected` wash with 6px rounded ends.
- **Transfer row:** direction icon (Astra Blue), file name at 500, percentage right; a 4px progress bar (`muted` track, Astra Blue fill, rounded); a sub-line in `text-xs` Pencil Grey with tabular figures (done of total, speed, time left). Failed: red icon, bar and message, with a ghost Retry button. Done: green check. The status bar summarises active transfers.
- **Segmented control:** `muted` track, 2px padding, 8px radius; segments 12px text, 6px radius; the active segment is `surface` with a hairline shadow. Used for Transfers (Active / Done) and the Host editor's authentication method.
- **Dialog:** `popover` fill, 1px border, 14px radius, `shadow-overlay`, over the `overlay` scrim. 480 to 520px wide. Header 18px top and 20px side padding, title at 15px 600, a muted lead sentence; body with 14px gaps; footer right-aligned buttons (primary last), with a secondary action allowed at the far left. A dialog with sections uses underline tabs (2px Astra Blue indicator).
- **Fingerprint block:** `muted` fill, 1px border, 10px radius, 12px by 14px padding; a `text-xs` Pencil Grey label ("ED25519 key fingerprint", "Expected (known_hosts, line 14)", "Received") above the fingerprint in mono 12.5px, breaking anywhere. In a mismatch the received fingerprint is red.
- **Destructive alert:** 10px radius, 12px by 14px padding, a red-tinted fill (destructive at 8% light, 12% dark) and a 30% red border; red icon and bold first line, body text in Ink. Used for the host key mismatch, which blocks the Connection.

## Do's and Don'ts

### Do:
- **Do** style components with semantic tokens only; add a token to both `:root` and `.dark` in `src/index.css` when a new role is needed, and keep `terminal-themes.ts` in sync with `--terminal-*`.
- **Do** use the overridden Tailwind sizes (`text-xs` 11.5px, `text-sm` 13px body, `text-base` 14px, `text-lg` 15px) and the radius scale (`rounded-sm` 6px, `rounded-md` 8px, `rounded-lg` 10px panels, `rounded-xl` 14px dialogs).
- **Do** keep chrome on the ground and work on rounded panels, with 6px gutters that are the resize handles.
- **Do** show Connection state wherever a Host appears: green connected, amber connecting or degraded, red disconnected or host key mismatch, always paired with a text label or tooltip.
- **Do** capitalise GLOSSARY.md terms in English copy (Host, Group, Jump host, Connection, Known host, Terminal, Local terminal, File panel, Port forward) and write everything else in sentence case. In Chinese copy keep "Host" as is and translate the rest (终端, 本地终端, 文件面板).
- **Do** put all copy behind i18n keys present in both `src/i18n/locales/en.json` and `zh.json`.
- **Do** build icon-only controls with `IconButton` and a `label`; give every interactive element a visible `:focus-visible` ring (`ring`, 3px halo).
- **Do** respect `prefers-reduced-motion`: the base layer reduces every animation and transition to near zero; new motion must not bypass it.
- **Do** state security problems plainly: an unknown host key gets a dialog with its fingerprint; a mismatch is red and blocks.

### Don't:
- **Don't** use raw colours, Tailwind palette colours or arbitrary values (`#fff`, `text-white`, `bg-black/50`, `bg-zinc-900`) in components; literal hex belongs only in `terminal-themes.ts`.
- **Don't** reach for a modal first. Inline editing, panels and menus come first; dialogs are for security confirmations (unknown or changed host keys), destructive confirmations and the Host editor.
- **Don't** use mono outside the Terminal, paths, fingerprints, addresses and quoted commands.
- **Don't** use Astra Blue for decoration, or the state colours for anything except state.
- **Don't** divide chrome with heavy rules or give chrome its own grey pane; don't run panels edge to edge.
- **Don't** use shadows other than `shadow-panel` and `shadow-overlay`, or borders thicker than 1px.
- **Don't** use uppercase or letter-spaced labels, or set font sizes outside the overridden scale.
- **Don't** hard-code UI strings, or translate glossary terms into their "Avoid" synonyms (session, server, bookmark, SFTP browser).
