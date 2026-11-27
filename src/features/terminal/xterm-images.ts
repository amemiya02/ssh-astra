import { ImageAddon } from "@xterm/addon-image";
import type { IDisposable, Terminal } from "@xterm/xterm";

const storageLimit = 16; // MB of decoded pixels, per Terminal
const sequenceSizeLimit = 8_000_000;

// In addon-image 0.9.0, xterm's cells keep their image IDs after the add-on
// is disposed. Carry the counter into a new cache so those cells stay empty.
type ImageStorageCounters = { _lastId: number; _lowestId: number };
function storageCounters(addon: ImageAddon): ImageStorageCounters {
  return (addon as unknown as { _storage: ImageStorageCounters })._storage;
}

export function attachTerminalImages(terminal: Terminal, initiallyEnabled: boolean) {
  let requested = initiallyEnabled;
  let disposed = false;
  let previousImageId = 0;
  let images: ImageAddon | undefined;
  let trimStorage: IDisposable | undefined;

  const load = () => {
    const addon = new ImageAddon({
      enableSizeReports: false,
      storageLimit,
      pixelLimit: storageLimit * 250_000,
      sixelSizeLimit: sequenceSizeLimit,
      iipSizeLimit: sequenceSizeLimit,
      showPlaceholder: false,
    });
    terminal.loadAddon(addon);
    if (previousImageId) {
      const counters = storageCounters(addon);
      counters._lastId = previousImageId;
      counters._lowestId = previousImageId;
    }
    images = addon;
    trimStorage = terminal.onRender(() => {
      // Rescaling can add a second canvas. Reapply the limit after drawing.
      if (addon.storageUsage > storageLimit) {
        addon.storageLimit = storageLimit;
        terminal.refresh(0, terminal.rows - 1);
      }
    });
  };

  const unload = () => {
    if (!images) return;
    previousImageId = storageCounters(images)._lastId;
    trimStorage?.dispose();
    images.dispose();
    images = undefined;
  };

  if (initiallyEnabled) load();
  return {
    setEnabled(enabled: boolean) {
      if (requested === enabled) return;
      requested = enabled;
      // iTerm2 decoding can pause xterm's parser. Switch between write chunks
      // so pending decoder work cannot put an image into a disposed cache.
      terminal.write("", () => {
        if (disposed) return;
        if (enabled) load();
        else unload();
      });
    },
    dispose() {
      disposed = true;
      unload();
    },
  };
}
