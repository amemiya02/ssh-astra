import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { exposeTerminal } from "@/lib/e2e";
import { openExternalUrl, readClipboardText, writeClipboardText } from "@/lib/ipc/system";
import { useTheme } from "@/theme/theme-context";
import { resolveTerminalTheme, terminalSearchDecorations, type TerminalColorScheme } from "@/theme/terminal-themes";
import { PasteConfirmDialog } from "./PasteConfirmDialog";
import { TerminalSearchBar, type SearchDirection, type SearchResults } from "./TerminalSearchBar";
import { BroadcastPaneContext, type Broadcast } from "@/features/workspace/broadcast";
import { currentPlatform, matchTerminalShortcut } from "@/features/workspace/shortcuts";
import { planPaste, type PendingPaste } from "./terminal-input";
import { terminalLinkDestination } from "./terminal-links";
import { zoomTerminalFont, type TerminalPrefs } from "./terminal-prefs";
import { useTerminalPrefs } from "./terminal-prefs-context";
import { attachTerminalHighlighting } from "./xterm-highlighting";

type BroadcastRecipients = ReturnType<Broadcast["capture"]>;

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

function appearanceOptions(
  { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, cursorStyle, cursorBlink, wordSeparator }: TerminalPrefs,
) {
  return { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, cursorStyle, cursorBlink, wordSeparator };
}

/**
 * xterm.js with everything a Terminal tab shares, whatever it is attached to:
 * the user's font, size, ligatures and colour scheme (live), find in scrollback,
 * clickable links, copy on select, right-click paste and paste confirmation.
 */
export function XtermView({ label, active, colorScheme, onTitleChange, attach }: XtermViewProps) {
  const { theme } = useTheme();
  const { broadcast, paneId } = useContext(BroadcastPaneContext) ?? {};
  const { prefs } = useTerminalPrefs();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const applyingPaste = useRef(false);
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
  const [pendingPaste, setPendingPaste] = useState<{ preview: PendingPaste; recipients: BroadcastRecipients } | null>(null);
  const [linkDestination, setLinkDestination] = useState<string | null>(null);

  useEffect(() => {
    prefsRef.current = prefs;
    themeRef.current = xtermTheme;
    attachRef.current = attach;
    onTitleChangeRef.current = onTitleChange;
  });

  /** Use the source xterm's line endings and bracketed-paste mode for every recipient. */
  const applyPaste = useCallback((text: string, recipients: BroadcastRecipients) => {
    const xterm = xtermRef.current;
    if (!xterm || (recipients && !recipients.canPaste())) return;
    const relay = recipients && xterm.onData(recipients.send);
    applyingPaste.current = true;
    try {
      xterm.paste(text);
    } finally {
      applyingPaste.current = false;
      relay?.dispose();
    }
  }, []);

  const requestPaste = useCallback((text: string, recipients: BroadcastRecipients) => {
    if (recipients && !recipients.canPaste()) return;
    const plan = planPaste(text, prefsRef.current.confirmMultilinePaste);
    if (!plan) return;
    if ("ask" in plan) setPendingPaste({ preview: plan.ask, recipients });
    else applyPaste(plan.paste, recipients);
  }, [applyPaste]);

  const fitIfVisible = useCallback(() => {
    // A hidden pane has no size. Fitting it would shrink the shell to a sliver.
    const container = containerRef.current;
    if (container && container.clientWidth > 0 && container.clientHeight > 0) fitRef.current?.fit();
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
      allowProposedApi: true, // Search and keyword highlights use decorations
      ...appearanceOptions(initial),
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

    const captureRecipients = () => paneId === undefined ? undefined : broadcast?.capture(paneId);

    // Every paste goes through the planner; capture runs before xterm's own handler.
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      requestPaste(event.clipboardData?.getData("text/plain") ?? "", captureRecipients());
    };
    const onContextMenu = (event: MouseEvent) => {
      if (!prefsRef.current.rightClickPaste) return;
      event.preventDefault();
      const recipients = captureRecipients();
      void readClipboardText().then((text) => {
        if (xtermRef.current === xterm) requestPaste(text, recipients);
      }, () => undefined);
    };
    const onZoomWheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      zoomTerminalFont(event.deltaY < 0 ? 1 : -1);
    };
    container.addEventListener("paste", onPaste, true);
    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("wheel", onZoomWheel, { capture: true, passive: false });

    const detach = attachRef.current(xterm);
    const stopBroadcastInput = broadcast && observeBroadcastKeys(container, xterm, captureRecipients, () => applyingPaste.current);
    const unexpose = exposeTerminal(xterm);
    const observer = new ResizeObserver(fitIfVisible);
    observer.observe(container);

    return () => {
      observer.disconnect();
      clearTimeout(copyTimer);
      stopBroadcastInput?.();
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("contextmenu", onContextMenu);
      container.removeEventListener("wheel", onZoomWheel, true);
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
  }, [broadcast, fitIfVisible, paneId, requestPaste]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (xterm) xterm.options = { ...appearanceOptions(prefs), theme: xtermTheme };
  }, [prefs, xtermTheme]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (active && xterm) return attachTerminalHighlighting(xterm, prefs.highlighting, xtermTheme);
  }, [active, broadcast, paneId, prefs.highlighting, xtermTheme]);

  useEffect(() => {
    fitIfVisible();
  }, [fitIfVisible, prefs.fontFamily, prefs.fontSize, prefs.fontWeight, prefs.lineHeight, prefs.letterSpacing]);

  useEffect(() => {
    const xterm = xtermRef.current;
    const renderer = rendererRef.current;
    if (!xterm || !renderer || renderer.ligatures === prefs.ligatures) return;
    renderer.dispose();
    rendererRef.current = loadRenderer(xterm, prefs.ligatures);
  }, [prefs.ligatures]);

  useEffect(() => {
    if (!active) return;
    fitIfVisible();
    if (!searching) xtermRef.current?.focus();
  }, [active, fitIfVisible, searching]);

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
        paste={pendingPaste?.preview ?? null}
        onConfirm={() => {
          if (pendingPaste) applyPaste(pendingPaste.preview.text, pendingPaste.recipients);
          setPendingPaste(null);
        }}
        onCancel={() => setPendingPaste(null)}
      />
    </div>
  );
}

/** xterm also emits onData for shell queries and focus reports. Relay only keyboard input. */
function observeBroadcastKeys(
  container: HTMLElement, xterm: XTerm, capture: () => BroadcastRecipients, pasting: () => boolean,
) {
  const textarea = xterm.textarea;
  if (!textarea) return;
  let keyEvent: Event | undefined;
  let composition: BroadcastRecipients;
  let compositionTimer: ReturnType<typeof setTimeout> | undefined;
  const keyboardEvents = ["keydown", "keypress", "input"];
  const onKeyboardEvent = (event: Event) => {
    if (event.target === textarea && textarea.ownerDocument.activeElement === textarea) keyEvent = event;
  };
  const expectComposition = () => {
    if (textarea.ownerDocument.activeElement !== textarea) return;
    const recipients = capture();
    if (!recipients) return;
    composition = recipients;
    clearTimeout(compositionTimer);
    // xterm finalizes IME text in a zero-delay timer scheduled by its earlier textarea listener.
    compositionTimer = setTimeout(() => { composition = undefined; }, 0);
  };
  const onImeKey = (event: KeyboardEvent) => {
    if (event.keyCode === 229) expectComposition();
  };
  const onData = xterm.onData((data) => {
    if (pasting() || textarea.ownerDocument.activeElement !== textarea || !data) return;
    if (keyEvent && keyEvent.eventPhase !== Event.NONE) {
      capture()?.send(data);
    } else if (composition && (data === "\x7f" || (!/[\p{Cc}]/u.test(data) && textarea.value.endsWith(data)))) {
      // A parser-generated protocol reply can arrive while the IME timer is pending.
      composition.send(data);
      composition = undefined;
    }
  });
  for (const event of keyboardEvents) container.addEventListener(event, onKeyboardEvent, true);
  textarea.addEventListener("compositionend", expectComposition);
  textarea.addEventListener("keydown", onImeKey, true);
  return () => {
    clearTimeout(compositionTimer);
    for (const event of keyboardEvents) container.removeEventListener(event, onKeyboardEvent, true);
    textarea.removeEventListener("compositionend", expectComposition);
    textarea.removeEventListener("keydown", onImeKey, true);
    onData.dispose();
  };
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
