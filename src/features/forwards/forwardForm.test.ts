import { describe, expect, it } from "vitest";
import type { PortForward } from "@/lib/ipc/forwards";
import { describeForward, emptyForwardForm, forwardFormFrom, parseForwardForm } from "./forwardForm";

const rule: PortForward = {
  id: "f1",
  label: "postgres",
  type: "local",
  bindAddress: "127.0.0.1",
  bindPort: 15432,
  remoteHost: "db.internal",
  remotePort: 5432,
};

describe("parseForwardForm", () => {
  it("turns the fields into a local forward draft", () => {
    const result = parseForwardForm({
      label: " postgres ",
      bindAddress: "",
      bindPort: "15432",
      remoteHost: " db.internal ",
      remotePort: "5432",
    });
    expect(result).toEqual({
      ok: true,
      draft: {
        label: "postgres",
        type: "local",
        bindAddress: "127.0.0.1",
        bindPort: 15432,
        remoteHost: "db.internal",
        remotePort: 5432,
      },
    });
  });

  it("names each missing or invalid field", () => {
    expect(parseForwardForm(emptyForwardForm)).toEqual({
      ok: false,
      errors: { bindPort: "port", remoteHost: "required", remotePort: "port" },
    });
    expect(
      parseForwardForm({ ...emptyForwardForm, bindPort: "0", remoteHost: "web", remotePort: "70000" }),
    ).toEqual({ ok: false, errors: { bindPort: "port", remotePort: "port" } });
    expect(parseForwardForm({ ...emptyForwardForm, bindPort: "80a", remoteHost: "web", remotePort: "80" })).toEqual({
      ok: false,
      errors: { bindPort: "port" },
    });
  });

  it("round-trips a saved rule through the form", () => {
    const { label, type, bindAddress, bindPort, remoteHost, remotePort } = rule;
    const draft = { label, type, bindAddress, bindPort, remoteHost, remotePort };
    expect(parseForwardForm(forwardFormFrom(rule))).toEqual({ ok: true, draft });
  });
});

describe("describeForward", () => {
  it("shows where it listens and where it goes", () => {
    expect(describeForward(rule)).toEqual({ from: "localhost:15432", to: "db.internal:5432" });
    expect(describeForward({ ...rule, bindAddress: "0.0.0.0" }).from).toBe("0.0.0.0:15432");
    expect(describeForward({ ...rule, remoteHost: "::1" }).to).toBe("[::1]:5432");
  });
});
