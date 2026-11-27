import { describe, expect, it } from "vitest";
import { rankPalette, type PaletteEntry } from "./palette-search";

const host = (id: string, title: string, detail = "", recent?: number): PaletteEntry => ({
  id: `host:${id}`,
  group: "hosts",
  title,
  detail,
  recent,
});
const tab = (id: string, title: string): PaletteEntry => ({ id: `tab:${id}`, group: "tabs", title });
const action = (id: string, title: string, keywords: string[] = []): PaletteEntry => ({
  id: `action:${id}`,
  group: "actions",
  title,
  keywords,
});

const ids = (entries: { id: string }[]) => entries.map((e) => e.id);

describe("rankPalette with no query", () => {
  it("lists recent Hosts first, most recent on top, then the other Hosts, then tabs, then actions", () => {
    const entries = [
      action("settings", "Open Settings"),
      host("a", "alpha"),
      tab("1", "Local terminal"),
      host("b", "bravo", "", 1),
      host("c", "charlie"),
      host("d", "delta", "", 0),
    ];
    expect(ids(rankPalette(entries, "  "))).toEqual([
      "host:d",
      "host:b",
      "host:a",
      "host:c",
      "tab:1",
      "action:settings",
    ]);
  });
});

describe("rankPalette with a query", () => {
  it("drops entries that do not match at all", () => {
    expect(ids(rankPalette([host("a", "alpha"), host("b", "bravo")], "lph"))).toEqual(["host:a"]);
  });

  it("ranks a prefix above a word start above a substring above scattered letters", () => {
    const entries = [
      host("scattered", "p-r-o-d box"), // p..r..o..d
      host("inside", "reproduction"), // "prod" inside a word
      host("word", "eu-prod"), // "prod" at a word start
      host("prefix", "prod-db"), // starts with "prod"
    ];
    expect(ids(rankPalette(entries, "prod"))).toEqual(["host:prefix", "host:word", "host:inside", "host:scattered"]);
  });

  it("prefers tighter scattered matches", () => {
    const entries = [host("loose", "s_x_x_x_t"), host("tight", "sat")];
    expect(ids(rankPalette(entries, "st"))).toEqual(["host:tight", "host:loose"]);
  });

  it("matches a Host's address too, below a match on its name", () => {
    const entries = [host("byAddress", "web", "deploy@db.example.com"), host("byName", "db-primary", "10.0.0.5")];
    expect(ids(rankPalette(entries, "db"))).toEqual(["host:byName", "host:byAddress"]);
  });

  it("finds Host Tags after ordinary matches and reserves tag: for Hosts with that exact Tag", () => {
    const entries = [
      { ...host("byTag", "Gateway", "", 0), tags: ["East Coast"] },
      host("byAddress", "Relay", "east coast.example"),
      host("byName", "East Coast"),
      { ...host("preview", "Preview"), tags: ["East Coast Preview"] },
      tab("1", "tag:East Coast"),
    ];
    expect(ids(rankPalette(entries, "East Coast"))).toEqual([
      "host:byName", "tab:1", "host:byAddress", "host:byTag", "host:preview",
    ]);
    expect(ids(rankPalette(entries, "TAG: east coast"))).toEqual(["host:byTag"]);
    expect(rankPalette(entries, "tag:")).toEqual([]);
  });

  it("finds actions by their keywords", () => {
    const entries = [action("settings", "Open Settings", ["preferences"]), action("local", "New Local terminal")];
    expect(ids(rankPalette(entries, "prefer"))).toEqual(["action:settings"]);
  });

  it("puts the more recent Host first when two match equally well", () => {
    const entries = [host("old", "web-1", "", 3), host("never", "web-2"), host("new", "web-3", "", 0)];
    expect(ids(rankPalette(entries, "web"))).toEqual(["host:new", "host:old", "host:never"]);
  });

  it("is case-insensitive and reports where the title matched, for highlighting", () => {
    const [hit] = rankPalette([tab("1", "Local Terminal")], "TERM");
    expect(hit?.titleMatches).toEqual([6, 7, 8, 9]);
  });
});
