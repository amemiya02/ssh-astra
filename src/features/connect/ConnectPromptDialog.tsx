import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

/**
 * A question asked while connecting: trust a new host key, type a password or
 * key passphrase, or answer the server's keyboard-interactive questions.
 * Escape refuses.
 */
export function ConnectPromptDialog({ prompt, open, onAnswer }: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onAnswer(refusal(prompt));
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] gap-3.5 p-5 sm:max-w-130">
        <Question key={prompt.id} prompt={prompt} onAnswer={onAnswer} />
      </DialogContent>
    </Dialog>
  );
}

function Question({ prompt, onAnswer }: Omit<Props, "open">) {
  switch (prompt.type) {
    case "hostKey":
      return <HostKeyQuestion prompt={prompt} onAnswer={onAnswer} />;
    case "password":
      return <PasswordQuestion prompt={prompt} onAnswer={onAnswer} />;
    case "passphrase":
      return <PassphraseQuestion prompt={prompt} onAnswer={onAnswer} />;
    case "keyboardInteractive":
      return <KeyboardInteractiveQuestion prompt={prompt} onAnswer={onAnswer} />;
  }
}

/**
 * "Save in the system keychain" for a password or passphrase, or why it is
 * not offered (no keychain, e.g. Linux without a Secret Service).
 */
function SaveField({
  id,
  canSave,
  checked,
  onChange,
}: {
  id: string;
  canSave: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  if (!canSave) {
    return <p className="text-muted-foreground text-xs">{t("connect.save.unavailable")}</p>;
  }
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <Label htmlFor={id} className="text-xs font-normal">
        {t("connect.save.label")}
      </Label>
    </div>
  );
}

/** Cancel + submit for the form-shaped questions. */
function FormFooter({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <DialogFooter>
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>
        {t("connect.cancel")}
      </Button>
      <Button type="submit" size="sm">
        {t("connect.password.submit")}
      </Button>
    </DialogFooter>
  );
}

function PassphraseQuestion({
  prompt,
  onAnswer,
}: {
  prompt: Extract<ConnectPrompt, { type: "passphrase" }>;
  onAnswer: Props["onAnswer"];
}) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [save, setSave] = useState(false);
  const inputId = `prompt-${prompt.id}-passphrase`;
  return (
    <form
      className="grid gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer({ type: "passphrase", passphrase, save: prompt.canSave && save });
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("connect.passphrase.title")}</DialogTitle>
        <DialogDescription className="font-mono break-all">{prompt.keyPath}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={inputId} className="text-xs">
          {t("connect.passphrase.label")}
        </Label>
        <Input
          id={inputId}
          type="password"
          autoFocus
          autoComplete="off"
          className="h-8"
          aria-invalid={prompt.retry || undefined}
          aria-describedby={prompt.retry ? `${inputId}-retry` : undefined}
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
        />
        {prompt.retry && (
          <p id={`${inputId}-retry`} role="alert" className="text-destructive text-xs">
            {t("connect.passphrase.retry")}
          </p>
        )}
      </div>
      <SaveField id={`${inputId}-save`} canSave={prompt.canSave} checked={save} onChange={setSave} />
      <FormFooter onCancel={() => onAnswer({ type: "passphrase", passphrase: null })} />
    </form>
  );
}

/** The server's questions (e.g. a one-time code), one field each, as sent. */
function KeyboardInteractiveQuestion({
  prompt,
  onAnswer,
}: {
  prompt: Extract<ConnectPrompt, { type: "keyboardInteractive" }>;
  onAnswer: Props["onAnswer"];
}) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState(() => prompt.prompts.map(() => ""));
  return (
    <form
      className="grid gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer({ type: "keyboardInteractive", answers });
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {prompt.name || t("connect.keyboardInteractive.title", { user: prompt.user, host: prompt.host })}
        </DialogTitle>
        <DialogDescription className="whitespace-pre-line">
          {prompt.instructions || t("connect.keyboardInteractive.description")}
        </DialogDescription>
      </DialogHeader>
      {prompt.prompts.map((question, index) => {
        const inputId = `prompt-${prompt.id}-answer-${index}`;
        return (
          <div key={index} className="grid gap-1.5">
            <Label htmlFor={inputId} className="text-xs whitespace-pre-line">
              {question.text}
            </Label>
            <Input
              id={inputId}
              type={question.echo ? "text" : "password"}
              autoFocus={index === 0}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-8"
              value={answers[index]}
              onChange={(event) => {
                const value = event.target.value;
                setAnswers((all) => all.map((a, i) => (i === index ? value : a)));
              }}
            />
          </div>
        );
      })}
      <FormFooter onCancel={() => onAnswer({ type: "keyboardInteractive", answers: null })} />
    </form>
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
  const [save, setSave] = useState(false);
  const inputId = `prompt-${prompt.id}-password`;
  return (
    <form
      className="grid gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer({ type: "password", password, save: prompt.canSave && save });
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
      <SaveField id={`${inputId}-save`} canSave={prompt.canSave} checked={save} onChange={setSave} />
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
