import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { exposeTerminal } from "@/lib/e2e";
import { openExternalUrl, readClipboardText, writeClipboardText } from "@/lib/ipc/system";
import { useTheme } from "@/theme/theme-context";
import { resolveTerminalTheme, terminalSearchDecorations, type TerminalColorScheme } from "@/theme/terminal-themes";
import { PasteConfirmDialog } from "./PasteConfirmDialog";
import { TerminalSearchBar, type SearchDirection, type SearchResults } from "./TerminalSearchBar";
import { currentPlatform, matchTerminalShortcut } from "@/features/workspace/shortcuts";
import { planPaste, type PendingPaste } from "./terminal-input";
import { terminalLinkDestination } from "./terminal-links";
import { useTerminalPrefs } from "./terminal-prefs-context";

export const scrollbackLines = 10_000;

interface XtermViewProps {
  label?: string;
  /** Whether its tab is shown; becoming active refits and focuses the Terminal. */
  active: boolean;
  /** The Host's own colour scheme, overriding the global one. */
  colorScheme?: TerminalColorScheme;
  /** A program set a window title (OSC 0/2); an empty string clears it. */
  onTitleChange?(title: string): void;
  /**
   * Wires the Terminal to its backend. Called once, after it opens; returns the
   * teardown. Read later-changing values through refs: it is never called again.
   */
  attach(xterm: XTerm): () => void;
}

/**
 * xterm.js with everything a Terminal tab shares, whatever it is attached to:
 * the user's font, size, ligatures and colour scheme (live), find in scrollback,
 * clickable links, copy on select, right-click paste and paste confirmation.
 */
export function XtermView({ label, active, colorScheme, onTitleChange, attach }: XtermViewProps) {
  const { theme } = useTheme();
  const { prefs } = useTerminalPrefs();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const prefsRef = useRef(prefs);
  const xtermTheme = resolveTerminalTheme(prefs.colorScheme, colorScheme, theme);
  const themeRef = useRef(xtermTheme);
  const attachRef = useRef(attach);
  const onTitleChangeRef = useRef(onTitleChange);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [pendingPaste, setPendingPaste] = useState<PendingPaste | null>(null);
  const [linkDestination, setLinkDestination] = useState<string | null>(null);

  useEffect(() => {
    prefsRef.current = prefs;
    themeRef.current = xtermTheme;
    attachRef.current = attach;
    onTitleChangeRef.current = onTitleChange;
  });

  /** Pastes through xterm (so bracketed paste works), asking first when the plan requires it. */
  const requestPaste = useCallback((text: string) => {
    const plan = planPaste(text, prefsRef.current.confirmMultilinePaste);
    if (!plan) return;
    if ("ask" in plan) setPendingPaste(plan.ask);
    else xtermRef.current?.paste(plan.paste);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const initial = prefsRef.current;
    const activateLink = (event: MouseEvent, uri: string) => {
      const destination = terminalLinkDestination(uri);
      if (!destination) return;
      event.preventDefault();
      void openExternalUrl(destination).catch(() => undefined);
    };

    const xterm = new XTerm({
      allowProposedApi: true, // search highlights use decorations
      cursorBlink: true,
      fontFamily: initial.fontFamily,
      fontSize: initial.fontSize,
      lineHeight: 1.2,
      linkHandler: {
        // xterm's default permits only HTTP(S). Both callbacks enforce our allowlist.
        allowNonHttpProtocols: true,
        activate: activateLink,
        hover: (_event, uri) => setLinkDestination(terminalLinkDestination(uri)),
        leave: () => setLinkDestination(null),
      },
      scrollback: scrollbackLines,
      theme: themeRef.current,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(search);
    xterm.loadAddon(new WebLinksAddon(activateLink));
    xterm.open(container);
    xtermRef.current = xterm;
    fitRef.current = fit;
    searchRef.current = search;
    const renderer = loadRenderer(xterm, initial.ligatures);
    rendererRef.current = renderer;

    // A hidden tab has no size; fitting it would shrink the shell to a sliver.
    const fitIfVisible = () => {
      if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit();
    };
    fitIfVisible();

    const platform = currentPlatform();
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || matchTerminalShortcut(event, platform) !== "find") return true;
      event.preventDefault();
      setSearching(true);
      return false;
    });
    const onResults = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    );
    // Selection changes on every mouse move while dragging; copy once it settles.
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    const onSelection = xterm.onSelectionChange(() => {
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        if (prefsRef.current.copyOnSelect && xterm.hasSelection()) {
          void writeClipboardText(xterm.getSelection()).catch(() => undefined);
        }
      }, 150);
    });
    const onTitle = xterm.onTitleChange((title) => onTitleChangeRef.current?.(title));

    // Every paste goes through the planner; capture runs before xterm's own handler.
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      requestPaste(event.clipboardData?.getData("text/plain") ?? "");
    };
    const onContextMenu = (event: MouseEvent) => {
      if (!prefsRef.current.rightClickPaste) return;
      event.preventDefault();
      readClipboardText().then(requestPaste, () => undefined);
    };
    container.addEventListener("paste", onPaste, true);
    container.addEventListener("contextmenu", onContextMenu);

    const detach = attachRef.current(xterm);
    const unexpose = exposeTerminal(xterm);
    const observer = new ResizeObserver(fitIfVisible);
    observer.observe(container);

    return () => {
      observer.disconnect();
      clearTimeout(copyTimer);
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("contextmenu", onContextMenu);
      onResults.dispose();
      onSelection.dispose();
      onTitle.dispose();
      unexpose();
      detach();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      rendererRef.current = null;
    };
  }, [requestPaste]);

  // Font, size and colours apply to the running Terminal at once.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.theme = xtermTheme;
    xterm.options.fontFamily = prefs.fontFamily;
    xterm.options.fontSize = prefs.fontSize;
    const container = containerRef.current;
    if (container && container.clientWidth > 0) fitRef.current?.fit();
  }, [xtermTheme, prefs.fontFamily, prefs.fontSize]);

  useEffect(() => {
    const xterm = xtermRef.current;
    const renderer = rendererRef.current;
    if (!xterm || !renderer || renderer.ligatures === prefs.ligatures) return;
    renderer.dispose();
    rendererRef.current = loadRenderer(xterm, prefs.ligatures);
  }, [prefs.ligatures]);

  useEffect(() => {
    if (!active) return;
    fitRef.current?.fit();
    if (!searching) xtermRef.current?.focus();
  }, [active, searching]);

  const find = useCallback((query: string, direction: SearchDirection, incremental = false) => {
    const search = searchRef.current;
    if (!search) return;
    if (!query) {
      search.clearDecorations();
      setResults(null);
      return;
    }
    const options = { decorations: terminalSearchDecorations, incremental };
    if (direction === "next") search.findNext(query, options);
    else search.findPrevious(query, options);
  }, []);

  const closeSearch = useCallback(() => {
    searchRef.current?.clearDecorations();
    setResults(null);
    setSearching(false);
    xtermRef.current?.focus();
  }, []);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full py-2 pr-1 pl-3" aria-label={label} />
      {linkDestination && (
        <div
          role="tooltip"
          dir="ltr"
          className="pointer-events-none absolute inset-x-3 bottom-2 z-10 w-fit max-w-full wrap-anywhere rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm"
        >
          {linkDestination}
        </div>
      )}
      {searching && <TerminalSearchBar results={results} onFind={find} onClose={closeSearch} />}
      <PasteConfirmDialog
        paste={pendingPaste}
        onConfirm={() => {
          if (pendingPaste) xtermRef.current?.paste(pendingPaste.text);
          setPendingPaste(null);
        }}
        onCancel={() => setPendingPaste(null)}
      />
    </div>
  );
}

interface Renderer {
  ligatures: boolean;
  dispose(): void;
}

/**
 * Ligatures (if wanted), then WebGL: the WebGL atlas must be built after the
 * ligatures addon sets its font features. Either can fail; the DOM renderer is
 * slower but correct, and a font without ligatures simply shows none.
 */
function loadRenderer(xterm: XTerm, ligatures: boolean): Renderer {
  const addons: { dispose(): void }[] = [];
  if (ligatures) {
    try {
      const addon = new LigaturesAddon();
      xterm.loadAddon(addon);
      addons.push(addon);
    } catch {
      // No font access: plain glyphs.
    }
  }
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    xterm.loadAddon(webgl);
    addons.push(webgl);
  } catch {
    // WebGL unavailable: the DOM renderer takes over.
  }
  return { ligatures, dispose: () => addons.reverse().forEach((addon) => addon.dispose()) };
}
