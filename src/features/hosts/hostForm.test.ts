import { describe, expect, it } from "vitest";
import { emptyHostForm, hostFormFrom, parseHostForm } from "./hostForm";

const valid = {
  name: " web ",
  address: " 10.0.0.5 ",
  port: "2222",
  user: " deploy ",
  jumpHost: "",
  authType: "password" as const,
  identitiesOnly: false,
  forwardAgent: false,
  identityFile: "",
};

describe("parseHostForm", () => {
  it("turns the form into a trimmed HostDraft with password auth", () => {
    expect(parseHostForm(valid)).toEqual({
      ok: true,
      draft: { name: "web", address: "10.0.0.5", port: 2222, user: "deploy", auth: { type: "password" }, jumpHost: null, identitiesOnly: false, forwardAgent: false },
    });
  });

  it("keeps the chosen Jump host", () => {
    const result = parseHostForm({ ...valid, jumpHost: "bastion-id" });
    expect(result.ok && result.draft.jumpHost).toBe("bastion-id");
  });

  it("defaults an empty port to 22", () => {
    const result = parseHostForm({ ...valid, port: " " });
    expect(result.ok && result.draft.port).toBe(22);
  });

  it("reports every missing or invalid field", () => {
    const result = parseHostForm({ ...valid, name: "", address: " ", port: "70000", user: "" });
    expect(result).toEqual({ ok: false, errors: { name: "required", address: "required", user: "required", port: "port" } });
    expect(parseHostForm({ ...valid, port: "22a" })).toEqual({ ok: false, errors: { port: "port" } });
    expect(parseHostForm({ ...valid, port: "0" })).toEqual({ ok: false, errors: { port: "port" } });
  });

  it("keeps a trimmed private key path for key auth", () => {
    const result = parseHostForm({ ...valid, authType: "key", identityFile: " ~/.ssh/id_ed25519 " });
    expect(result.ok && result.draft.auth).toEqual({ type: "key", identityFile: "~/.ssh/id_ed25519" });
  });

  it("requires the key path only for key auth", () => {
    expect(parseHostForm({ ...valid, authType: "key", identityFile: " " })).toEqual({
      ok: false,
      errors: { identityFile: "required" },
    });
    const password = parseHostForm({ ...valid, identityFile: "~/.ssh/ignored" });
    expect(password.ok && password.draft.auth).toEqual({ type: "password" });
  });
});

describe("hostFormFrom", () => {
  it("round-trips a saved Host through the form", () => {
    const host = { id: "1", name: "db", address: "db.local", port: 22, user: "root", auth: { type: "password" as const }, jumpHost: "2", groupId: null, forwards: [] };
    const form = hostFormFrom(host);
    expect(form).toEqual({
      name: "db",
      address: "db.local",
      port: "22",
      user: "root",
      jumpHost: "2",
      authType: "password",
      identityFile: "",
      identitiesOnly: false,
      forwardAgent: false,
    });
    expect(parseHostForm(form)).toEqual({ ok: true, draft: { ...host, id: undefined, groupId: undefined, forwards: undefined, identitiesOnly: false, forwardAgent: false } });
  });

  it("round-trips a key Host through the form", () => {
    const auth = { type: "key" as const, identityFile: "/keys/id_rsa" };
    const host = { id: "2", name: "db", address: "db.local", port: 22, user: "root", auth, identitiesOnly: true, forwardAgent: true, jumpHost: null, groupId: null, forwards: [] };
    const form = hostFormFrom(host);
    expect(form).toMatchObject({ authType: "key", identityFile: "/keys/id_rsa", identitiesOnly: true, forwardAgent: true });
    expect(parseHostForm(form)).toEqual({ ok: true, draft: { ...host, id: undefined, groupId: undefined, forwards: undefined } });
  });

  it("round-trips a Host's own Terminal colour scheme", () => {
    const host = {
      id: "1",
      name: "prod",
      address: "prod.local",
      port: 22,
      user: "root",
      auth: { type: "password" as const },
      jumpHost: null,
      groupId: null,
      forwards: [],
      terminalScheme: "ember",
    };
    const form = hostFormFrom(host);
    expect(form.terminalScheme).toBe("ember");
    expect(parseHostForm(form)).toEqual({ ok: true, draft: { ...host, id: undefined, groupId: undefined, forwards: undefined, identitiesOnly: false, forwardAgent: false } });
  });

  it("round-trips a Host's default directory, and a blank one opens the home directory", () => {
    const host = {
      id: "1",
      name: "web",
      address: "web.local",
      port: 22,
      user: "deploy",
      auth: { type: "password" as const },
      jumpHost: null,
      groupId: null,
      forwards: [],
      defaultDirectory: "/srv/www",
    };
    const form = hostFormFrom(host);
    expect(form.defaultDirectory).toBe("/srv/www");
    expect(parseHostForm({ ...form, defaultDirectory: " ~/app " })).toMatchObject({
      ok: true,
      draft: { defaultDirectory: "~/app" },
    });
    const blank = parseHostForm({ ...form, defaultDirectory: "  " });
    expect(blank.ok && "defaultDirectory" in blank.draft).toBe(false);
  });

  it("drops a scheme this build does not know, so the Host follows the global scheme", () => {
    const host = { id: "1", name: "a", address: "b", port: 22, user: "c", auth: { type: "password" as const }, jumpHost: null, groupId: null, forwards: [] };
    expect(hostFormFrom({ ...host, terminalScheme: "retired" }).terminalScheme).toBeUndefined();
  });

  it("starts new Hosts on port 22", () => {
    expect(emptyHostForm.port).toBe("22");
  });

  it("starts new Hosts with automatic authentication and no identity file", () => {
    const result = parseHostForm({
      ...emptyHostForm,
      name: "web",
      address: "10.0.0.5",
      user: "deploy",
    });
    expect(result.ok && result.draft.auth).toEqual({ type: "auto" });
  });
});
