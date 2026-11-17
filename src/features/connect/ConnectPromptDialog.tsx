import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectPrompt, PromptAnswer } from "@/lib/ipc/connect";

interface Props {
  prompt: ConnectPrompt;
  onAnswer: (answer: PromptAnswer) => void;
}

const buttonBase = "rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring";

/** A question asked while connecting: trust a new host key, or type a password. */
export function ConnectPromptDialog({ prompt, onAnswer }: Props) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`prompt-${prompt.id}-title`}
        className="bg-popover text-popover-foreground w-full max-w-md rounded-lg border p-5 shadow-lg"
      >
        {prompt.type === "hostKey" ? (
          <HostKeyQuestion prompt={prompt} onAnswer={onAnswer} />
        ) : (
          <PasswordQuestion key={prompt.id} prompt={prompt} onAnswer={onAnswer} />
        )}
      </div>
    </div>
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
