import { describe, expect, it } from "vitest";
import { settingRows } from "./setting-rows";
import { filterSettingsRows } from "./settings-search";

describe("settings search", () => {
  const rows = Object.values(settingRows);

  it.each(["  KEEPALIVE  ", "间隔", "three missed checks", "三次", "heartbeat", "心跳"])(
    "finds the Connection keepalive setting by title, description, or keyword in either language (%s)",
    (query) => {
      expect(filterSettingsRows(rows, query)).toEqual([settingRows.keepalive]);
    },
  );

  it("requires every search term, including terms from different languages", () => {
    expect(filterSettingsRows(rows, "regex 自定义")).toEqual([settingRows.customHighlighting]);
    expect(filterSettingsRows(rows, "clipboard not-a-setting")).toEqual([]);
  });

  it("finds Terminal program notification settings in either language", () => {
    expect(filterSettingsRows(rows, "OSC system alerts")).toEqual([settingRows.terminalNotifications]);
    expect(filterSettingsRows(rows, "系统提醒 程序")).toEqual([settingRows.terminalNotifications]);
  });

  it("keeps the supplied rows in order for an empty query", () => {
    expect(filterSettingsRows(rows, "  ")).toEqual(rows);
  });
});
