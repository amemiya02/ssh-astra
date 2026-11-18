# Size and memory baselines

One row per measurement, newest last. Compare a new release against these before shipping; a large jump needs a reason.

## How to measure

- **Build:** `pnpm tauri build --bundles app,dmg --config '{"bundle":{"createUpdaterArtifacts":false}}'` on the host architecture (the release workflow builds a universal macOS binary, roughly twice the size of one architecture). Turning off updater artifacts only skips the signed `.app.tar.gz`; it does not change the app.
- **Sizes:** the `.dmg` file (`stat -f %z`), the `.app` bundle on disk (`du -sk`) and its executable (`Contents/MacOS/sshastra`).
- **Idle memory:** start the bundle's executable with a throwaway `HOME` (so it uses default settings and never touches real Hosts), which opens one Local terminal; leave it untouched for 30 s; then read RSS with `ps -o rss=` for the app process and for the three WebKit processes it started (`com.apple.WebKit.WebContent`, `.GPU`, `.Networking`, found as the WebKit processes that were not running before launch). RSS counts shared pages in each process, so the total overstates what the app alone costs; it is a stable number to compare, not an exact one. The startup update check runs as usual (it finds no release).

## Results

| Date | Version | Machine | `.dmg` | `.app` on disk | Executable | Idle RSS: app | Idle RSS: WebKit (content + GPU + network) | Idle RSS total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-18 | 0.1.0 | Apple M2, macOS 27.3, aarch64 build | 9.2 MiB (9,676,284 B) | 23.4 MiB | 22.4 MiB | 77.6 MiB | 43.3 + 20.5 + 4.4 MiB | 145.8 MiB |

Not measured yet: Windows `.msi` and Linux AppImage / `.deb` sizes (take them from the first release's assets), and idle memory on Windows and Linux.
