import type { ForwardKind, ForwardType } from "@/lib/ipc/forwards";

/** Where a forward's connections go. */
export interface ForwardTarget {
  host: string;
  port: number;
}

type RuleOf<T extends ForwardType> = Extract<ForwardKind, { type: T }>;
/** A kind's own fields: its `type` and target, without the listening end every kind has. */
type KindFields<T extends ForwardType> = RuleOf<T> extends infer R ? (R extends unknown ? Omit<R, "bindAddress" | "bindPort"> : never) : never;

/** What differs between local, remote and dynamic Port forwards; the one place that switches on `type`. */
export interface ForwardKindInfo<T extends ForwardType> {
  /** The address a blank bind address stands for. */
  defaultBindAddress: string;
  /** Whether the rule names where connections go (a dynamic forward's clients choose). */
  hasTarget: boolean;
  /** Where connections go, or `null` for a kind without a target. */
  target(rule: RuleOf<T>): ForwardTarget | null;
  /** The kind's own fields for `target` (ignored by a kind without one). */
  fields(target: ForwardTarget): KindFields<T>;
  /** Status bar copy, given `{ from, to }` from `describeForward`. */
  status: "status.forwardsLocal" | "status.forwardsRemote" | "status.forwardsDynamic";
}

const loopback = "127.0.0.1";
/** Where the server listens for a remote forward by default (`sshastra_core::forward::REMOTE_LOOPBACK`). */
const remoteLoopback = "localhost";

const kinds: { [T in ForwardType]: ForwardKindInfo<T> } = {
  local: {
    defaultBindAddress: loopback,
    hasTarget: true,
    target: (rule) => ({ host: rule.remoteHost, port: rule.remotePort }),
    fields: ({ host, port }) => ({ type: "local", remoteHost: host, remotePort: port }),
    status: "status.forwardsLocal",
  },
  remote: {
    defaultBindAddress: remoteLoopback,
    hasTarget: true,
    target: (rule) => ({ host: rule.localHost, port: rule.localPort }),
    fields: ({ host, port }) => ({ type: "remote", localHost: host, localPort: port }),
    status: "status.forwardsRemote",
  },
  dynamic: {
    defaultBindAddress: loopback,
    hasTarget: false,
    target: () => null,
    fields: () => ({ type: "dynamic" }),
    status: "status.forwardsDynamic",
  },
};

/** The descriptor of a Port forward kind. */
export function forwardKind<T extends ForwardType>(type: T): ForwardKindInfo<T> {
  return kinds[type];
}
