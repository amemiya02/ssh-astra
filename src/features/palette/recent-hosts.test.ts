import { describe, expect, it } from "vitest";
import { noteOpened, recentHostsSetting } from "./recent-hosts";

describe("noteOpened", () => {
  it("moves the opened Host to the front without repeating it", () => {
    expect(noteOpened(["b", "a", "c"], "a")).toEqual(["a", "b", "c"]);
    expect(noteOpened([], "a")).toEqual(["a"]);
  });

  it("keeps only the most recent ones", () => {
    const many = Array.from({ length: 30 }, (_, i) => `h${i}`);
    const next = noteOpened(many, "new");
    expect(next).toHaveLength(20);
    expect(next[0]).toBe("new");
    expect(next[19]).toBe("h18");
  });
});

describe("recentHostsSetting", () => {
  it("repairs whatever the settings file holds", () => {
    expect(recentHostsSetting.parse(undefined)).toEqual([]);
    expect(recentHostsSetting.parse("nope")).toEqual([]);
    expect(recentHostsSetting.parse(["a", 3, "b", "a", null])).toEqual(["a", "b"]);
  });
});
