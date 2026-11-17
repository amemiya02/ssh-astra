import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { refusal, type ConnectPrompt, type PromptAnswer } from "@/lib/ipc/connect";

interface Props {
  prompt: ConnectPrompt;
  /** False while the asking tab is hidden; the question stays pending. */
  open: boolean;
  onAnswer: (answer: PromptAnswer) => void;
}

/** A question asked while connecting: trust a new host key, or type a password. Escape refuses. */
export function ConnectPromptDialog({ prompt, open, onAnswer }: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onAnswer(refusal(prompt));
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] gap-3.5 p-5 sm:max-w-130">
        {prompt.type === "hostKey" ? (
          <HostKeyQuestion prompt={prompt} onAnswer={onAnswer} />
        ) : (
          <PasswordQuestion key={prompt.id} prompt={prompt} onAnswer={onAnswer} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function HostKeyQuestion({
  prompt,
  onAnswer,
}: {
  prompt: Extract<ConnectPrompt, { type: "hostKey" }>;
  onAnswer: Props["onAnswer"];
}) {
  const { t } = useTranslation();
  const target = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("connect.hostKey.title")}</DialogTitle>
        <DialogDescription>{t("connect.hostKey.body", { host: target })}</DialogDescription>
      </DialogHeader>
      <dl className="bg-muted rounded-lg border px-3.5 py-3">
        <dt className="text-muted-foreground text-xs">
          {t("connect.hostKey.fingerprintLabel", { algorithm: prompt.algorithm })}
        </dt>
        <dd className="mt-1 font-mono break-all select-all">{prompt.fingerprint}</dd>
      </dl>
      <p className="text-muted-foreground text-xs">{t("connect.hostKey.hint")}</p>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => onAnswer({ type: "hostKey", trust: false })}>
          {t("connect.cancel")}
        </Button>
        <Button size="sm" autoFocus onClick={() => onAnswer({ type: "hostKey", trust: true })}>
          {t("connect.hostKey.trust")}
        </Button>
      </DialogFooter>
    </>
  );
}

function PasswordQuestion({
  prompt,
  onAnswer,
}: {
  prompt: Extract<ConnectPrompt, { type: "password" }>;
  onAnswer: Props["onAnswer"];
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const inputId = `prompt-${prompt.id}-password`;
  return (
    <form
      className="grid gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer({ type: "password", password });
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("connect.password.title", { user: prompt.user, host: prompt.host })}</DialogTitle>
        <DialogDescription>{t("connect.password.description")}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={inputId} className="text-xs">
          {t("connect.password.label")}
        </Label>
        <Input
          id={inputId}
          type="password"
          autoFocus
          autoComplete="off"
          className="h-8"
          aria-invalid={prompt.retry || undefined}
          aria-describedby={prompt.retry ? `${inputId}-retry` : undefined}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {prompt.retry && (
          <p id={`${inputId}-retry`} role="alert" className="text-destructive text-xs">
            {t("connect.password.retry")}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onAnswer({ type: "password", password: null })}
        >
          {t("connect.cancel")}
        </Button>
        <Button type="submit" size="sm">
          {t("connect.password.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
