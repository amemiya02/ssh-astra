import { describe, expect, it, vi } from "vitest";
import { createActionRegistry, type PaletteAction } from "./palette-actions";

const action = (id: string, title = id): PaletteAction => ({ id, title, run: () => {} });

describe("the palette action registry", () => {
  it("lists actions in the order they were registered", () => {
    const registry = createActionRegistry();
    registry.register([action("newLocalTerminal"), action("openSettings")]);
    registry.register([action("toggleFilePanel")]);
    expect(registry.list().map((a) => a.id)).toEqual(["newLocalTerminal", "openSettings", "toggleFilePanel"]);
  });

  it("drops a feature's actions when it unregisters them", () => {
    const registry = createActionRegistry();
    const unregister = registry.register([action("a")]);
    registry.register([action("b")]);
    unregister();
    expect(registry.list().map((a) => a.id)).toEqual(["b"]);
  });

  it("replaces an action registered again under the same id, keeping its place", () => {
    const registry = createActionRegistry();
    registry.register([action("a", "old")]);
    registry.register([action("b")]);
    registry.register([action("a", "new")]);
    expect(registry.list().map((a) => [a.id, a.title])).toEqual([
      ["a", "new"],
      ["b", "b"],
    ]);
  });

  it("tells subscribers when the list changes", () => {
    const registry = createActionRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const unregister = registry.register([action("a")]);
    unregister();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
