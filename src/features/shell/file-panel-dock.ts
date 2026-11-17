import { createContext, useContext } from "react";
import type { FilePanelDock } from "./shell-layout";

/** What the File panel's content may know and do about the dock it lives in. */
export interface FilePanelDockValue {
  dock: FilePanelDock;
  collapse(): void;
}

export const FilePanelDockContext = createContext<FilePanelDockValue | null>(null);

/** For content rendered in `AppShell`'s File panel slot. */
export function useFilePanelDock(): FilePanelDockValue {
  const value = useContext(FilePanelDockContext);
  if (!value) throw new Error("useFilePanelDock must be used inside AppShell's filePanel slot");
  return value;
}
