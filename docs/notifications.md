# Desktop notification checks

Use a packaged build in a test desktop session with the system's notifications enabled. Run the command for your shell, then switch to another app before the delay elapses.

```sh
sleep 3; printf '\033]9;SSH Astra notification check\007'
```

```powershell
Start-Sleep -Seconds 3; [Console]::Write("{0}]9;SSH Astra notification check{1}", [char]27, [char]7)
```

| Platform | Permission and delivery | Activation |
| --- | --- | --- |
| macOS | Run the packaged `.app` so the notification uses the SSH Astra bundle identity. On a fresh desktop, record how Notification Center handles the first request. The pinned plugin's permission API returns `Granted` without prompting, so a first-use permission prompt is controlled by macOS. Check **System Settings → Notifications** for SSH Astra. | Click the banner while SSH Astra is running. The app restores its window when Notification Center reports the click. |
| Windows | Use the installed app and allow desktop banners in Windows Settings. The pinned Tauri plugin provides delivery with the app identity and has no desktop permission prompt. | Click while the banner is on screen. The pinned plugin reports banner clicks during display. |
| Linux | Use a desktop session with an active freedesktop notification service. Notification permission is controlled by the desktop. | Click the banner on a server that reports the default action. The compositor controls whether window focus can be granted. |

Repeat with the window focused and with **Settings → Notifications → Terminal programs** switched off. Both should suppress the system notification. With the setting on again, print two OSC 9 requests in quick succession from the same Terminal to check the one-second limit. Try one from each of two split Terminals to check that each has its own limit.

Select two files to transfer and switch away while they copy. Expect a single summary for the request, then check the transfer results in the app. To check an unrecoverable Connection, open two Terminals on a test Host, stop its SSH service, and switch away until the automatic retries finish. Expect one failed-reconnection notification for that Connection.

To verify **Long-running commands** on each platform, enable **Shell integration** under Terminal settings and open a new remote Terminal using bash 4.4+ with prompt expansion enabled, or zsh. With the default 10-second threshold, run `sleep 12; false` and switch to another app. Expect a notification with the Host name, command, and exit code 1. Set the threshold to 5 seconds, then try `sleep 2` and `sleep 7` in the background. Only `sleep 7` should produce a notification. Repeat `sleep 7` while the app is focused and with the category switched off to verify suppression. If the shell omits the command text, the notification shows the Host name and exit code. With Shell integration off, the category description explains how to enable it again.

Platform references. [Tauri notification plugin 2.8.0 desktop source](https://github.com/tauri-apps/plugins-workspace/blob/notification-v2.8.0/plugins/notification/src/desktop.rs) · [freedesktop action signals](https://specifications.freedesktop.org/notification/latest/protocol.html)
