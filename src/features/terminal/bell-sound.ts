/** One short, quiet tone for the whole window at a time. */
export function createBellSound() {
  let context: AudioContext | undefined;
  let lastBell = -Infinity;

  function audioContext(): AudioContext | undefined {
    if (context || typeof AudioContext === "undefined") return context;
    try {
      context = new AudioContext();
    } catch {
      // Audio is optional on systems without an available output device.
    }
    return context;
  }

  return {
    prepare() {
      const audio = audioContext();
      if (audio && audio.state !== "running") void audio.resume().catch(() => undefined);
    },
    play() {
      const now = performance.now();
      if (now - lastBell < 600) return;
      lastBell = now;
      const audio = audioContext();
      // A webview may wait for a user gesture. Drop bells that arrive before it unlocks.
      if (audio?.state !== "running") return;

      const start = audio.currentTime;
      const end = start + 0.12;
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      tone.frequency.value = 660;
      volume.gain.setValueAtTime(0, start);
      volume.gain.linearRampToValueAtTime(0.08, start + 0.01);
      volume.gain.linearRampToValueAtTime(0, end);
      tone.connect(volume);
      volume.connect(audio.destination);
      tone.onended = () => {
        tone.disconnect();
        volume.disconnect();
      };
      tone.start(start);
      tone.stop(end);
    },
    close() {
      if (context) void context.close().catch(() => undefined);
      context = undefined;
      lastBell = -Infinity;
    },
  };
}
