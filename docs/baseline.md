# Performance baselines

One row per measurement, newest last. Compare a new release against these before shipping; a large jump needs a reason.

## 0.1.0 method and results

- **Build:** `pnpm tauri build --bundles app,dmg --config '{"bundle":{"createUpdaterArtifacts":false}}'` on the host architecture (the release workflow builds a universal macOS binary, roughly twice the size of one architecture). Turning off updater artifacts only skips the signed `.app.tar.gz`; it does not change the app.
- **Sizes:** the `.dmg` file (`stat -f %z`), the `.app` bundle on disk (`du -sk`) and its executable (`Contents/MacOS/sshastra`).
- **Idle memory:** start the bundle's executable with a throwaway `HOME` (so it uses default settings and never touches real Hosts), which opens one Local terminal; leave it untouched for 30 s; then read RSS with `ps -o rss=` for the app process and for the three WebKit processes it started (`com.apple.WebKit.WebContent`, `.GPU`, `.Networking`, found as the WebKit processes that were not running before launch). RSS counts shared pages in each process, so the total overstates what the app alone costs; it is a stable number to compare, not an exact one. The startup update check runs as usual (it finds no release).

| Date | Version | Machine | `.dmg` | `.app` on disk | Executable | Idle RSS: app | Idle RSS: WebKit (content + GPU + network) | Idle RSS total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-18 | 0.1.0 | Apple M2, macOS 27.3, aarch64 build | 9.2 MiB (9,676,284 B) | 23.4 MiB | 22.4 MiB | 77.6 MiB | 43.3 + 20.5 + 4.4 MiB | 145.8 MiB |

Not measured yet: Windows `.msi` and Linux AppImage / `.deb` sizes (take them from the first release's assets), and idle memory on Windows and Linux.

## macOS performance benchmark

From the repository root, run `pnpm performance` with the usual [build prerequisites](../README.md#build-from-source), Docker Compose v2, and an unlocked macOS desktop. Keep the SSH Astra window visible and let other WebKit apps and build jobs finish before sampling. The command installs the locked dependencies, builds the normal release and debug E2E executables, starts a dedicated Compose project on dynamic loopback ports, and prints machine metadata and samples as JSON lines. To keep a copy, redirect stdout to a new file. Build and progress messages go to stderr. The sequential 100 ms transfers can take tens of minutes.

- **Startup** is measured on the normal release executable under five fresh, disposable home directories. With `SSHASTRA_MEASURE_STARTUP=1`, the app emits `SSHASTRA_HOME_FIRST_PAINT_MS` on stderr once, from Rust app entry until the first active Home frame has had a paint opportunity. A nested `requestAnimationFrame` and the return IPC add up to one frame plus IPC latency. The result is the median of five fresh processes with normal OS file caches.
- **Idle** runs each of Home, one Local terminal, and a held Connection with one auto-start Port forward in a fresh debug E2E process and disposable home. The forward echoes a message before sampling. After 5 seconds to settle, cumulative CPU time is sampled 15 seconds apart. CPU percentages are shares of one core. RSS is read at the end from the app and any WebContent, GPU, and Networking processes started since launch, with duplicate process roles rejected. Summing RSS counts shared pages more than once. The Local terminal is sampled focused, unfocused, and focused with cursor blink disabled as a control. The renderer counts redraws in each window.
- **Terminal output** runs a generated 16 MiB of numbered ASCII lines through a real SSH PTY in a debug E2E build. Reported time runs from command submission to the marker appearing in xterm. The final eight lines are compared to the generated text, and the output IPC count and xterm's outstanding-parser byte count are recorded. RSS is sampled every 50 ms and again 5 seconds after the marker. The CPU delta covers the same workload window.
- **Additional Terminal workloads** measure RSS with 20 Local terminal tabs, verify each tab renders its own marker after switching, and count WebGL contexts still live. A fresh remote Terminal is also sampled before and after writing 12,000 lines into its 10,000-line scrollback. Finally, with the remote foreground process sleeping and the PTY in raw mode with echo off, the script pastes 32 MiB in 2 MiB chunks. It waits for IPC acknowledgement and samples RSS after each 8 MiB, then again after 5 seconds.
- **SFTP listings** run directly against `SftpFs` in a release build of `sshastra-core` on both plain and delayed OpenSSH. The median of five calls is reported for 10,000 regular entries, 1,000 regular entries, and 1,000 symlinks to regular files. The 1,000 regular entries provide a control for link resolution cost. The script verifies the entry counts and that every link resolved.
- **Transfers** use `TransferQueue` in the release core build. It uploads and downloads a 32 MiB file and a directory of 1,000 1 KiB files on each of the plain and delayed OpenSSH services. Time covers enqueue through completion and excludes fixture generation, SSH authentication, and final local readback. Every downloaded byte is compared with the source. The delayed service uses `tc netem` on outbound traffic to add 100 ms per round trip. Repeated SFTP `stat` calls on the two services show the latency each client observed.

To run the core listings or transfers independently, use the same Compose file and an isolated project. The `list`, `transfer`, and `all` modes take the plain and delayed loopback ports. Tear down that project after the run to remove the remote scratch directories.

```bash
export SSHASTRA_IT_PROJECT=sshastra-perf-core
compose_file=src-tauri/crates/sshastra-core/tests/sshd/docker-compose.yml
docker compose -f "$compose_file" --profile performance up -d --build --wait ssh delayed
plain_port=$(docker compose -f "$compose_file" port ssh 22)
delayed_port=$(docker compose -f "$compose_file" --profile performance port delayed 22)
cargo run --locked --manifest-path src-tauri/Cargo.toml --release -p sshastra-core \
  --example performance -- list "${plain_port##*:}" "${delayed_port##*:}"
docker compose -f "$compose_file" --profile performance down --rmi all
```
