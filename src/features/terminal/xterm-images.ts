import { ImageAddon } from "@xterm/addon-image";
import type { IDisposable, Terminal } from "@xterm/xterm";

const storageLimit = 16; // MB of decoded pixels, per Terminal
const sequenceSizeLimit = 8_000_000;
let canCompileWasm: boolean | undefined;

function supportsImageDecoders(): boolean {
  if (canCompileWasm === undefined) {
    try {
      // Older webviews may support WebAssembly but block it under the app CSP.
      const emptyModule = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
      new WebAssembly.Instance(new WebAssembly.Module(emptyModule));
      canCompileWasm = true;
    } catch {
      canCompileWasm = false;
    }
  }
  return canCompileWasm;
}

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
    if (!supportsImageDecoders()) return;
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
    trimStorage = undefined;
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
    disposeTerminal() {
      disposed = true;
      if (!images) {
        terminal.dispose();
        return;
      }
      // Detach and release cached images immediately. An active iTerm2 decode
      // can still finish, so dispose xterm when its current writes have settled.
      terminal.element?.remove();
      images.reset();
      terminal.write("", () => {
        unload();
        terminal.dispose();
      });
    },
  };
}
