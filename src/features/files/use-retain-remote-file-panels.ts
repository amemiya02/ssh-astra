import { useEffect } from "react";
import { fileBrowsers } from "./fileBrowsers";
import { terminalCwds } from "./terminalCwds";

/** Releases the dock's file sessions for terminals that have closed. */
export function useRetainRemoteFilePanels(remotePaneIds: string[]) {
  const key = remotePaneIds.join("\n");
  useEffect(() => {
    const ids = new Set(key ? key.split("\n") : []);
    fileBrowsers.retain(ids);
    terminalCwds.retain(ids);
  }, [key]);
}
