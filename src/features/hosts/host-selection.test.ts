import { describe, expect, it } from "vitest";
import { emptyHostSelection, selectHost } from "./host-selection";

describe("Host selection", () => {
  it("toggles individual Hosts and clears the earlier selection on an ordinary click", () => {
    const rows = ["a", "b", "c"];
    const first = selectHost(emptyHostSelection, "a", rows, "single");
    const two = selectHost(first, "c", rows, "toggle");
    expect(two.ids).toEqual(["a", "c"]);
    const withoutFirst = selectHost(two, "a", rows, "toggle");
    expect(withoutFirst.ids).toEqual(["c"]);
    expect(selectHost(two, "b", rows, "single").ids).toEqual(["b"]);
  });

  it("uses the visible order and keeps the anchor when the range reverses", () => {
    const first = selectHost(emptyHostSelection, "a", ["a", "b", "c", "d", "hidden"], "single");
    const rows = ["c", "a", "b", "d"];
    const forward = selectHost(first, "d", rows, "range");
    expect(forward.ids).toEqual(["a", "b", "d"]);
    expect(selectHost(forward, "c", rows, "range").ids).toEqual(["c", "a"]);
  });

  it("starts a new range when the anchor is hidden and ignores a missing target", () => {
    const rows = ["a", "b", "c", "d", "e"];
    const first = selectHost(emptyHostSelection, "a", rows, "single");
    const second = selectHost(first, "c", rows, "toggle");
    expect(selectHost(second, "e", ["a", "d", "e"], "range").ids).toEqual(["e"]);
    expect(selectHost(second, "e", ["a", "c"], "toggle")).toBe(second);
  });
});
