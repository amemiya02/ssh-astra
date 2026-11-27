import { createContext } from "react";
import type { SplitOrientation } from "@/features/workspace/tabs";
import type { HostId } from "@/lib/ipc/hosts";

export const TerminalPaneMenuContext = createContext<{
  hostId?: HostId;
  split?(orientation: SplitOrientation): void;
} | undefined>(undefined);
