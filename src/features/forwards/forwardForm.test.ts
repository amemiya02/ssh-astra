import { describe, expect, it } from "vitest";
import type { PortForward } from "@/lib/ipc/forwards";
import { describeForward, emptyForwardForm, forwardFormFrom, parseForwardForm } from "./forwardForm";

const local: PortForward = {
  id: "f1",
  label: "postgres",
  autoStart: false,
  type: "local",
  bindAddress: "127.0.0.1",
  bindPort: 15432,
  remoteHost: "db.internal",
  remotePort: 5432,
};
const remote: PortForward = {
  id: "f2",
  label: "dev server",
  autoStart: true,
  type: "remote",
  bindAddress: "localhost",
  bindPort: 9000,
  localHost: "127.0.0.1",
  localPort: 3000,
};
const dynamic: PortForward = {
  id: "f3",
  label: "",
  autoStart: false,
  type: "dynamic",
  bindAddress: "127.0.0.1",
  bindPort: 1080,
};

describe("parseForwardForm", () => {
  it("turns the fields into a local forward draft", () => {
    const result = parseForwardForm({
      ...emptyForwardForm("local"),
      label: " postgres ",
      bindPort: "15432",
      targetHost: " db.internal ",
      targetPort: "5432",
    });
    expect(result).toEqual({
      ok: true,
      draft: {
        label: "postgres",
        autoStart: false,
        type: "local",
        bindAddress: "127.0.0.1",
        bindPort: 15432,
        remoteHost: "db.internal",
        remotePort: 5432,
      },
    });
  });

  it("turns the fields into a remote forward draft that listens on the server's loopback by default", () => {
    const result = parseForwardForm({
      ...emptyForwardForm("remote"),
      bindPort: "9000",
      targetHost: "127.0.0.1",
      targetPort: "3000",
      autoStart: true,
    });
    expect(result).toEqual({
      ok: true,
      draft: {
        label: "",
        autoStart: true,
        type: "remote",
        bindAddress: "localhost",
        bindPort: 9000,
        localHost: "127.0.0.1",
        localPort: 3000,
      },
    });
  });

  it("turns the fields into a dynamic forward draft, ignoring any target", () => {
    const result = parseForwardForm({ ...emptyForwardForm("dynamic"), bindPort: "1080", targetHost: "x" });
    expect(result).toEqual({
      ok: true,
      draft: { label: "", autoStart: false, type: "dynamic", bindAddress: "127.0.0.1", bindPort: 1080 },
    });
  });

  it("names each missing or invalid field", () => {
    expect(parseForwardForm(emptyForwardForm("local"))).toEqual({
      ok: false,
      errors: { bindPort: "port", targetHost: "required", targetPort: "port" },
    });
    expect(
      parseForwardForm({ ...emptyForwardForm("remote"), bindPort: "0", targetHost: "web", targetPort: "70000" }),
    ).toEqual({ ok: false, errors: { bindPort: "port", targetPort: "port" } });
    expect(parseForwardForm({ ...emptyForwardForm("dynamic"), bindPort: "80a" })).toEqual({
      ok: false,
      errors: { bindPort: "port" },
    });
  });

  it("round-trips saved rules of every kind through the form", () => {
    for (const rule of [local, remote, dynamic]) {
      const draft: Partial<PortForward> = { ...rule };
      delete draft.id;
      expect(parseForwardForm(forwardFormFrom(rule))).toEqual({ ok: true, draft });
    }
  });
});

describe("describeForward", () => {
  it("shows where a local forward listens and where it goes", () => {
    expect(describeForward(local)).toEqual({ from: "localhost:15432", to: "db.internal:5432" });
    expect(describeForward({ ...local, bindAddress: "0.0.0.0" }).from).toBe("0.0.0.0:15432");
    expect(describeForward({ ...local, remoteHost: "::1" }).to).toBe("[::1]:5432");
  });

  it("shows a remote forward's port on the server and its target here", () => {
    expect(describeForward(remote)).toEqual({ from: "localhost:9000", to: "127.0.0.1:3000" });
  });

  it("shows only where a dynamic forward listens", () => {
    expect(describeForward(dynamic)).toEqual({ from: "localhost:1080", to: null });
  });
});
