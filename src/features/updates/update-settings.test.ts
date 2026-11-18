import { describe, expect, it } from "vitest";
import { updateSetting } from "./update-settings";

describe("updates settings section", () => {
  it("checks for updates on startup by default", () => {
    expect(updateSetting.parse(undefined)).toEqual({ checkOnStartup: true });
  });

  it("keeps automatic checks turned off", () => {
    expect(updateSetting.parse({ checkOnStartup: false })).toEqual({ checkOnStartup: false });
  });

  it("repairs a value that is not a yes or no", () => {
    expect(updateSetting.parse({ checkOnStartup: "no" })).toEqual({ checkOnStartup: true });
    expect(updateSetting.parse(null)).toEqual({ checkOnStartup: true });
  });
});
