import { isTemporaryHost, type Host } from "@/lib/ipc/hosts";
import type { SshLinkTarget } from "@/lib/ipc/ssh-links";

/** A link can select a saved route only when its destination names a single saved Host. */
export function matchSshLink(hosts: readonly Host[], target: SshLinkTarget): Host | undefined {
  const matches = hosts.filter((host) => !isTemporaryHost(host) &&
    host.address === target.address && host.port === target.port && host.user === target.user);
  return matches.length === 1 ? matches[0] : undefined;
}
