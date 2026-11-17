import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectPrompt, PromptAnswer } from "@/lib/ipc/connect";

interface Props {
  prompt: ConnectPrompt;
  onAnswer: (answer: PromptAnswer) => void;
}

const buttonBase = "rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring";

/**
 * A question asked while connecting: trust a new host key, type a password or
 * key passphrase, or answer the server's keyboard-interactive questions.
 */
export function ConnectPromptDialog({ prompt, onAnswer }: Props) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`prompt-${prompt.id}-title`}
        className="bg-popover text-popover-foreground w-full max-w-md rounded-lg border p-5 shadow-lg"
      >
        <Question key={prompt.id} prompt={prompt} onAnswer={onAnswer} />
      </div>
    </div>
  );
}

function Question({ prompt, onAnswer }: Props) {
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

const inputClass =
  "bg-background focus-visible:outline-ring mt-1 w-full rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2";

/** Cancel + submit buttons for the form-shaped questions. */
function FormButtons({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mt-5 flex justify-end gap-2">
      <button type="button" className={`${buttonBase} border`} onClick={onCancel}>
        {t("connect.cancel")}
      </button>
      <button type="submit" className={`${buttonBase} bg-primary text-primary-foreground`}>
        {t("connect.password.submit")}
      </button>
    </div>
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
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer({ type: "passphrase", passphrase });
      }}
    >
      <h2 id={`prompt-${prompt.id}-title`} className="text-base font-semibold">
        {t("connect.passphrase.title")}
      </h2>
      <p className="text-muted-foreground mt-2 font-mono text-xs break-all">{prompt.keyPath}</p>
      {prompt.retry && (
        <p role="alert" className="text-destructive mt-2 text-sm">
          {t("connect.passphrase.retry")}
        </p>
      )}
      <input
        type="password"
        autoFocus
        aria-label={t("connect.passphrase.label")}
        autoComplete="off"
        className={`${inputClass} mt-3`}
        value={passphrase}
        onChange={(event) => setPassphrase(event.target.value)}
      />
      <FormButtons onCancel={() => onAnswer({ type: "passphrase", passphrase: null })} />
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
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer({ type: "keyboardInteractive", answers });
      }}
    >
      <h2 id={`prompt-${prompt.id}-title`} className="text-base font-semibold">
        {prompt.name || t("connect.keyboardInteractive.title", { user: prompt.user, host: prompt.host })}
      </h2>
      {prompt.instructions && (
        <p className="text-muted-foreground mt-2 text-sm whitespace-pre-line">{prompt.instructions}</p>
      )}
      {prompt.prompts.map((question, index) => (
        <label key={index} className="mt-3 block text-sm">
          <span className="whitespace-pre-line">{question.text}</span>
          <input
            type={question.echo ? "text" : "password"}
            autoFocus={index === 0}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className={inputClass}
            value={answers[index]}
            onChange={(event) => {
              const value = event.target.value;
              setAnswers((all) => all.map((a, i) => (i === index ? value : a)));
            }}
          />
        </label>
      ))}
      <FormButtons onCancel={() => onAnswer({ type: "keyboardInteractive", answers: null })} />
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
      <h2 id={`prompt-${prompt.id}-title`} className="text-base font-semibold">
        {t("connect.hostKey.title")}
      </h2>
      <p className="text-muted-foreground mt-2 text-sm">{t("connect.hostKey.body", { host: target })}</p>
      <dl className="bg-muted mt-3 rounded-md p-3 text-sm">
        <dt className="text-muted-foreground text-xs">{prompt.algorithm}</dt>
        <dd className="mt-1 font-mono break-all select-all">{prompt.fingerprint}</dd>
      </dl>
      <p className="text-muted-foreground mt-3 text-xs">{t("connect.hostKey.hint")}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={`${buttonBase} border`} onClick={() => onAnswer({ type: "hostKey", trust: false })}>
          {t("connect.cancel")}
        </button>
        <button
          type="button"
          autoFocus
          className={`${buttonBase} bg-primary text-primary-foreground`}
          onClick={() => onAnswer({ type: "hostKey", trust: true })}
        >
          {t("connect.hostKey.trust")}
        </button>
      </div>
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
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer({ type: "password", password });
      }}
    >
      <h2 id={`prompt-${prompt.id}-title`} className="text-base font-semibold">
        {t("connect.password.title", { user: prompt.user, host: prompt.host })}
      </h2>
      {prompt.retry && (
        <p role="alert" className="text-destructive mt-2 text-sm">
          {t("connect.password.retry")}
        </p>
      )}
      <input
        type="password"
        autoFocus
        aria-label={t("connect.password.label")}
        autoComplete="off"
        className="bg-background focus-visible:outline-ring mt-3 w-full rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          className={`${buttonBase} border`}
          onClick={() => onAnswer({ type: "password", password: null })}
        >
          {t("connect.cancel")}
        </button>
        <button type="submit" className={`${buttonBase} bg-primary text-primary-foreground`}>
          {t("connect.password.submit")}
        </button>
      </div>
    </form>
  );
}
