# Single-instance desktop checks

Use an installed build in a disposable desktop account or VM. Open a Local terminal and type a short marker without submitting it. Switch to another app and launch SSH Astra again. The original window should come forward with the same tab and input, and only the original SSH Astra process should remain. Repeat with the window minimized.

| Platform | Launch and observe |
| --- | --- |
| macOS | Open the app again from Finder or its Dock icon. Also hide it with Cmd+H and reopen it. Run the executable in `SSH Astra.app/Contents/MacOS` directly to exercise argument forwarding, since Finder can reopen the app without launching a process. Inspect the app process in Activity Monitor. |
| Windows | Open the app again from Start or the installed `sshastra.exe`. Inspect its PID in Task Manager. |
| Linux | Open the desktop launcher again or run `sshastra` in a desktop session with a D-Bus user session. Inspect the app PID with `pgrep -x sshastra`. The window manager controls foreground focus. |

Run the executable again with `--single-instance-check "argument with spaces"`. Expect the same window and no new tab or Terminal input. See [SSH link checks](ssh-links.md) for the one launch argument the app acts on. Finally, quit from the app menu, then launch it again and check that a new process starts normally.

Linux CI also verifies that a second launch exits and the original Terminal stays open in an isolated smoke-test desktop.
