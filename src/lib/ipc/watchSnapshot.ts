/**
 * A native watch installs a channel and returns its initial snapshot. Channel messages
 * can reach JS before the command reply. Apply the snapshot first, then drain that
 * channel in order. A later registration supersedes the previous channel.
 */
export function createSnapshotWatch<S, E>(
  register: (receive: (event: E) => void) => Promise<S>,
  replace: (snapshot: S) => void,
  apply: (event: E) => void,
): () => Promise<void> {
  let active: ((event: E) => void) | undefined;
  let registering: Promise<void> | undefined;

  return () => {
    if (registering) return registering;
    const pending: E[] = [];
    let buffering = true;
    const receive = (event: E) => {
      if (buffering) pending.push(event);
      else if (active === receive) apply(event);
    };
    registering = register(receive).then((snapshot) => {
      active = receive;
      replace(snapshot);
      for (const event of pending) apply(event);
      buffering = false;
    }).finally(() => {
      buffering = false;
      pending.length = 0;
      registering = undefined;
    });
    return registering;
  };
}
