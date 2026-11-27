import { useEffect, useState } from "react";
import { readCommandError } from "@/lib/ipc/connect";
import type { HostId } from "@/lib/ipc/hosts";
import { listSnippets, type Snippet } from "@/lib/ipc/snippets";

type Library = { status: "loading" } | { status: "ready"; snippets: Snippet[] } | { status: "error"; message: string };

export function visibleOnHost(snippet: Snippet, hostId?: HostId): boolean {
  return snippet.hostIds.length === 0 || (hostId !== undefined && snippet.hostIds.includes(hostId));
}

export function useSnippetLibrary() {
  const [library, setLibrary] = useState<Library>({ status: "loading" });
  useEffect(() => {
    let current = true;
    void listSnippets().then(
      (snippets) => { if (current) setLibrary({ status: "ready", snippets }); },
      (error: unknown) => { if (current) setLibrary({ status: "error", message: readCommandError(error).message }); },
    );
    return () => { current = false; };
  }, []);
  return [library, setLibrary] as const;
}
