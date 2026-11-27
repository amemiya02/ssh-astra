import type { ParseKeys } from "i18next";
import type { ForwardKind, ForwardType } from "@/lib/ipc/forwards";

/** Where a forward's connections go. */
export interface ForwardTarget {
  host: string;
  port: number;
}

type RuleOf<T extends ForwardType> = Extract<ForwardKind, { type: T }>;
/** A kind's own fields: its `type` and target, without the listening end every kind has. */
type KindFields<T extends ForwardType> = RuleOf<T> extends infer R ? (R extends unknown ? Omit<R, "bindAddress" | "bindPort"> : never) : never;

type TextField = "label" | "bindPort" | "targetHost" | "targetPort" | "bindAddress";
type FieldLabel = Extract<ParseKeys, "forwards.fields.label" | `forwards.fieldsByType.${string}`>;
type FieldHint = Extract<ParseKeys, `forwards.hints.${string}`>;
type FormField = { field: TextField; label: FieldLabel; hint?: FieldHint };

/** What differs between Port forward kinds. */
export interface ForwardKindInfo<T extends ForwardType> {
  /** The address a blank bind address stands for. */
  defaultBindAddress: string;
  /** Whether the rule names where connections go (proxy clients choose). */
  hasTarget: boolean;
  /** Where connections go, or `null` for a kind without a target. */
  target(rule: RuleOf<T>): ForwardTarget | null;
  /** The kind's own fields for `target` (ignored by a kind without one). */
  fields(target: ForwardTarget): KindFields<T>;
  /** The editor's text fields, in display order. */
  layout: readonly FormField[];
  /** Status bar copy, given `{ from, to }` from `describeForward`. */
  status: "status.forwardsLocal" | "status.forwardsRemote" | "status.forwardsDynamic" | "status.forwardsHttp";
}

const loopback = "127.0.0.1";
/** Where the server listens for a remote forward by default (`sshastra_core::forward::REMOTE_LOOPBACK`). */
const remoteLoopback = "localhost";
const nameField = { field: "label", label: "forwards.fields.label" } as const;
const proxyLayout: readonly FormField[] = [
  nameField,
  { field: "bindPort", label: "forwards.fieldsByType.proxy.bindPort" },
  { field: "bindAddress", label: "forwards.fieldsByType.proxy.bindAddress", hint: "forwards.hints.proxy.bindAddress" },
];

const kinds: { [T in ForwardType]: ForwardKindInfo<T> } = {
  local: {
    defaultBindAddress: loopback,
    hasTarget: true,
    target: (rule) => ({ host: rule.remoteHost, port: rule.remotePort }),
    fields: ({ host, port }) => ({ type: "local", remoteHost: host, remotePort: port }),
    layout: [
      nameField,
      { field: "bindPort", label: "forwards.fieldsByType.local.bindPort" },
      { field: "targetHost", label: "forwards.fieldsByType.local.targetHost", hint: "forwards.hints.local.targetHost" },
      { field: "targetPort", label: "forwards.fieldsByType.local.targetPort" },
      { field: "bindAddress", label: "forwards.fieldsByType.local.bindAddress", hint: "forwards.hints.local.bindAddress" },
    ],
    status: "status.forwardsLocal",
  },
  remote: {
    defaultBindAddress: remoteLoopback,
    hasTarget: true,
    target: (rule) => ({ host: rule.localHost, port: rule.localPort }),
    fields: ({ host, port }) => ({ type: "remote", localHost: host, localPort: port }),
    layout: [
      nameField,
      { field: "bindPort", label: "forwards.fieldsByType.remote.bindPort" },
      { field: "targetHost", label: "forwards.fieldsByType.remote.targetHost", hint: "forwards.hints.remote.targetHost" },
      { field: "targetPort", label: "forwards.fieldsByType.remote.targetPort" },
      { field: "bindAddress", label: "forwards.fieldsByType.remote.bindAddress", hint: "forwards.hints.remote.bindAddress" },
    ],
    status: "status.forwardsRemote",
  },
  dynamic: {
    defaultBindAddress: loopback,
    hasTarget: false,
    target: () => null,
    fields: () => ({ type: "dynamic" }),
    layout: proxyLayout,
    status: "status.forwardsDynamic",
  },
  http: {
    defaultBindAddress: loopback,
    hasTarget: false,
    target: () => null,
    fields: () => ({ type: "http" }),
    layout: proxyLayout,
    status: "status.forwardsHttp",
  },
};

export const forwardTypes = Object.keys(kinds) as ForwardType[];

/** The descriptor of a Port forward kind. */
export function forwardKind<T extends ForwardType>(type: T): ForwardKindInfo<T> {
  return kinds[type];
}
