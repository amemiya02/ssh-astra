import Markdown, { type ReactRenderer } from "marked-react";
import { Fragment, memo, useId } from "react";
import { useTranslation } from "react-i18next";
import { externalLinkDestination } from "@/lib/external-link";
import { openExternalUrl } from "@/lib/ipc/system";
import { cn } from "@/lib/utils";

// Render Markdown into React nodes without adding raw HTML or image URLs to the DOM.
const renderer: Partial<ReactRenderer> = {
  html: () => null,
  image() {
    return <Fragment key={`image-${this.elementId}`} />;
  },
  link(href, children) {
    const key = `link-${this.elementId}`;
    const url = externalLinkDestination(href);
    if (!url || !/^https?:/.test(url)) return <Fragment key={key}>{children}</Fragment>;
    return (
      <a
        key={key}
        href={url}
        title={url}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2"
        onClick={(event) => {
          event.preventDefault();
          void openExternalUrl(url).catch(() => undefined);
        }}
        onAuxClick={(event) => event.preventDefault()}
      >
        {children}
      </a>
    );
  },
};

export const ReleaseNotes = memo(function ReleaseNotes({ notes }: { notes?: string }) {
  const { t } = useTranslation();
  const heading = useId();
  return (
    <section className="min-w-0 space-y-1.5 text-sm">
      <h3 id={heading} className="font-medium">{t("updates.releaseNotes")}</h3>
      {notes?.trim() ? (
        <div
          tabIndex={0}
          aria-labelledby={heading}
          role="region"
          className={cn(
            "max-h-[min(18rem,35vh)] space-y-2 overflow-auto rounded-lg border p-3 [overflow-wrap:anywhere]",
            "[&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:pl-2",
            "[&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc",
            "[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_pre_code]:p-0",
            "[&_pre]:overflow-x-auto [&_pre]:rounded-sm [&_pre]:bg-muted [&_pre]:p-2",
            "[&_:is(td,th)]:border [&_:is(td,th)]:px-2",
          )}
        >
          <Markdown value={notes} renderer={renderer} />
        </div>
      ) : (
        <p className="text-muted-foreground">{t("updates.noReleaseNotes")}</p>
      )}
    </section>
  );
});
