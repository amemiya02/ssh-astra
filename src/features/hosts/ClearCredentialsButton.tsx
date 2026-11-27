import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { readCommandError } from "@/lib/ipc/connect";
import { clearHostCredentials } from "@/lib/ipc/credentials";
import type { HostId } from "@/lib/ipc/hosts";

type State = { status: "idle" | "clearing" | "cleared" } | { status: "failed"; message: string };

/** In the Host editor: forgets the Host's saved credentials. */
export function ClearCredentialsButton({ hostId }: { hostId: HostId }) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: "idle" });
  return (
    <div className="grid gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-self-start"
        disabled={state.status === "clearing"}
        onClick={() => {
          setState({ status: "clearing" });
          clearHostCredentials(hostId).then(
            () => setState({ status: "cleared" }),
            (e: unknown) => setState({ status: "failed", message: readCommandError(e).message }),
          );
        }}
      >
        {t("hosts.clearCredentials")}
      </Button>
      {state.status === "cleared" && (
        <p role="status" className="text-muted-foreground text-xs">
          {t("hosts.credentialsCleared")}
        </p>
      )}
      {state.status === "failed" && (
        <p role="alert" className="text-destructive text-xs">
          {state.message}
        </p>
      )}
    </div>
  );
}
