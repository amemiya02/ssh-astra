import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, expect, it, vi } from "vitest";
import { folderSize } from "./files";

afterEach(clearMocks);

it("delivers a folder size cancellation requested before the backend registers the scan", async () => {
  let onStart!: Channel<number>;
  let finish!: (result: null) => void;
  const cancel = vi.fn();
  mockIPC((command, args) => {
    if (command === "files_folder_size") {
      onStart = (args as { onStart: Channel<number> }).onStart;
      return new Promise<null>((resolve) => { finish = resolve; });
    }
    expect(command).toBe("files_cancel_scan");
    cancel(args);
    finish(null);
  });

  const controller = new AbortController();
  const result = folderSize(7, "/srv/files/docs", controller.signal);
  controller.abort();
  expect(cancel).not.toHaveBeenCalled();

  onStart.onmessage(12);
  await expect(result).resolves.toBeNull();
  expect(cancel).toHaveBeenCalledExactlyOnceWith({ id: 7, requestId: 12 });
});
