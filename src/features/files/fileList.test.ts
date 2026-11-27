import { describe, expect, it } from "vitest";
import type { FileEntry } from "@/lib/ipc/files";
import {
  childPath,
  fileIconKind,
  formatPermissions,
  formatSize,
  isDirLike,
  nameProblem,
  octalMode,
  parentPath,
  parseOctalMode,
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

  it.each(["modified", "permissions"] as const)("orders %s numerically in either direction", (key) => {
    const rows = [
      file("tie10", { [key]: 8 }),
      file("unknown", { [key]: null }),
      file("largest", { [key]: 70 }),
      dir("folder", { [key]: null }),
      file("tie2", { [key]: 8 }),
    ];
    expect(names(shownEntries(rows, { key, direction: "asc" }, false))).toEqual([
      "folder", "unknown", "tie2", "tie10", "largest",
    ]);
    expect(names(shownEntries(rows, { key, direction: "desc" }, false))).toEqual([
      "folder", "largest", "tie2", "tie10", "unknown",
    ]);
  });
});

describe("fileIconKind", () => {
  it("uses the entry kind before the filename extension", () => {
    expect(fileIconKind(dir("folder.png"))).toBe("folder");
    expect(fileIconKind(file("alias.png", { kind: "symlink", linkTarget: "dir" }))).toBe("folderLink");
    expect(fileIconKind(file("alias.png", { kind: "symlink", linkTarget: "file" }))).toBe("fileLink");
    expect(fileIconKind(file("dangling.zip", { kind: "symlink" }))).toBe("fileLink");
    expect(fileIconKind(file("socket.js", { kind: "other" }))).toBe("file");
  });

  it.each([
    ["backup.TAR.GZ", "archive"],
    [".preview.PnG", "image"],
    ["run.sh", "code"],
    ["report.md", "document"],
    ["recording.mp4", "media"],
    ["audio.FLAC", "media"],
    ["file.unknown", "file"],
    ["README", "file"],
    [".zip", "file"],
  ])("maps %s to %s", (name, icon) => {
    expect(fileIconKind(file(name))).toBe(icon);
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

describe("nameProblem", () => {
  const existing = ["notes.txt", "src"];

  it("accepts a new plain name, and an entry keeping its own name", () => {
    expect(nameProblem("build", existing)).toBeNull();
    expect(nameProblem("notes.txt", existing, "notes.txt")).toBeNull();
  });

  it("says why a name cannot be used", () => {
    expect(nameProblem("  ", existing)).toBe("empty");
    expect(nameProblem("a/b", existing)).toBe("slash");
    expect(nameProblem("..", existing)).toBe("dots");
    expect(nameProblem(".", existing)).toBe("dots");
    expect(nameProblem("src", existing)).toBe("taken");
    expect(nameProblem("src", existing, "notes.txt")).toBe("taken");
  });
});

describe("octal modes", () => {
  it("reads three or four octal digits", () => {
    expect(parseOctalMode("755")).toBe(0o755);
    expect(parseOctalMode("0644")).toBe(0o644);
    expect(parseOctalMode(" 1777 ")).toBe(0o1777);
  });

  it("refuses anything else", () => {
    for (const text of ["", "75", "789", "12345", "rwx", "-1"]) expect(parseOctalMode(text)).toBeNull();
  });

  it("writes a mode as `chmod` takes it", () => {
    expect(octalMode(0o755)).toBe("755");
    expect(octalMode(0o600)).toBe("600");
    expect(octalMode(0o4755)).toBe("4755");
    expect(octalMode(0o7)).toBe("007");
  });
});
