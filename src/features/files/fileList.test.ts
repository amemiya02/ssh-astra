import { describe, expect, it } from "vitest";
import type { FileEntry } from "@/lib/ipc/files";
import {
  childPath,
  formatPermissions,
  formatSize,
  isDirLike,
  parentPath,
  shownEntries,
  visibleRows,
} from "./fileList";

const file = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  name,
  kind: "file",
  size: 0,
  modified: null,
  permissions: 0o644,
  linkTarget: null,
  ...extra,
});
const dir = (name: string, extra: Partial<FileEntry> = {}) => file(name, { kind: "dir", permissions: 0o755, ...extra });
const names = (entries: FileEntry[]) => entries.map((e) => e.name);

describe("shownEntries", () => {
  const entries = [
    file("b.txt", { size: 10, modified: 300 }),
    dir("zeta", { modified: 100 }),
    file(".env", { size: 5, modified: 200 }),
    file("A.txt", { size: 30, modified: 100 }),
    dir("alpha", { modified: 400 }),
    file("link", { kind: "symlink", linkTarget: "dir" }),
    file("file10"),
    file("file9"),
  ];

  it("puts directories (and links to them) first, then sorts by name, ignoring case and reading numbers", () => {
    expect(names(shownEntries(entries, { key: "name", direction: "asc" }, false))).toEqual([
      "alpha",
      "link",
      "zeta",
      "A.txt",
      "b.txt",
      "file9",
      "file10",
    ]);
  });

  it("reverses within the directory and file groups when descending", () => {
    expect(names(shownEntries(entries, { key: "name", direction: "desc" }, false))).toEqual([
      "zeta",
      "link",
      "alpha",
      "file10",
      "file9",
      "b.txt",
      "A.txt",
    ]);
  });

  it("hides dotfiles unless asked", () => {
    expect(names(shownEntries(entries, { key: "name", direction: "asc" }, true))).toContain(".env");
    expect(names(shownEntries(entries, { key: "name", direction: "asc" }, false))).not.toContain(".env");
  });

  it("sorts by size, by modification time and by permissions, ties by name", () => {
    const files = entries.filter((e) => e.kind === "file");
    expect(names(shownEntries(files, { key: "size", direction: "desc" }, true))).toEqual([
      "A.txt",
      "b.txt",
      ".env",
      "file9",
      "file10",
    ]);
    expect(names(shownEntries(entries, { key: "modified", direction: "asc" }, false))).toEqual([
      "link",
      "zeta",
      "alpha",
      "file9",
      "file10",
      "A.txt",
      "b.txt",
    ]);
    const modes = [file("x", { permissions: 0o600 }), file("y", { permissions: 0o777 })];
    expect(names(shownEntries(modes, { key: "permissions", direction: "desc" }, false))).toEqual(["y", "x"]);
  });
});

describe("paths", () => {
  it("goes up one directory, stopping at the root", () => {
    expect(parentPath("/home/tester")).toBe("/home");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("/srv/files/")).toBe("/srv");
  });

  it("joins a name to its directory", () => {
    expect(childPath("/", "etc")).toBe("/etc");
    expect(childPath("/home/tester", "a b")).toBe("/home/tester/a b");
  });

  it("opens directories and links to them", () => {
    expect(isDirLike(dir("d"))).toBe(true);
    expect(isDirLike(file("l", { kind: "symlink", linkTarget: "dir" }))).toBe(true);
    expect(isDirLike(file("l", { kind: "symlink", linkTarget: "file" }))).toBe(false);
    expect(isDirLike(file("f"))).toBe(false);
  });
});

describe("formatting", () => {
  it("shows permissions like ls -l", () => {
    expect(formatPermissions(dir("d"))).toBe("drwxr-xr-x");
    expect(formatPermissions(file("f", { permissions: 0o640 }))).toBe("-rw-r-----");
    expect(formatPermissions(file("l", { kind: "symlink", permissions: 0o777 }))).toBe("lrwxrwxrwx");
    expect(formatPermissions(file("s", { permissions: 0o4755 }))).toBe("-rwsr-xr-x");
    expect(formatPermissions(dir("t", { permissions: 0o1777 }))).toBe("drwxrwxrwt");
    expect(formatPermissions(file("u", { permissions: null }))).toBe("");
  });

  it("shows sizes in binary units", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatSize(5 * 1024 ** 4)).toBe("5 TB");
  });
});

describe("visibleRows", () => {
  it("renders only the rows in view plus an overscan", () => {
    expect(visibleRows({ scrollTop: 0, viewport: 260, rowHeight: 26, count: 10_000, overscan: 5 })).toEqual({
      start: 0,
      end: 15,
    });
    expect(visibleRows({ scrollTop: 2600, viewport: 260, rowHeight: 26, count: 10_000, overscan: 5 })).toEqual({
      start: 95,
      end: 115,
    });
    expect(visibleRows({ scrollTop: 260_000, viewport: 260, rowHeight: 26, count: 10_000, overscan: 5 })).toEqual({
      start: 9995,
      end: 10_000,
    });
  });
});
