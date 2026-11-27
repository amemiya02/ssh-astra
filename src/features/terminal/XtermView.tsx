import { ClipboardPaste, Columns2, Copy, Eraser, Rows2, Search, SquareDashed } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { FitAddon } from "@xterm/addon-fit";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useContext, useEffect, useRef, useState, type RefObject } from "react";
import { exposeTerminal } from "@/lib/e2e";
import { SnippetMenu } from "@/features/snippets/SnippetMenu";
import { useSnippetRunner } from "@/features/snippets/use-snippet-runner";
import { showToast } from "@/features/toasts/toastStore";
import { copyTextWithToast, notifyCopied } from "@/features/toasts/copyFeedback";
import { externalLinkDestination } from "@/lib/external-link";
import { openExternalUrl, readClipboardText, writeClipboardText } from "@/lib/ipc/system";
import { cn } from "@/lib/utils";
import { useTheme } from "@/theme/theme-context";
import { resolveTerminalTheme, terminalSearchDecorations } from "@/theme/terminal-themes";
import type { HostId } from "@/lib/ipc/hosts";
import { CommandHistoryDialog } from "./CommandHistoryDialog";
import { PasteConfirmDialog } from "./PasteConfirmDialog";
import { TerminalOutputMenuItems } from "./TerminalOutputMenuItems";
import { TerminalSearchBar, type SearchDirection, type SearchResults } from "./TerminalSearchBar";
import { BroadcastPaneContext, type Broadcast } from "@/features/workspace/broadcast";
import { movingSourcePane } from "@/features/workspace/tab-window-move";
import { getResolvedShortcuts } from "@/features/workspace/shortcut-settings";
import { currentPlatform, matchTerminalShortcut } from "@/features/workspace/shortcuts";
import { planPaste, type PendingPaste } from "./terminal-input";
import { TerminalPaneMenuContext } from "./terminal-pane-menu";
import { selectAllEvent } from "./terminal-selection";
import { zoomTerminalFont, type TerminalPrefs } from "./terminal-prefs";
import { useTerminalPrefs } from "./terminal-prefs-context";
import { attachTerminalHighlighting } from "./xterm-highlighting";
import { attachTerminalImages } from "./xterm-images";

type BroadcastRecipients = ReturnType<Broadcast["capture"]>;

export const scrollbackLines = 10_000;

interface XtermViewProps {
  label?: string;
  /** Whether its tab is shown; becoming active refits and focuses the Terminal. */
  active: boolean;
  /** The Host's own colour scheme, overriding the global one. */
  colorScheme?: string | null;
  historyHostId?: HostId;
  canPasteHistory?(): boolean;
  /** A program set a window title (OSC 0/2); an empty string clears it. */
  onTitleChange?(title: string): void;
  /** The image paste for the running shell, or null between attachments. */
  imagePasteRef?: RefObject<(() => Promise<void>) | null>;
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
export function XtermView({ label, active, colorScheme, historyHostId, canPasteHistory, onTitleChange, imagePasteRef, attach }: XtermViewProps) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const { broadcast, paneId } = useContext(BroadcastPaneContext) ?? {};
  const paneMenu = useContext(TerminalPaneMenuContext);
  const { prefs } = useTerminalPrefs();
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const applyingPaste = useRef(false);
  const fitRef = useRef<FitAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuFocus = useRef<"terminal" | "search" | "managed">("terminal");
  const searchRef = useRef<SearchAddon | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const imagesRef = useRef<ReturnType<typeof attachTerminalImages> | null>(null);
  const prefsRef = useRef(prefs);
  const xtermTheme = resolveTerminalTheme(prefs.colorScheme, colorScheme, theme, prefs.importedSchemes);
  const themeRef = useRef(xtermTheme);
  const attachRef = useRef(attach);
  const onTitleChangeRef = useRef(onTitleChange);
  const historyHostRef = useRef(historyHostId);
  const [canCopy, setCanCopy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [pendingPaste, setPendingPaste] = useState<{ preview: PendingPaste; recipients: BroadcastRecipients } | null>(null);
  const [linkDestination, setLinkDestination] = useState<string | null>(null);
  const [historyHost, setHistoryHost] = useState<HostId>();
  if (historyHost !== undefined && (!active || historyHost !== historyHostId)) setHistoryHost(undefined);

  const restoreTerminalFocus = (event: Event) => {
    event.preventDefault();
    if (active) xtermRef.current?.focus();
  };
  const snippetRunner = useSnippetRunner({
    broadcast, paneId, hostId: paneMenu?.hostId,
    reportError: (message) => { if (message) showToast(() => message, "error"); },
    onCloseAutoFocus: restoreTerminalFocus,
  });

  useEffect(() => {
    prefsRef.current = prefs;
    themeRef.current = xtermTheme;
    attachRef.current = attach;
    onTitleChangeRef.current = onTitleChange;
    historyHostRef.current = historyHostId;
  });

  /** Use the source xterm's line endings and bracketed-paste mode for every recipient. */
  const applyPaste = useCallback((text: string, recipients: BroadcastRecipients) => {
    const xterm = xtermRef.current;
    if (!xterm || (paneId !== undefined && movingSourcePane(paneId)) || (recipients && !recipients.canPaste())) return;
    const relay = recipients && xterm.onData(recipients.send);
    applyingPaste.current = true;
    try {
      xterm.paste(text);
    } finally {
      applyingPaste.current = false;
      relay?.dispose();
    }
  }, [paneId]);

  const requestPaste = useCallback((text: string, recipients: BroadcastRecipients) => {
    if (recipients && !recipients.canPaste()) return;
    const plan = planPaste(text, prefsRef.current.confirmMultilinePaste);
    if (!plan) return;
    if ("ask" in plan) setPendingPaste({ preview: plan.ask, recipients });
    else applyPaste(plan.paste, recipients);
  }, [applyPaste]);

  const captureRecipients = useCallback(() => paneId === undefined ? undefined : broadcast?.capture(paneId), [broadcast, paneId]);
  const pasteImage = useCallback((paste: (() => Promise<void>) | null | undefined) => {
    if (!paste || !prefsRef.current.pasteImages || imagePasteRef?.current !== paste) return;
    void paste().catch(() => {
      if (imagePasteRef.current === paste) showToast((t) => t("terminal.imagePaste.failed"), "error");
    });
  }, [imagePasteRef]);
  const pasteFromClipboard = useCallback(() => {
    const xterm = xtermRef.current;
    const recipients = captureRecipients();
    const image = prefsRef.current.pasteImages ? imagePasteRef?.current : null;
    void readClipboardText().then((text) => {
      if (xtermRef.current !== xterm) return;
      if (text) requestPaste(text, recipients);
      else pasteImage(image);
    }, () => {
      if (xtermRef.current === xterm) pasteImage(image);
    });
  }, [captureRecipients, imagePasteRef, pasteImage, requestPaste]);

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
      const destination = externalLinkDestination(uri);
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
        hover: (_event, uri) => setLinkDestination(externalLinkDestination(uri)),
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
    const images = attachTerminalImages(xterm, initial.inlineImages);
    imagesRef.current = images;

    fitIfVisible();

    const platform = currentPlatform();
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing) return true;
      const shortcut = matchTerminalShortcut(event, getResolvedShortcuts(platform));
      if (shortcut === "find") {
        event.preventDefault();
        setSearching(true);
        searchInputRef.current?.focus();
        return false;
      }
      if (shortcut === "commandHistory" && historyHostRef.current !== undefined) {
        event.preventDefault();
        setHistoryHost(historyHostRef.current);
        return false;
      }
      const menuKey = !event.altKey && !event.ctrlKey && !event.metaKey &&
        (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey));
      if (!menuKey || prefsRef.current.rightClickPaste) return true;
      event.preventDefault();
      const { left, top } = container.getBoundingClientRect();
      container.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: left + 8, clientY: top + 8,
      }));
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
    // xterm fills clipboardData and prevents the default only when it handles a selection.
    const onCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented && event.clipboardData && xterm.hasSelection()) notifyCopied();
    };
    // WebKit's edit command enables Copy for xterm's selection even when the
    // hidden textarea has no native selection.
    const onBeforeCopy = (event: Event) => {
      if (xterm.hasSelection()) event.preventDefault();
    };
    const onSelectAll = (event: Event) => {
      event.preventDefault();
      xterm.selectAll();
    };
    const onTitle = xterm.onTitleChange((title) => onTitleChangeRef.current?.(title));

    // Every paste goes through the planner; capture runs before xterm's own handler.
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const clipboard = event.clipboardData;
      const text = clipboard?.getData("text/plain");
      if (text) requestPaste(text, captureRecipients());
      else if (prefsRef.current.pasteImages && clipboard &&
        !clipboard.types.some((type) => type.startsWith("text/"))) {
        // WebKit can omit native image formats from the event. Native code checks the formats before reading the image.
        pasteImage(imagePasteRef?.current);
      }
    };
    const onContextMenu = (event: MouseEvent) => {
      if (!prefsRef.current.rightClickPaste) return;
      event.preventDefault();
      pasteFromClipboard();
    };
    const onZoomWheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      zoomTerminalFont(event.deltaY < 0 ? 1 : -1);
    };
    container.addEventListener("copy", onCopy);
    if (platform === "mac") {
      container.addEventListener("beforecopy", onBeforeCopy);
      container.addEventListener(selectAllEvent, onSelectAll);
    }
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
      container.removeEventListener("copy", onCopy);
      container.removeEventListener("beforecopy", onBeforeCopy);
      container.removeEventListener(selectAllEvent, onSelectAll);
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("contextmenu", onContextMenu);
      container.removeEventListener("wheel", onZoomWheel, true);
      onResults.dispose();
      onSelection.dispose();
      onTitle.dispose();
      unexpose();
      detach();
      images.disposeTerminal();
      xtermRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      rendererRef.current = null;
      imagesRef.current = null;
    };
  }, [broadcast, captureRecipients, fitIfVisible, imagePasteRef, pasteFromClipboard, pasteImage, requestPaste]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (xterm) xterm.options = { ...appearanceOptions(prefs), theme: xtermTheme };
  }, [prefs, xtermTheme]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (active && xterm) return attachTerminalHighlighting(xterm, prefs.highlighting, xtermTheme);
  }, [active, broadcast, paneId, prefs.highlighting, xtermTheme]);

  useEffect(() => {
    imagesRef.current?.setEnabled(prefs.inlineImages);
  }, [prefs.inlineImages]);

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
      <ContextMenu onOpenChange={(open) => {
        if (open) {
          menuFocus.current = "terminal";
          setCanCopy(xtermRef.current?.hasSelection() ?? false);
          xtermRef.current?.focus();
        }
      }}>
        <ContextMenuTrigger asChild disabled={prefs.rightClickPaste}>
          <div
            ref={containerRef}
            className={cn("h-full w-full py-2 pr-1 pl-3", !prefs.inlineImages && "[&_.xterm-image-layer]:hidden")}
            aria-label={label}
          />
        </ContextMenuTrigger>
        {!prefs.rightClickPaste && (
          <ContextMenuContent aria-label={t("terminal.menu.label")} onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!active || pendingPaste) return;
            if (menuFocus.current === "search") searchInputRef.current?.focus();
            if (menuFocus.current === "terminal") xtermRef.current?.focus();
          }}>
            <ContextMenuItem disabled={!canCopy} onSelect={() => {
              const text = xtermRef.current?.getSelection();
              if (text) void copyTextWithToast(text).catch(() => undefined);
            }}>
              <Copy />{t("macosMenu.copy")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={pasteFromClipboard}>
              <ClipboardPaste />{t("macosMenu.paste")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => xtermRef.current?.selectAll()}>
              <SquareDashed />{t("macosMenu.selectAll")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => {
              menuFocus.current = "search";
              setSearching(true);
            }}>
              <Search />{t("terminal.search.placeholder")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => xtermRef.current?.clear()}>
              <Eraser />{t("terminal.menu.clear")}
            </ContextMenuItem>
            {paneMenu && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem disabled={!paneMenu.split} onSelect={() => {
                  menuFocus.current = "managed";
                  paneMenu.split?.("horizontal");
                }}>
                  <Columns2 />{t("tabs.splitRight")}
                </ContextMenuItem>
                <ContextMenuItem disabled={!paneMenu.split} onSelect={() => {
                  menuFocus.current = "managed";
                  paneMenu.split?.("vertical");
                }}>
                  <Rows2 />{t("tabs.splitDown")}
                </ContextMenuItem>
              </>
            )}
            {paneId !== undefined && (
              <>
                <ContextMenuSeparator />
                {broadcast && <SnippetMenu broadcast={broadcast} paneId={paneId} hostId={paneMenu?.hostId} onRun={(snippet) => {
                  if (snippetRunner.run(snippet)) menuFocus.current = "managed";
                }} />}
                <TerminalOutputMenuItems paneId={paneId} />
              </>
            )}
          </ContextMenuContent>
        )}
      </ContextMenu>
      {linkDestination && (
        <div
          role="tooltip"
          dir="ltr"
          className="pointer-events-none absolute inset-x-3 bottom-2 z-10 w-fit max-w-full wrap-anywhere rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm"
        >
          {linkDestination}
        </div>
      )}
      {searching && <TerminalSearchBar inputRef={searchInputRef} results={results} onFind={find} onClose={closeSearch} />}
      {snippetRunner.dialog}
      <CommandHistoryDialog
        hostId={active && historyHost === historyHostId ? historyHost : undefined}
        onClose={() => setHistoryHost(undefined)}
        onCloseAutoFocus={restoreTerminalFocus}
        onPaste={(command) => {
          const xterm = xtermRef.current;
          if (!xterm || xterm.buffer.active.type !== "normal" || !canPasteHistory?.()) return "promptUnavailable";
          // Only a bracketed paste can carry CR, LF or Tab without acting as a key.
          // Reject other control characters, including an embedded end-paste sequence.
          const bracketed = xterm.modes.bracketedPasteMode && !xterm.options.ignoreBracketedPasteMode;
          if (/(?![\t\r\n])\p{Cc}/u.test(command) || (!bracketed && /[\t\r\n]/.test(command))) return "unsafePaste";
          applyPaste(command, undefined);
          setHistoryHost(undefined);
        }}
      />
      <PasteConfirmDialog
        paste={pendingPaste?.preview ?? null}
        onCloseAutoFocus={restoreTerminalFocus}
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
