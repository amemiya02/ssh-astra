import { describe, expect, it } from "vitest";
import { emptyHostForm, hostFormFrom, parseHostForm } from "./hostForm";

const valid = { name: " web ", address: " 10.0.0.5 ", port: "2222", user: " deploy " };

describe("parseHostForm", () => {
  it("turns the form into a trimmed HostDraft with password auth", () => {
    expect(parseHostForm(valid)).toEqual({
      ok: true,
      draft: { name: "web", address: "10.0.0.5", port: 2222, user: "deploy", auth: { type: "password" } },
    });
  });

  it("defaults an empty port to 22", () => {
    const result = parseHostForm({ ...valid, port: " " });
    expect(result.ok && result.draft.port).toBe(22);
  });

  it("reports every missing or invalid field", () => {
    const result = parseHostForm({ name: "", address: " ", port: "70000", user: "" });
    expect(result).toEqual({ ok: false, errors: { name: "required", address: "required", user: "required", port: "port" } });
    expect(parseHostForm({ ...valid, port: "22a" })).toEqual({ ok: false, errors: { port: "port" } });
    expect(parseHostForm({ ...valid, port: "0" })).toEqual({ ok: false, errors: { port: "port" } });
  });
});

describe("hostFormFrom", () => {
  it("round-trips a saved Host through the form", () => {
    const host = { id: "1", name: "db", address: "db.local", port: 22, user: "root", auth: { type: "password" as const } };
    const form = hostFormFrom(host);
    expect(form).toEqual({ name: "db", address: "db.local", port: "22", user: "root" });
    expect(parseHostForm(form)).toEqual({ ok: true, draft: { ...host, id: undefined } });
  });

  it("round-trips a Host's own Terminal colour scheme", () => {
    const host = {
      id: "1",
      name: "prod",
      address: "prod.local",
      port: 22,
      user: "root",
      auth: { type: "password" as const },
      terminalScheme: "ember",
    };
    const form = hostFormFrom(host);
    expect(form.terminalScheme).toBe("ember");
    expect(parseHostForm(form)).toEqual({ ok: true, draft: { ...host, id: undefined } });
  });

  it("drops a scheme this build does not know, so the Host follows the global scheme", () => {
    const host = { id: "1", name: "a", address: "b", port: 22, user: "c", auth: { type: "password" as const } };
    expect(hostFormFrom({ ...host, terminalScheme: "retired" }).terminalScheme).toBeUndefined();
  });

  it("starts new Hosts on port 22", () => {
    expect(emptyHostForm.port).toBe("22");
  });
});
