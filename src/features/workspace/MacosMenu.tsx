import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { paletteActions, useRegisteredActions } from "@/features/palette/palette-actions";
import { selectAll } from "@/features/terminal/terminal-selection";
import { shortcutLabel, type ResolvedShortcuts, type ShortcutName, type WorkspaceCommand } from "./shortcuts";

// AppKit can display a key equivalent for these physical keys. For a chord
// that can't be rendered by the native menu, keep its readable label instead.
const nativeNamedKeys = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End",
  "BracketLeft", "BracketRight", "Backquote", "Backslash", "Comma", "Equal", "Minus", "Period",
  "Quote", "Semicolon", "Slash", "Space", "Tab", "Backspace", "Delete", "Enter", "Escape", "Insert",
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal", "NumpadEnter",
  "NumpadEqual", "NumpadComma", "NumpadBackspace",
]);
const nativeNumberedKey = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-9]|2[0-4]))$/;

interface MacosMenuProps {
  shortcuts: ResolvedShortcuts;
  canClosePane: boolean;
  runWorkspaceCommand(command: WorkspaceCommand): void;
}

/** Keeps the native menu in sync with the live command palette and shortcut settings. */
export function MacosMenu({ shortcuts, canClosePane, runWorkspaceCommand }: MacosMenuProps) {
  const { t } = useTranslation();
  const actions = useRegisteredActions();
  const [focused, setFocused] = useState(false);
  const lastSpec = useRef<string | undefined>(undefined);
  const run = useEffectEvent((id: string) => {
    switch (id) {
      case "select-all": return selectAll();
      case "command-palette": return runWorkspaceCommand({ type: "openPalette" });
      case "close-pane": return runWorkspaceCommand({ type: "closePane" });
      default: return paletteActions.list().find((action) => action.id === id)?.run();
    }
  });

  useEffect(() => {
    let active = true;
    const window = getCurrentWebviewWindow();
    const subscription = window.listen<string>("macos-menu-action", ({ payload }) => {
      if (active) run(payload);
    });
    const focus = window.onFocusChanged(({ payload }) => {
      if (active) setFocused(payload);
    });
    void focus.then(() => window.isFocused()).then((value) => {
      if (active) setFocused(value);
    }).catch((error: unknown) => console.warn("Could not read Window focus", error));
    void subscription.catch((error: unknown) => console.warn("Could not listen for macOS menu actions", error));
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten(), () => undefined);
      void focus.then((unlisten) => unlisten(), () => undefined);
    };
  }, []);

  useEffect(() => {
    if (!focused) {
      lastSpec.current = undefined;
      return;
    }
    const item = (id: string, title: string, enabled: boolean, name?: ShortcutName) => {
      const binding = name && shortcuts.bindings.find((binding) => binding.name === name);
      if (!binding || !name) return { id, title, enabled };
      if (binding.code && (nativeNamedKeys.has(binding.code) || nativeNumberedKey.test(binding.code))) {
        return { id, title, enabled, accelerator: [...binding.mods, binding.code].join("+") };
      }
      return { id, title: `${title} (${shortcutLabel(name, shortcuts)})`, enabled };
    };
    const paletteItem = (id: string, fallback: string, shortcut?: ShortcutName) => {
      const action = actions.find((candidate) => candidate.id === id);
      return item(id, action?.title ?? fallback, Boolean(action), shortcut);
    };
    const spec = {
      labels: {
        about: t("macosMenu.about"), services: t("macosMenu.services"),
        hide: t("macosMenu.hide"), hideOthers: t("macosMenu.hideOthers"), showAll: t("macosMenu.showAll"),
        file: t("quit.menuFile"), edit: t("macosMenu.edit"), view: t("macosMenu.view"),
        window: t("macosMenu.window"), help: t("macosMenu.help"),
        undo: t("macosMenu.undo"), redo: t("macosMenu.redo"), cut: t("macosMenu.cut"),
        copy: t("macosMenu.copy"), paste: t("macosMenu.paste"), selectAll: t("macosMenu.selectAll"),
        fullscreen: t("macosMenu.fullscreen"), minimize: t("macosMenu.minimize"),
        zoom: t("macosMenu.zoom"), bringAllToFront: t("macosMenu.bringAllToFront"),
      },
      application: [
        paletteItem("settings.open", t("palette.actions.openSettings"), "settings"),
        paletteItem("updates.check", t("updates.check")),
      ],
      file: [
        paletteItem("window.new", t("window.new"), "newWindow"),
        paletteItem("terminal.newLocal", t("tabs.newLocalTerminal"), "newTab"),
        paletteItem("files.openSftp", t("sftp.open")),
        item("close-pane", t("settings.shortcuts.actions.closePane"), canClosePane, "closePane"),
      ],
      view: [
        item("command-palette", t("palette.title"), true, "commandPalette"),
        paletteItem("home.open", t("palette.actions.goHome")),
        paletteItem("transfers.open", t("transfers.open")),
        paletteItem("workspace.splitRight", t("tabs.splitRight"), "splitRight"),
        paletteItem("workspace.splitDown", t("tabs.splitDown"), "splitDown"),
        paletteItem("workspace.toggleMaximizePane", t("tabs.maximizePane"), "toggleMaximizePane"),
      ],
      help: [
        paletteItem("diagnostics.openLogs", t("settings.diagnostics.open")),
        paletteItem("diagnostics.copy", t("settings.diagnostics.copy")),
      ],
    };
    const next = JSON.stringify(spec);
    if (lastSpec.current === next) return;
    lastSpec.current = next;
    void invoke("macos_menu_set", { spec }).catch((error: unknown) => {
      if (lastSpec.current === next) lastSpec.current = undefined;
      console.warn("Could not update the macOS menu", error);
    });
  }, [actions, canClosePane, focused, shortcuts, t]);

  return null;
}
