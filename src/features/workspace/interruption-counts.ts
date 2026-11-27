import { isFinished } from "@/features/transfers/transfersStore";
import type { ForwardEvent } from "@/lib/ipc/forwards";
import type { Host } from "@/lib/ipc/hosts";
import type { Transfer } from "@/lib/ipc/transfers";

export interface InterruptionCounts {
  connections: number;
  transfers: number;
  forwards: number;
}

/** The activity lost on restart or quit, from the workspace's live Connections and running rules. */
export function interruptionCounts(
  connected: readonly Host[],
  transfers: readonly Transfer[],
  runningForwards: readonly ForwardEvent[],
): InterruptionCounts {
  return {
    connections: connected.length,
    transfers: transfers.filter((transfer) => !isFinished(transfer)).length,
    forwards: runningForwards.length,
  };
}
