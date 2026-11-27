import { expect, it, vi } from "vitest";
import { createBroadcast } from "./broadcast";

it("delivers command text with the requested Enter through the focused writer and frozen Broadcast audience", async () => {
  const broadcast = createBroadcast();
  const focused = vi.fn();
  const peer = vi.fn();
  const offTab = vi.fn();
  const newcomer = vi.fn();
  broadcast.updateWorkspace("source", ["tab", "other"], ["source", "peer", "off-tab", "new"]);
  broadcast.register("tab", "source", focused, () => true);
  broadcast.register("tab", "peer", peer);
  broadcast.register("other", "off-tab", offTab);

  await expect(broadcast.captureInput("source")!.send("pwd", false)).resolves.toBe(true);
  expect(focused).toHaveBeenCalledExactlyOnceWith("\x1b[200~pwd\x1b[201~");
  expect(peer).not.toHaveBeenCalled();

  broadcast.toggle("tab", "tab");
  const target = broadcast.captureInput("source")!;
  broadcast.register("tab", "new", newcomer);
  await expect(target.send("  pwd  \r\nwhoami", true)).resolves.toBe(true);
  expect(focused).toHaveBeenLastCalledWith("\x1b[200~  pwd  \rwhoami\x1b[201~\r");
  expect(peer).toHaveBeenCalledExactlyOnceWith("  pwd  \rwhoami\r");
  expect(newcomer).not.toHaveBeenCalled();
  expect(offTab).not.toHaveBeenCalled();

  broadcast.toggle("window", "tab");
  await expect(broadcast.captureInput("source")!.send("ls", false)).resolves.toBe(true);
  expect(peer).toHaveBeenLastCalledWith("ls");
  expect(newcomer).toHaveBeenCalledExactlyOnceWith("ls");
  expect(offTab).toHaveBeenCalledExactlyOnceWith("ls");
});

it("does not reroute a pending invocation after changing focus or replacing its shell", async () => {
  const broadcast = createBroadcast();
  const original = vi.fn();
  const replacement = vi.fn();
  const other = vi.fn();
  broadcast.updateWorkspace("source", ["tab"], ["source", "other"]);
  const remove = broadcast.register("tab", "source", original);
  broadcast.register("tab", "other", other);
  broadcast.toggle("tab", "tab");
  const target = broadcast.captureInput("source")!;

  broadcast.updateWorkspace("other", ["tab"], ["source", "other"]);
  await expect(target.send("pwd", true)).resolves.toBe(false);
  broadcast.updateWorkspace("source", ["tab"], ["source", "other"]);
  remove();
  expect(broadcast.captureInput("source")).toBeUndefined();
  broadcast.register("tab", "source", replacement);
  await expect(target.send("pwd", true)).resolves.toBe(false);
  expect(original).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  expect(other).not.toHaveBeenCalled();
});
