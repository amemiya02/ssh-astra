import { describe, expect, it } from "vitest";
import { connectionSetting, defaultConnectionSettings } from "./connection-settings";

describe("the connection settings section", () => {
  it("is the section the core reads keepalives from", () => {
    expect(connectionSetting.key).toBe("connection");
    expect(defaultConnectionSettings).toEqual({ keepaliveSeconds: 30 });
  });

  it("keeps a valid keepalive interval, including off", () => {
    expect(connectionSetting.parse({ keepaliveSeconds: 60 })).toEqual({ keepaliveSeconds: 60 });
    expect(connectionSetting.parse({ keepaliveSeconds: 0 })).toEqual({ keepaliveSeconds: 0 });
  });

  it("repairs a missing, damaged or out-of-range value", () => {
    expect(connectionSetting.parse(undefined)).toEqual({ keepaliveSeconds: 30 });
    expect(connectionSetting.parse({ keepaliveSeconds: "soon" })).toEqual({ keepaliveSeconds: 30 });
    expect(connectionSetting.parse({ keepaliveSeconds: -5 })).toEqual({ keepaliveSeconds: 30 });
    expect(connectionSetting.parse({ keepaliveSeconds: 12.6 })).toEqual({ keepaliveSeconds: 13 });
    expect(connectionSetting.parse({ keepaliveSeconds: 100000 })).toEqual({ keepaliveSeconds: 3600 });
  });
});
