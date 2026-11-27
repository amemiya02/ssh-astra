import { useEffect, useState } from "react";
import { listLocalShells, type LocalShell } from "@/lib/ipc/terminal";

/** Refreshes discovery when the setting or shell chooser is opened. */
export function useLocalShells() {
  const [shells, setShells] = useState<LocalShell[] | "loading" | "failed">("loading");
  useEffect(() => {
    let mounted = true;
    void listLocalShells().then(
      (list) => { if (mounted) setShells(list); },
      () => { if (mounted) setShells("failed"); },
    );
    return () => { mounted = false; };
  }, []);
  return shells;
}
