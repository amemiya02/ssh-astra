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

From the repository root, run `pnpm performance` with the usual [build prerequisites](../README.md#build-from-source), Docker Compose v2, and an unlocked macOS desktop. Keep the SSH Astra window visible and let other WebKit apps and build jobs finish before sampling. The command installs the locked dependencies, builds the normal release and debug E2E executables, starts a dedicated Compose project on dynamic loopback ports, and prints machine metadata and samples as JSON lines. To keep a copy, redirect stdout to a new file outside the checkout. Build and progress messages go to stderr. The sequential 100 ms transfers can take tens of minutes.

- **Startup** is measured on the normal release executable under five fresh, disposable home directories. With `SSHASTRA_MEASURE_STARTUP=1`, the app emits `SSHASTRA_HOME_FIRST_PAINT_MS` on stderr once, from Rust app entry until the first active Home frame has had a paint opportunity. A nested `requestAnimationFrame` and the return IPC add up to one frame plus IPC latency. The result is the median of five fresh processes with normal OS file caches.
- **Idle** runs each of Home, one Local terminal, and a held Connection with one auto-start Port forward in a fresh debug E2E process and disposable home. The forward echoes a message before sampling. After 5 seconds to settle, cumulative CPU time is sampled 15 seconds apart. CPU percentages are shares of one core. RSS is read at the end from the app and any WebContent, GPU, and Networking processes started since launch, with duplicate process roles rejected. Summing RSS counts shared pages more than once. The Local terminal is sampled focused, unfocused, and focused with cursor blink disabled as a control. The redraw counts include both the settle and sample intervals.
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

### Results

The 2026-11-27 baseline is from the Apple M2 with 24 GiB RAM, macOS 27.3 (26C5047e), Docker Engine 29.9.2, and native arm64 builds in the `sshastra-roadmap-35` worktree. Application and core behavior comes from `cfdb149` (0.3.0) with the benchmark code committed as `49b9ae4`. The runs precede the integration of staged transfers, update deferral, and logging. Other builds ran on the machine during parts of the measurement.

| Date | Version | Machine | Home first paint, release median | Home idle, CPU / RSS | Local terminal idle, CPU / RSS | Held Connection + Port forward idle, CPU / RSS | Remote 16 MiB output |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-27 | 0.3.0 | Apple M2, macOS 27.3, arm64 | 1,625 ms | 0.40% / 186.5 MiB | 3.96% / 154.6 MiB, focused | 0.59% / 146.0 MiB | 19.73 s, final eight lines intact |

| Idle state | App CPU / RSS | WebContent CPU / RSS | GPU CPU / RSS | Networking CPU / RSS |
| --- | --- | --- | --- | --- |
| Home | 0.20% / 98.0 MiB | 0.13% / 66.6 MiB | 0.07% / 15.6 MiB | 0.00% / 6.3 MiB |
| Local terminal, focused | 2.01% / 90.0 MiB | 1.62% / 43.9 MiB | 0.32% / 16.9 MiB | 0.00% / 3.8 MiB |
| Held Connection + Port forward | 0.26% / 89.4 MiB | 0.26% / 44.5 MiB | 0.00% / 9.9 MiB | 0.07% / 2.2 MiB |

| Terminal workload | Results |
| --- | --- |
| 16 MiB output | 225.5 MiB RSS before, 285.2 MiB peak (101.3 MiB app), and 216.3 MiB after 5 s. 12,683 output IPC messages (642.7/s), 128 KiB peak awaiting xterm parsing, and 36.5% app CPU. |
| Cursor blink | 33 redraws and 3.96% total CPU while focused, 0 redraws and 2.83% with focus and blink off, and 0 redraws and 0.39% unfocused. |
| 20 Local terminal tabs | 270.6 MiB total RSS, 116.0 MiB above the single focused tab. 16 active WebGL contexts. Each of the 20 tabs redrew and showed its own marker. |
| Full scrollback | 0 to 10,000 scrollback lines. Total RSS increased 13.6 MiB, WebContent RSS increased 27.3 MiB. |
| Paste while the remote shell stops reading | App RSS at 0, 8, 16, 24, and 32 MiB acknowledged was 104.2, 135.7, 145.2, 136.5, and 151.8 MiB, respectively. After 5 s, app RSS was 129.1 MiB. |

| SFTP workload, five-call median | Plain OpenSSH | OpenSSH with 100 ms added RTT |
| --- | --- | --- |
| `stat` latency control | 3.0 ms | 111.7 ms |
| List 10,000 regular entries | 733.2 ms | 15,083.3 ms |
| List 1,000 regular entries | 75.5 ms | 1,882.4 ms |
| List 1,000 resolved symlinks | 55.7 ms | 3,613.6 ms |

| SFTP transfer | Plain OpenSSH | OpenSSH with 100 ms added RTT |
| --- | --- | --- |
| Upload 32 MiB | 14.99 s, 2.14 MiB/s | 19.00 s, 1.68 MiB/s |
| Download 32 MiB | 9.74 s, 3.29 MiB/s | 10.23 s, 3.13 MiB/s |
| Upload 1,000 × 1 KiB | 108.45 s, 9.22 KiB/s | 639.88 s, 1.56 KiB/s |
| Download 1,000 × 1 KiB | 25.24 s, 39.62 KiB/s | 489.04 s, 2.04 KiB/s |
